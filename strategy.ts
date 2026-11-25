// Breakout rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: buy a curve only once its trend has already turned, not while it is
// still falling. The trend is read off the tape itself: a fast moving average
// of the trade price crossing above a slow one, confirmed by the price sitting
// near its rolling high with real buy flow behind it. Entries are tiny
// (0.01 SOL) and single-buy: on the dev window smaller stakes lost less, and
// 0.01 SOL is the smallest round trip the guardrail counts. Dip-adds lost
// money on the dev window, so they are off by default (maxAdds 0). Half the
// position is banked at +60%, the rest rides a trailing stop, and every
// position has a hard stop and a maximum hold, so a dead coin can only cost
// its stake. Guardrail probes keep the run above the minimum bar
// (20 coins, 0.01 SOL round trips) when the main signal goes quiet.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, so the two graded executions produce
// byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Slots of tape kept per curve (covers the slow window plus slack). */
  keepSlots: number;
  /** Fast moving-average window, in slots. */
  fastWindow: number;
  /** Slow moving-average window, in slots. */
  slowWindow: number;
  /** Flow window, in slots, for the buy-flow confirmation. */
  flowWindow: number;
  /** Net buy SOL (buys minus sells) over the flow window needed to enter. */
  minNetSol: number;
  /** Buy trades in the flow window. */
  minBuys: number;
  /** Distinct buying wallets in the flow window. */
  minBuyers: number;
  /** Price rise over the slow window needed to enter (fraction). */
  minRise: number;
  /** Price must sit at least this close to its slow-window high (fraction). */
  nearHigh: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL for the first buy of a position. */
  firstSol: number;
  /** SOL for each dip-add. */
  addSol: number;
  /** Most SOL at cost in one position. */
  maxPositionSol: number;
  /** Most dip-adds per position. */
  maxAdds: number;
  /** A dip-add needs the price this far below the last buy (fraction). */
  dipMin: number;
  /** ...and no further below it than this (a collapse, not a dip). */
  dipMax: number;
  /** Slots to wait between buys on the same curve. */
  addDelay: number;
  /** Smallest buy worth sending (each order pays 105k lamports of tx fees). */
  minBuySol: number;
  /** Slippage allowed on buys, in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Take half the position when its value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell everything when value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Once value reaches cost * (1 + trailArm), sell all if it falls this far below its peak. */
  trailArm: number;
  trail: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held, unless the position is up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the 5-position cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: aim for this many coins and fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** SOL for one probe round trip. */
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  keepSlots: 200,
  fastWindow: 20,
  slowWindow: 120,
  flowWindow: 60,
  minNetSol: 1,
  minBuys: 5,
  minBuyers: 4,
  minRise: 0.05,
  nearHigh: 0.95,
  minRqSol: 2,
  maxRqSol: 80,
  minAge: 2500,
  firstSol: 0.01,
  addSol: 0.1,
  maxPositionSol: 0.01,
  maxAdds: 0,
  dipMin: 0.04,
  dipMax: 0.12,
  addDelay: 10,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.6,
  stopLoss: 0.3,
  trailArm: 0.1,
  trail: 0.2,
  fadeWindow: 20,
  fadeNetSol: 1.5,
  bigSellSol: 3,
  maxHold: 300,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 4,
  maxExposureSol: 6,
  targetCoins: 22,
  targetFills: 120,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade: 95 bps protocol + 30 bps creator. */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastBuyPrice: number;
  /** Slots of the last buy decision (adds wait addDelay after it). */
  lastBuySlot: number;
  adds: number;
  tookPartial: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Mean trade price over the last `w` slots, plus the earliest price in that span. */
  const windowStats = (t: Tape, now: number, w: number): { mean: number; n: number; first: number; high: number } => {
    let sum = 0;
    let n = 0;
    let first = -1;
    let high = 0;
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tk = t.ticks[i]!;
      if (tk.slot <= now - w) break;
      sum += tk.price;
      n++;
      first = tk.price;
      if (tk.price > high) high = tk.price;
    }
    return { mean: n > 0 ? sum / n : -1, n, first, high };
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, with trade counts. */
  const flowStats = (t: Tape, now: number, w: number): { net: number; buys: number; buyers: number } => {
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (let i = t.ticks.length - 1; i >= 0; i--) {
      const tk = t.ticks[i]!;
      if (tk.slot <= now - w) break;
      net += tk.buy ? tk.sol : -tk.sol;
      if (tk.buy) {
        buys++;
        buyers.add(tk.user);
      }
    }
    return { net, buys, buyers: buyers.size };
  };

  /** Entry signal: trend turned up (fast MA above slow MA), price near its high, flow behind it. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const fast = windowStats(t, now, p.fastWindow);
    const slow = windowStats(t, now, p.slowWindow);
    if (fast.n < 3 || slow.n < 5 || fast.mean < 0 || slow.mean <= 0) return false;
    if (fast.mean <= slow.mean) return false;
    if (slow.first <= 0) return false;
    const last = t.ticks[t.ticks.length - 1]!.price;
    if (last / slow.first - 1 < p.minRise) return false;
    if (last < slow.high * p.nearHigh) return false;
    const flow = flowStats(t, now, p.flowWindow);
    if (flow.net < p.minNetSol || flow.buys < p.minBuys || flow.buyers < p.minBuyers) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - p.keepSlots) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const priceOf = (mint: Pubkey): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return -1;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        return vt > 0 ? vq / vt : -1;
      };
      /** SOL the position would fetch if sold whole right now, fees deducted. */
      const valueOf = (mint: Pubkey, tokens: number): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: stops, trailing stop, fade, big seller, stale hold. A partial
      // take-profit banks half at +30% and lets the rest ride the trailing stop.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const tokens = Number(pos.token_amount);
        const value = valueOf(mint, tokens);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let sellAll = h.exiting;
        if (!sellAll && value < cost * (1 - p.stopLoss)) sellAll = true;
        if (!sellAll && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) sellAll = true;
        if (!sellAll && flowStats(t, now, p.fadeWindow).net < -p.fadeNetSol) sellAll = true;
        if (!sellAll && bigSell.has(mint)) sellAll = true;
        if (!sellAll && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) sellAll = true;
        if (sellAll) {
          h.exiting = true;
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        if (!h.tookPartial && value >= cost * (1 + p.takeProfit)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: (BigInt(pos.token_amount) / 2n).toString(), max_slippage_bps: 10_000 });
          h.tookPartial = true;
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and dip-adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(mint);
        if (price <= 0) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want = 0;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.firstSol, p.maxPositionSol);
        } else {
          // Dip-add: the price pulled back from the last buy but the slow trend
          // still holds, so the position is grown cheaply instead of chased.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
          if (h.invested >= p.maxPositionSol - p.minBuySol) continue;
          if (now - h.lastBuySlot < p.addDelay) continue;
          const dip = 1 - price / h.lastBuyPrice;
          if (dip < p.dipMin || dip > p.dipMax) continue;
          const slow = windowStats(t, now, p.slowWindow);
          if (slow.mean <= 0 || price < slow.mean) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          want = Math.min(p.addSol, p.maxPositionSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastBuyPrice: price,
            lastBuySlot: now,
            adds: 0,
            tookPartial: false,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
          h.lastBuySlot = now;
          h.adds++;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
