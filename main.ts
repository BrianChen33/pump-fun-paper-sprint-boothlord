// Survivor Breakout — Pump.fun Paper Sprint (boothlord), v8.
// Lessons from dev data (grade-local + path simulator over the 24 h dev tape):
// - Momentum-chasing loses (house pilot momentum -9.45 SOL; our v1 -0.20, 22% win).
// - Fixed-age entry at 45-90 s with +15% run-up also loses (v3 -0.25, 27.6% win):
//   most early pumps dump before +25% is reached.
// - Later, stronger entries win: at 90-240 s, mints still +50% have survived the
//   first shakeout; first-passage odds improve (sim: 85 trades/24 h, 31% win,
//   +0.31 SOL at TP +40% / SL -10%, positive in 2 of 4 six-hour chunks, never
//   deeply negative). Flow gate (net inflow > 0, >=5 buyers, no creator dump)
//   adds value (ablation without it: -0.15). TP +40% beats +25%/+60%.
// - Single full exit (no tranches): winners peak then revert; leftovers give back.
// Reserves at 60 s are small (median 9 SOL), so size is reserve-bound: 0.15 target,
// 0.8% of real reserve, 0.012 minimum. Written fresh in this session.
// v5 note: grade-local v4 (-0.077, 23% win) vs sim (+0.31, 31% win) — the gap is
// entry drag: fills land ~3% above decision price (2-slot latency + curve impact),
// so SL/TP measured from the fill price are effectively tighter/further. v5 caps
// buy slippage at 200 bps (reject bad fills, retry while in window) and widens
// SL/TP to -13%/+43% to restore the sim's decision-price first-passage odds.
// v6 note: v5 action-log forensics — 78/90 buys were reserve-capped at 0.05 SOL
// (median reserve ~6 SOL) and won only 22% (avg -0.0035); the 10 buys at
// 0.10-0.15 SOL (reserve >= 12.5 SOL) won 50% (avg +0.0187). +50% run-up on a tiny
// reserve means small money moved the price a lot — those mints dump hardest.
// v6 raises the standard reserve floor to 15 SOL; pace fillers keep 6 SOL.
// v7 note: v6 confirmed the split (0.10-0.15 bucket: 7 trades, 57% win,
// avg +0.0223; <=0.06 bucket: 79 trades, 23% win, avg -0.0034) but pace fillers
// still dominate the count (79/86) and drag -0.27. The 20-mint bar needs the
// fillers, but they only need to EXIST (>=0.01 SOL buys count). v7 shrinks pace
// size to 0.015 SOL so the bar costs ~1/3 as much, and lowers the standard
// reserve floor to 12 SOL (v5's 0.10-0.15 bucket started at 12.5 SOL).
// v7 grade-local: +0.146 SOL, 89 round trips / 89 distinct mints, 25.8% win,
// max DD 1.19%, +0.058 at 2x fees. Stress (20 copies): median -0.117, 16/20 lost.
// v8 note: one GPT review round (FIX FIRST, no Critical). Fixes verified against
// the kit's vendored SDK and the shipped harness scorer (sim/engine.ts,
// sim/metrics.ts) — see ~/workspace/makefun/gpt-review-boothlord-review.md:
// - Qualification now mirrors the scorer exactly: a round trip counts iff its
//   buy fills total >= 0.01 SOL (guardrails.round_trips.min_buy_lamports) and
//   the position closed (own sell, _complete_, _flatten_ or _writeoff_ — exit
//   proceeds do not matter, a writeoff still counts). completedCount counts
//   only those; harness closes are folded from fills instead of ignored.
// - Sell fills are terminal (one fill per order in this harness): pendingSell
//   is cleared on every sell resolution, so a terminal partial fill cannot
//   strand tokens. Pending flags are reconciled against state.pending after
//   fills, so a stale buyPending/pendingSell cannot block later trades.
// - Exits: max-hold and stop-loss outrank take-profit (urgent slippage); a
//   position with missing metadata or no entry price is liquidated
//   defensively instead of skipped; completed curves are never sold by hand
//   (the harness closes them); a stale exit also fires when the prior flow
//   bucket is empty (zero flow = zero net inflow).
// - Pace fillers are exempt from the 50% drawdown size cut (they were being
//   shrunk below MIN_ENTRY at 10-20% DD, silently disabling qualification
//   mode); paceMode now keys on confirmed qualifying closures only.
// - Same-reply buys draw down a local cash budget (SDK freeCashLamports only
//   nets orders already pending).
// - Trade-only mints keep a provisional creation until a real CreateEvent
//   arrives, which then overwrites it; completion events leave tombstones.
// - Timing stays slot-based (calibrated): the dev window spans 403,213 slots
//   over 24h00m01s of wall time (0.2143 s/slot); the final window comes from
//   the same collector, so the slot rate should match.
// Strategy parameters unchanged (TP +43% / SL -13% from fill price, 0.15 /
// 0.015 SOL sizes, 12 / 6 SOL reserve floors, +50% / +10% run-ups).
// Deterministic: decisions derive from harness messages and slot numbers only.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const WIN = 70; // ~15 s per flow window, in slots (0.2143 s/slot on dev window)
const OBS_MIN = 420; // 90 s after creation
const OBS_MAX = 1120; // 240 s after creation
const STALE_SLOTS = 420; // 90 s without progress -> exit
const MAX_HOLD_SLOTS = 2800; // 10 min
const SIX_HOURS_SLOTS = 100800; // ~6 h in slots

const SIZE_TARGET = (SOL * 15n) / 100n; // 0.15 SOL
const SIZE_PACE = (SOL * 15n) / 1000n; // 0.015 SOL qualification filler (bar needs >=0.01)
const MIN_ENTRY = (SOL * 12n) / 1000n; // 0.012 SOL minimum
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: scorer round-trip bar
const EXPOSURE_CAP = (SOL * 240n) / 100n; // 2.40 SOL committed max
const RESERVE_FLOOR = SOL * 12n; // 12 SOL real reserve minimum (see header note)
const PACE_RESERVE_FLOOR = SOL * 6n; // pace fillers only need 6 SOL
const TARGET_MINTS_6H = 30;
const CASH_BUFFER = 210000n; // lamports of cash to leave untouched per reply

const SL_PCT = 0.87; // -13% stop: full exit (see header note on entry drag)
const TP_PCT = 1.43; // +43%: full exit

interface Bucket {
  buy: bigint;
  sell: bigint;
  buyers: Set<string>;
  creatorSell: bigint;
}

interface MintStat {
  mint: string;
  creator: string | null;
  createdSlot: number;
  createPrice: number;
  price: number;
  high: number;
  complete: boolean;
  hasCreateEvent: boolean;
  buckets: Map<number, Bucket>;
  entered: boolean;
  buyPending: boolean;
  completed: boolean;
  qualified: boolean;
  entryPrice: number;
  entryTokens: bigint;
  entryQuote: bigint;
  exitQuote: bigint;
  entrySlot: number;
  pendingSell: bigint;
}

const mints = new Map<string, MintStat>();
const completedMints = new Set<string>();
const activeEntered = new Set<string>();
const myOrders = new Map<string, { mint: string; side: 'buy' | 'sell' }>();
let orderSeq = 0;
let firstSlot = -1;
let completedCount = 0;
let peakEquity = 10; // SOL, starting capital

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function bucketFor(m: MintStat, slot: number): Bucket {
  const idx = Math.floor(slot / WIN);
  let b = m.buckets.get(idx);
  if (b === undefined) {
    b = { buy: 0n, sell: 0n, buyers: new Set<string>(), creatorSell: 0n };
    m.buckets.set(idx, b);
    for (const k of [...m.buckets.keys()]) {
      if (k < idx - 4) m.buckets.delete(k);
    }
  }
  return b;
}

function newMint(mint: string, slot: number, creator: string | null, price: number): MintStat {
  const m: MintStat = {
    mint,
    creator,
    createdSlot: slot,
    createPrice: price > 0 ? price : 0,
    price,
    high: price,
    complete: false,
    hasCreateEvent: false,
    buckets: new Map(),
    entered: false,
    buyPending: false,
    completed: false,
    qualified: false,
    entryPrice: 0,
    entryTokens: 0n,
    entryQuote: 0n,
    exitQuote: 0n,
    entrySlot: 0,
    pendingSell: 0n,
  };
  mints.set(mint, m);
  return m;
}

function toSol(l: bigint): number {
  return Number(l) / 1e9;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    const orders: OrderInput[] = [];

    // ---- 1. Fold fills: confirm entries, clear pending sells, count completions.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (_complete_ / _flatten_ / _writeoff_): the house closed
        // the position terminally. Record proceeds, clear reservations, mark
        // the curve terminal. (Writeoff proceeds are "0" but the round trip
        // still counts for the scorer when the buy was >= 0.01 SOL.)
        const m = mints.get(f.mint);
        if (m !== undefined) {
          m.complete = true;
          completedMints.add(f.mint);
          m.pendingSell = 0n;
          if (f.status === 'filled') m.exitQuote += BigInt(f.quote_lamports);
        }
        continue;
      }
      const mine = myOrders.get(f.client_id);
      if (mine === undefined) continue;
      myOrders.delete(f.client_id);
      const m = mints.get(mine.mint);
      if (m === undefined) continue;
      if (mine.side === 'buy') {
        m.buyPending = false;
        if (f.status === 'filled') {
          const tokens = BigInt(f.token_amount);
          const quote = BigInt(f.quote_lamports);
          if (tokens > 0n && quote > 0n) {
            m.entered = true;
            m.entryPrice = Number(quote) / Number(tokens);
            m.entryTokens = tokens;
            m.entryQuote = quote;
            m.entrySlot = f.slot;
            m.pendingSell = 0n;
            activeEntered.add(m.mint);
          }
        }
        // Rejected/failed buy: entered stays false, so the mint can be retried
        // while still inside the entry window.
      } else if (mine.side === 'sell') {
        // One fill per order in this harness: every sell resolution is
        // terminal, so clear the whole reservation — a terminal partial fill
        // must not strand the unsold remainder.
        if (f.status === 'filled') m.exitQuote += BigInt(f.quote_lamports);
        m.pendingSell = 0n;
      }
    }
    // Reconcile pending flags against the harness's post-fill pending
    // snapshot: an order gone from state.pending with no fill processed is
    // stale — drop it so it cannot block later trades.
    for (const [id, rec] of [...myOrders]) {
      if (state.pending.has(id)) continue;
      myOrders.delete(id);
      const m = mints.get(rec.mint);
      if (m === undefined) continue;
      if (rec.side === 'buy') m.buyPending = false;
      else m.pendingSell = 0n;
    }
    // Scorer-equivalent qualification: a closed round trip whose buy fills
    // totalled >= 0.01 SOL. Position disappearance is the closure signal
    // (the engine deletes the position exactly when its tokens hit zero,
    // including harness closes). Only entered mints are tracked, so the
    // scan stays O(open positions).
    for (const mint of [...activeEntered]) {
      if (state.positions.has(mint)) continue;
      activeEntered.delete(mint);
      const m = mints.get(mint);
      if (m === undefined) continue;
      m.completed = true;
      if (!m.qualified && m.entryQuote >= MIN_BUY_LAMPORTS) {
        m.qualified = true;
        completedCount++;
      }
    }

    // ---- 2. Fold events into per-mint stats; collect mints with trades this batch.
    const traded = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let m = mints.get(e.mint);
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (m === undefined) {
          m = newMint(e.mint, e.slot, e.creator, p);
          m.hasCreateEvent = true;
        } else if (!m.hasCreateEvent) {
          // Provisional trade-only record: a real creation overwrites it.
          m.hasCreateEvent = true;
          m.creator = e.creator;
          m.createdSlot = e.slot;
          if (p > 0) m.createPrice = p;
        }
        if (p > 0) {
          m.price = p;
          if (p > m.high) m.high = p;
        }
      } else if (e.event === 'TradeEvent') {
        let m = mints.get(e.mint);
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (m === undefined) {
          m = newMint(e.mint, e.slot, null, p);
        }
        if (p > 0) {
          m.price = p;
          if (p > m.high) m.high = p;
        }
        const b = bucketFor(m, e.slot);
        const amt = BigInt(e.sol_amount);
        if (e.is_buy) {
          b.buy += amt;
          if (m.creator === null || e.user !== m.creator) b.buyers.add(e.user);
        } else {
          b.sell += amt;
          if (m.creator !== null && e.user === m.creator) b.creatorSell += amt;
        }
        traded.add(e.mint);
      } else if (e.event === 'CompleteEvent') {
        completedMints.add(e.mint);
        const m = mints.get(e.mint);
        if (m !== undefined) m.complete = true;
      }
    }

    // ---- 3. Equity / drawdown governor (approximate internal mark-to-market:
    // marginal curve price, not liquidation proceeds — an entry-stop gauge,
    // not scorer-equivalent equity).
    let equity = toSol(BigInt(state.account.cash_lamports));
    for (const [mint, pos] of state.positions) {
      const c = state.curves.get(mint);
      if (c === undefined) continue;
      const p = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      equity += (Number(BigInt(pos.token_amount)) * p) / 1e9;
    }
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;

    // ---- 4. Exits first (sells before buys). TP/SL are fill-price-relative
    // market-price triggers (+43% / -13%), not guaranteed realized returns.
    // The 20% drawdown governor below is an entry stop only: existing
    // positions still follow their normal exits.
    for (const [mint, pos] of state.positions) {
      const tokens = BigInt(pos.token_amount);
      const m = mints.get(mint);
      // No metadata at all: we hold tokens we cannot price — liquidate
      // defensively rather than ignore the position.
      if (m === undefined) {
        if (tokens <= 0n) continue;
        const id = `s${++orderSeq}`;
        myOrders.set(id, { mint, side: 'sell' });
        orders.push({
          side: 'sell',
          client_id: id,
          mint,
          token_amount: tokens,
          max_slippage_bps: 10000,
        });
        continue;
      }
      // Completed curves are closed by the harness (a hand sell would be
      // rejected token_complete) — never sell one by hand.
      if (m.complete) continue;
      const free = tokens - m.pendingSell;
      if (free <= 0n) continue;
      const age = slot - m.entrySlot;
      let sell = false;
      let urgent = false; // crash / forced exit: accept any price so it executes
      // Mandatory exits first: max-hold, then stop-loss, then take-profit.
      if (m.entryPrice <= 0 || age >= MAX_HOLD_SLOTS) {
        sell = true;
        urgent = true;
      } else {
        const c = state.curves.get(mint);
        if (c === undefined) continue; // no curve snapshot: only a mandatory exit can be attempted
        const price = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
        if (price <= 0) continue;
        if (price <= m.entryPrice * SL_PCT) {
          sell = true;
          urgent = true;
        } else if (price >= m.entryPrice * TP_PCT) {
          sell = true;
        } else if (age >= STALE_SLOTS && price < m.entryPrice) {
          const cur = Math.floor(slot / WIN);
          const b1 = m.buckets.get(cur - 1);
          // An empty prior bucket is zero flow, i.e. zero net inflow.
          const net = b1 === undefined ? 0n : b1.buy - b1.sell;
          if (net <= 0n) {
            sell = true;
            urgent = true;
          }
        }
      }
      if (!sell) continue;
      const id = `s${++orderSeq}`;
      myOrders.set(id, { mint, side: 'sell' });
      m.pendingSell += free;
      orders.push({
        side: 'sell',
        client_id: id,
        mint,
        token_amount: free,
        max_slippage_bps: urgent ? 10000 : 1000,
      });
    }

    // ---- 5. Entries: fixed young age, traction shown, no top-chasing.
    const elapsed = slot - firstSlot;
    const expected = Math.floor((elapsed / SIX_HOURS_SLOTS) * TARGET_MINTS_6H);
    const committedPositions = state.committedPositionCount();
    const paceMode =
      completedCount < expected - 2 ||
      (elapsed >= (SIX_HOURS_SLOTS * 3) / 4 && completedCount < 20);
    const sizeMult = dd >= 0.2 ? 0 : dd >= 0.1 ? 0.5 : 1;

    let committedLamports = 0n;
    for (const [, pos] of state.positions) committedLamports += BigInt(pos.cost_lamports);
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') committedLamports += BigInt(p.order.quote_lamports);
    }
    // Same-reply buys draw down a local cash budget: freeCashLamports only
    // nets orders already pending, not the ones queued in this reply.
    let availableCash = state.freeCashLamports();
    let plannedPositions = committedPositions;

    if (sizeMult > 0 && committedPositions < 5 && orders.length < 16) {
      for (const mint of traded) {
        if (orders.length >= 16) break;
        if (plannedPositions >= 5) break;
        const m = mints.get(mint);
        const c = state.curves.get(mint);
        if (m === undefined || c === undefined) continue;
        if (m.entered || m.buyPending || m.complete || completedMints.has(mint)) continue;
        const age = slot - m.createdSlot;
        if (age < OBS_MIN || age > OBS_MAX) continue;
        if (m.createPrice <= 0) continue;
        const price = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
        if (price <= 0) continue;
        const realReserve = c.real_quote_reserves;
        if (realReserve < (paceMode ? PACE_RESERVE_FLOOR : RESERVE_FLOOR)) continue;
        const runUp = price / m.createPrice - 1;
        const cur = Math.floor(slot / WIN);
        const b1 = m.buckets.get(cur - 1);
        const b2 = m.buckets.get(cur - 2);
        if (b1 === undefined || b2 === undefined) continue;
        const buyers = new Set<string>();
        for (const u of b1.buyers) buyers.add(u);
        for (const u of b2.buyers) buyers.add(u);
        const net = b1.buy + b2.buy - (b1.sell + b2.sell);
        const creatorSell = b1.creatorSell + b2.creatorSell;
        const creatorDump = toSol(creatorSell) >= 0.2 && price < m.high * 0.95;

        let target: bigint | null = null;
        if (paceMode) {
          if (buyers.size >= 5 && net > 0n && runUp >= 0.1 && !creatorDump) target = SIZE_PACE;
        } else if (
          buyers.size >= 5 &&
          net > 0n &&
          runUp >= 0.5 &&
          !creatorDump
        ) {
          target = SIZE_TARGET;
        }
        if (target === null) continue;
        if (dd >= 0.15 && target > SIZE_PACE) continue; // defensive: pace only

        // Qualification fillers are exempt from the 50% drawdown cut: at
        // 10-20% DD the cut would shrink them below MIN_ENTRY and silently
        // disable qualification mode. The sizeMult > 0 guard above still
        // stops all entries at 20% DD.
        const sized = target === SIZE_PACE ? SIZE_PACE : (target * BigInt(Math.round(sizeMult * 100))) / 100n;
        const reserveCap = (realReserve * 8n) / 1000n; // 0.8% of real reserve
        const exposureRoom = EXPOSURE_CAP - committedLamports;
        let size = sized;
        if (size > reserveCap) size = reserveCap;
        if (size > exposureRoom) size = exposureRoom;
        if (size > availableCash - CASH_BUFFER) size = availableCash - CASH_BUFFER;
        if (size < MIN_ENTRY) continue;
        const id = `b${++orderSeq}`;
        myOrders.set(id, { mint, side: 'buy' });
        committedLamports += size;
        availableCash -= size + state.txFeeLamports();
        plannedPositions++;
        m.buyPending = true;
        orders.push({
          side: 'buy',
          client_id: id,
          mint,
          quote_lamports: size,
          max_slippage_bps: 200,
        });
      }
    }

    return orders;
  },
});
