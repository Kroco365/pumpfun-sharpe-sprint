// DipBounce — a second-leg pump.fun paper trader.
//
// Why this shape (measured on the kit's 24 h dev window, 1,222 coins):
// a fresh pump.fun coin pumps in its first few slots and then bleeds back —
// the median coin is +29% within ~2 minutes of creation and back near its
// create price by the end. Buying the first pump is buying the top: the
// 2-slot fill latency plus the 1%-of-real-reserve size cap mean an entry
// decided at +5% fills near +35%, after which the coin usually retraces
// 20%+ before it ever prints another high. So this bot does not chase the
// first pump at all. It waits for the pump-and-dip cycle to finish and buys
// the recovery instead: the coin must first fall 15% off its running peak
// since creation, then climb 5% off that dip low on fresh buying (at least
// 2 of its last 3 trades buys, and buy SOL at least 3x sell SOL over its
// last 10 trades — real demand, not a dead-cat bounce on one print),
// with enough real SOL reserve that the size cap allows a real round
// trip. One entry per coin, 0.02 SOL, at most 5 open. It exits on a
// fixed +40% take-profit, a -12% stop-loss, a creator sell, or after
// 1,200 slots (~8 min) — whichever comes first — so every round trip
// closes fast and no single coin can dominate the result.
// That is the Sharpe shape: many small, diversified, quick round trips
// with tight exits, not a moonshot sniper.
//
// Money rules, all exact BigInt: prices are compared as ratios of virtual
// reserves (virtual quote / virtual token), never as floats. The entry
// reference price is the filled buy itself (SOL spent / tokens received),
// so take-profit and stop-loss are measured from what was actually paid.
// No clock, no randomness, no network, no file reads: the two grading
// executions see the same batches and must produce byte-identical logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// --- tuning (swept on the dev window; see README) ---
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail floor
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never refuse a fill on price move

const DIP_BPS = 1500; // fall 15% off the peak since creation
const RECOVERY_BPS = 500; // then recover 5% off the dip low
const FLOW_WINDOW = 10; // last 10 trades on the coin
const BUY_DOMINANCE = 3n; // buy SOL in that window >= 3x sell SOL: real demand,
// not a dead-cat bounce on one print
const TAKE_PROFIT_BPS = 4000; // +40% over the filled entry price
const STOP_LOSS_BPS = 1200; // -12% under the filled entry price
const MAX_HOLD_SLOTS = 1200; // ~8 minutes, then flatten
const DIP_WINDOW_SLOTS = 1800; // only hunt the first cycle (~12 min after create)
const DIP_STALE_SLOTS = 1200; // a dip low older than this stops signalling
const RECENT_WINDOW = 3; // last 3 trades on the coin
const RECENT_MIN_BUYS = 2; // at least 2 of them buys

/** True when price vq/vt is at least ref rq/rt scaled by num/den. */
function priceGte(
  vq: bigint,
  vt: bigint,
  rq: bigint,
  rt: bigint,
  num: bigint,
  den: bigint,
): boolean {
  // vq/vt >= (rq/rt) * (num/den)  <=>  vq * rt * den >= rq * vt * num
  return vq * rt * den >= rq * vt * num;
}

/** True when price vq/vt is at most ref rq/rt scaled by num/den. */
function priceLte(
  vq: bigint,
  vt: bigint,
  rq: bigint,
  rt: bigint,
  num: bigint,
  den: bigint,
): boolean {
  // vq/vt <= (rq/rt) * (num/den)  <=>  vq * rt * den <= rq * vt * num
  return vq * rt * den <= rq * vt * num;
}

interface Coin {
  mint: string;
  creator: string;
  createSlot: number;
  /** Running peak price since creation, as virtual quote / virtual token. */
  peakVq: bigint;
  peakVt: bigint;
  /** Lowest price since the dip began, as virtual quote / virtual token. */
  dipVq: bigint;
  dipVt: bigint;
  dipSlot: number;
  hasDip: boolean;
  creatorSold: boolean;
  complete: boolean;
  /** A buy fill landed: never enter this coin again. */
  bought: boolean;
  /** A buy is queued or in flight: do not send another. */
  buySent: boolean;
  /** Buy flags of the last few trades, oldest first. */
  recentBuys: boolean[];
  /** Rolling last-FLOW_WINDOW trades, oldest first: [isBuy, sol lamports]. */
  flow: Array<[boolean, bigint]>;
  /** SOL bought / sold in that window, lamports. */
  flowBuy: bigint;
  flowSell: bigint;
  /** Filled entry reference: SOL spent / tokens received. */
  entryQuote: bigint;
  entryTokens: bigint;
  entrySlot: number;
  hasEntry: boolean;
}

const coins = new Map<string, Coin>();

function newCoin(
  mint: string,
  creator: string,
  slot: number,
  vq: bigint,
  vt: bigint,
): Coin {
  const c: Coin = {
    mint,
    creator,
    createSlot: slot,
    peakVq: vq,
    peakVt: vt,
    dipVq: 0n,
    dipVt: 1n,
    dipSlot: 0,
    hasDip: false,
    creatorSold: false,
    complete: false,
    bought: false,
    buySent: false,
    recentBuys: [],
    flow: [],
    flowBuy: 0n,
    flowSell: 0n,
    entryQuote: 0n,
    entryTokens: 0n,
    entrySlot: 0,
    hasEntry: false,
  };
  coins.set(mint, c);
  return c;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    const maxOpen = state.hello.caps.max_open_positions;
    const maxOrders = state.hello.caps.max_orders_per_batch;
    let free = state.freeCashLamports();
    let buysQueued = 0;

    // Mints with a sell already in flight: do not sell twice.
    const selling = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "sell") selling.add(p.order.mint);
    }

    // 1. Fills first: learn each filled buy's true entry price, and release
    // buys that were rejected or failed so the coin can be tried again.
    for (const f of batch.fills) {
      const c = coins.get(f.mint);
      if (c === undefined) continue;
      if (f.side === "buy") {
        if (f.status === "filled") {
          c.hasEntry = true;
          c.entryQuote = BigInt(f.quote_lamports);
          c.entryTokens = BigInt(f.token_amount);
          c.entrySlot = f.slot;
          c.bought = true;
          c.buySent = false;
        } else {
          c.buySent = false;
        }
      } else if (f.side === "sell" && f.status === "filled") {
        c.hasEntry = false;
        c.entryQuote = 0n;
        c.entryTokens = 0n;
      }
    }

    // 2. Walk the batch's events in chain order. Every trade updates its
    // coin's peak / dip / recent-flow state; a held coin is checked for an
    // exit against that trade's own price, and a fresh coin is checked for
    // the dip-recovery entry.
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        if (!coins.has(e.mint)) {
          newCoin(
            e.mint,
            e.creator,
            e.slot,
            BigInt(e.virtual_quote_reserves),
            BigInt(e.virtual_token_reserves),
          );
        }
        continue;
      }
      if (e.event === "CompleteEvent") {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
        continue;
      }
      // TradeEvent.
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      if (vt === 0n) continue;
      if (e.user === c.creator && !e.is_buy) c.creatorSold = true;

      // Running peak since creation.
      if (vq * c.peakVt > c.peakVq * vt) {
        c.peakVq = vq;
        c.peakVt = vt;
      }
      // Dip: 15% below the running peak. Once a dip exists, track its low;
      // a dip low older than DIP_STALE_SLOTS stops signalling.
      if (!c.hasDip) {
        if (
          priceLte(vq, vt, c.peakVq, c.peakVt, 10000n - BigInt(DIP_BPS), 10000n)
        ) {
          c.hasDip = true;
          c.dipVq = vq;
          c.dipVt = vt;
          c.dipSlot = e.slot;
        }
      } else {
        if (vq * c.dipVt < c.dipVq * vt) {
          c.dipVq = vq;
          c.dipVt = vt;
        }
        if (e.slot - c.dipSlot > DIP_STALE_SLOTS) c.hasDip = false;
      }
      c.recentBuys.push(e.is_buy);
      if (c.recentBuys.length > RECENT_WINDOW) c.recentBuys.shift();
      const solAmount = BigInt(e.sol_amount);
      c.flow.push([e.is_buy, solAmount]);
      if (e.is_buy) c.flowBuy += solAmount;
      else c.flowSell += solAmount;
      if (c.flow.length > FLOW_WINDOW) {
        const old = c.flow.shift();
        if (old !== undefined) {
          if (old[0]) c.flowBuy -= old[1];
          else c.flowSell -= old[1];
        }
      }

      // Exit a held coin against this trade's price.
      const pos = state.positions.get(e.mint);
      if (c.hasEntry && pos !== undefined && !selling.has(e.mint)) {
        const hitTp = priceGte(
          vq,
          vt,
          c.entryQuote,
          c.entryTokens,
          10000n + BigInt(TAKE_PROFIT_BPS),
          10000n,
        );
        const hitSl = priceLte(
          vq,
          vt,
          c.entryQuote,
          c.entryTokens,
          10000n - BigInt(STOP_LOSS_BPS),
          10000n,
        );
        if (hitTp || hitSl || c.creatorSold) {
          if (orders.length < maxOrders) {
            orders.push({
              side: "sell",
              mint: e.mint,
              token_amount: pos.token_amount,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            selling.add(e.mint);
          }
        }
        continue;
      }

      // Entry: dip, recovery, fresh buying, size cap, room, cash.
      if (c.bought || c.buySent || c.complete) continue;
      if (e.slot - c.createSlot > DIP_WINDOW_SLOTS) continue;
      if (!c.hasDip) continue;
      if (
        !priceGte(
          vq,
          vt,
          c.dipVq,
          c.dipVt,
          10000n + BigInt(RECOVERY_BPS),
          10000n,
        )
      ) {
        continue;
      }
      let buys = 0;
      for (const b of c.recentBuys) if (b) buys += 1;
      if (buys < RECENT_MIN_BUYS) continue;
      // The recovery must be real demand, not one buy print in a sell
      // flow: buy SOL over the last FLOW_WINDOW trades at least 3x sell SOL.
      const sellFloor = c.flowSell < 1_000_000n ? 1_000_000n : c.flowSell;
      if (c.flowBuy < BUY_DOMINANCE * sellFloor) continue;
      // Size gate on THIS trade's own real reserve, not the end-of-batch
      // one: a busy slot can lift the end-of-batch reserve far past the
      // price that triggered the entry, and buying on that stale trigger
      // is buying a pump that already ran. The trigger trade itself must
      // already allow a full 0.01 SOL round trip (real reserve >= 1 SOL).
      const triggerCap = BigInt(e.real_sol_reserves) / 100n;
      if (triggerCap < MIN_BUY_LAMPORTS) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      if (state.committedPositionCount() + buysQueued >= maxOpen) continue;
      if (orders.length >= maxOrders) continue;
      const stake = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
      if (free < stake + tx) continue;
      orders.push({
        side: "buy",
        mint: e.mint,
        quote_lamports: stake,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      c.buySent = true;
      buysQueued += 1;
      free -= stake + tx;
    }

    // 3. Time exit: flatten anything held past MAX_HOLD_SLOTS.
    for (const [mint, pos] of state.positions) {
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined || !c.hasEntry) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (batch.slot - c.entrySlot < MAX_HOLD_SLOTS) continue;
      if (orders.length >= maxOrders) break;
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      selling.add(mint);
    }

    return orders;
  },
});
