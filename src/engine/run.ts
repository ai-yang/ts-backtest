import { performance } from 'node:perf_hooks';
import { Decimal } from '../spec/decimal.js';
import { assertThat, BacktestError } from '../spec/errors.js';
import { contentHash } from '../spec/canonical.js';
import { parseSpec } from '../spec/validate.js';
import { priceFromTicks, ticksFromPrice } from '../data/normalize.js';
import { Ledger } from '../accounting/ledger.js';
import { calculateMetrics } from '../analytics/metrics.js';
import { StrategyEvaluator } from '../strategy/evaluator.js';
import type { Action, BacktestResult, BacktestSpec, BarSeries, Dataset, DecisionTrace, Diagnostic, Expression, Order, RunHooks } from '../spec/types.js';
import { EventClock, type ClockEvent } from './clock.js';

export const ENGINE_VERSION = '0.1.0';
const live = (o: Order) => o.status === 'accepted' || o.status === 'partial';
function lowerBound(values: ArrayLike<number>, value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (values[m]! < value) lo = m + 1; else hi = m; }
  return lo;
}

function validateLinked(dataset: Dataset, spec: BacktestSpec): void {
  assertThat(spec.account.currency === dataset.metadata.currency, 'CURRENCY_MISMATCH', 'Account and dataset currencies must match');
  assertThat(!spec.datasetId || spec.datasetId === dataset.id, 'DATASET_MISMATCH', 'Specification references a different dataset');
  assertThat(dataset.rowCount <= spec.limits.maxBars, 'BAR_LIMIT', 'Dataset exceeds the bar budget');
  let available = false;
  for (const s of dataset.series.values()) {
    const i = lowerBound(s.closeTime, spec.start);
    if (i < s.closeTime.length && s.closeTime[i]! < spec.end) available = true;
  }
  assertThat(available, 'EMPTY_RANGE', 'Evaluation range contains no completed bars');
  const symbol = (s: string) => assertThat(dataset.series.has(s), 'UNKNOWN_INSTRUMENT', `Unknown instrument ${s}`);
  if (spec.analytics.benchmarkSymbol) symbol(spec.analytics.benchmarkSymbol);
  if (spec.strategy.kind === 'targets') {
    for (const point of spec.strategy.schedule) {
      Object.keys(point.weights ?? point.quantities ?? {}).forEach(symbol);
      assertThat([...dataset.series.values()].some(s => s.closeTime[lowerBound(s.closeTime, point.at)] === point.at), 'INVALID_TARGET_TIME', 'A target must be scheduled at a completed-bar timestamp');
    }
  }
  if (spec.strategy.kind === 'replay') for (const fill of spec.strategy.fills) symbol(fill.symbol);
  if (spec.strategy.kind === 'rules') for (const rule of spec.strategy.rules) rule.symbols?.forEach(symbol);
  const features = new Set(dataset.features.map(f => f.name));
  function expression(e: Expression): void {
    if ('feature' in e) assertThat(features.has(e.feature), 'MISSING_FEATURE', `No feature data supplied for ${e.feature}`);
    if ('op' in e) e.args.forEach(expression);
  }
  if ('nodes' in spec.strategy) Object.values(spec.strategy.nodes).forEach(expression);
  if (spec.strategy.kind === 'rules') spec.strategy.rules.forEach(r => expression(r.when));
  if (spec.strategy.kind === 'rank') { expression(spec.strategy.score); if (spec.strategy.filter) expression(spec.strategy.filter); }
}

interface PendingMeta { session: number; firstBar?: number; intent?: 'target' | 'risk'; triggered?: boolean }
interface Candidate { order: Order; s: BarSeries; index: number; price: string; maxQuantity: number; phase: 'open' | 'intrabar' }

/** Shared linked-data preflight used by every adapter. */
export function validateBacktest(dataset: Dataset, specification: unknown): BacktestSpec {
  const spec = parseSpec(specification);
  validateLinked(dataset, spec);
  return spec;
}

/** Deterministic cash-long event engine. No I/O or dynamically executed source. */
export function runBacktest(dataset: Dataset, specification: unknown, hooks: RunHooks = {}): BacktestResult {
  const started = performance.now();
  const spec = validateBacktest(dataset, specification);
  const ledger = new Ledger(spec, dataset, hooks);
  const compiledAt = performance.now();
  const evaluator = new StrategyEvaluator(dataset, spec);
  let indicatorMs = performance.now() - compiledAt;
  const orders: Order[] = [];
  const trace: DecisionTrace[] = [];
  let historyRows = 0;
  function transition(order: Order, status: Order['status'], at: number, reason?: string): void {
    if (order.status === status && order.reason === reason && order.history?.length) return;
    order.status = status; if (reason === undefined) delete order.reason; else order.reason = reason;
    (order.history ??= []).push({ at, status, remaining: order.remaining, ...(reason ? { reason } : {}) });
    historyRows++;
  }
  let pending: Order[] = [];
  const meta = new Map<string, PendingMeta>();
  const warnings: Diagnostic[] = [...dataset.warnings];
  const warningCodes = new Map<string, Diagnostic>();
  const warn = (code: string, message: string) => {
    const warning = warningCodes.get(code);
    if (warning) warning.count = (warning.count ?? 1) + 1;
    else { const next = { code, message, count: 1 }; warnings.push(next); warningCodes.set(code, next); }
  };
  const current = new Map<string, number>();
  const delisted = new Set<string>();
  const clock = new EventClock();
  const calendar = dataset.metadata.sessions;
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: dataset.metadata.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  function sessionAt(at: number): number {
    const parts = localDate.formatToParts(at);
    const day = ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-');
    let lo = 0, hi = calendar.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (calendar[m]! <= day) lo = m + 1; else hi = m; }
    assertThat(lo > 0, 'UNKNOWN_SESSION', 'Event precedes the supplied trading calendar');
    return lo - 1;
  }
  let lastSession = sessionAt(spec.start);
  let state = spec.seed || 0x9e3779b9;
  function random(): number { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; }
  for (const [symbol, s] of dataset.series) {
    clock.push({ at: s.openTime[0]!, kind: 'open', symbol, index: 0 });
    clock.push({ at: s.closeTime[0]!, kind: 'close', symbol, index: 0 });
  }
  dataset.actions.forEach((action, index) => {
    if (action.at >= spec.start && action.at < spec.end) {
      clock.push({ at: action.at, kind: 'action', index });
      if (action.type === 'dividend' && action.payAt < spec.end) clock.push({ at: action.payAt, kind: 'pay', index });
    }
  });
  spec.account.cashFlows.forEach((flow, index) => clock.push({ at: flow.at, kind: 'flow', index }));
  if (spec.strategy.kind === 'replay') spec.strategy.fills.forEach((fill, index) => clock.push({ at: fill.at, kind: 'replay', index }));

  function newOrder(symbol: string, side: 'buy' | 'sell', quantity: number, at: number, session: number, source: string, action?: Action, intent?: 'target' | 'risk'): Order | undefined {
    assertThat(orders.length < spec.limits.maxOrders, 'ORDER_LIMIT', 'Order budget exceeded');
    const s = dataset.series.get(symbol)!;
    assertThat(s && Number.isSafeInteger(quantity) && quantity >= 0, 'INVALID_QUANTITY', 'Order quantity must be a nonnegative safe integer');
    const step = s.instrument.lotSize;
    const initial = quantity;
    if (side === 'buy' || !s.instrument.allowOddLotSell || quantity !== ledger.position(symbol)) quantity = Math.floor(quantity / step) * step;
    if (quantity !== initial) warn('LOT_ROUNDING', 'Requested order quantities were rounded down to trade lots');
    if (!quantity) return undefined;
    const order: Order = { id: `o${orders.length + 1}`, symbol, side, type: action?.orderType ?? 'market', quantity, remaining: quantity, submittedAt: at, price: action?.price,
      tif: action?.tif ?? 'gtc', tag: action?.tag, status: 'accepted', cumulativeNotional: '0', commissionAccruedRaw: '0', commissionPaid: '0', source };
    transition(order, 'accepted', at);
    if (delisted.has(symbol)) transition(order, 'rejected', at, 'DELISTED');
    if (side === 'buy' && !evaluator.isMember(symbol)) transition(order, 'rejected', at, 'OUTSIDE_UNIVERSE');
    const reserved = pending.filter(o => live(o) && o.symbol === symbol && o.side === 'sell').reduce((sum, o) => sum + o.remaining, 0);
    if (side === 'sell' && quantity > ledger.position(symbol) - reserved) transition(order, 'rejected', at, 'INSUFFICIENT_UNRESERVED_POSITION');
    if (order.price !== undefined) ticksFromPrice(order.price, s.instrument.tickSize);
    orders.push(order); meta.set(order.id, { session, intent });
    if (live(order)) pending.push(order);
    return order;
  }

  function cancelTargets(symbol: string, at: number): void {
    for (const o of pending) if (o.symbol === symbol && meta.get(o.id)?.intent === 'target' && live(o)) transition(o, 'canceled', at, 'REPLACED_TARGET');
  }
  function target(symbol: string, quantity: number, at: number, session: number, source: string): void {
    const outstanding = pending.filter(o => live(o) && o.symbol === symbol && meta.get(o.id)?.intent === 'target')
      .reduce((sum, o) => sum + (o.side === 'buy' ? o.remaining : -o.remaining), 0);
    if (quantity === ledger.position(symbol) + outstanding) return;
    cancelTargets(symbol, at);
    const difference = quantity - ledger.position(symbol);
    if (difference) newOrder(symbol, difference > 0 ? 'buy' : 'sell', Math.abs(difference), at, session, source, undefined, 'target');
  }
  function targets(weights: Record<string, number> | undefined, quantities: Record<string, number> | undefined, at: number, session: number, source: string): void {
    const equity = ledger.equityExact();
    for (const symbol of [...dataset.series.keys()].sort()) {
      let quantity = quantities && Object.hasOwn(quantities, symbol) ? quantities[symbol]! : 0;
      if (weights) {
        const weight = Object.hasOwn(weights, symbol) ? weights[symbol]! : 0;
        assertThat(weight <= spec.execution.maxPositionWeight, 'POSITION_LIMIT', 'Target weight exceeds the maximum position weight');
        assertThat(weight === 0 || ledger.hasMark(symbol), 'NO_KNOWN_PRICE', `No known price for target ${symbol}`);
        quantity = weight === 0 ? 0 : equity.mul(String(weight)).div(ledger.markExact(symbol)).floor().toNumber();
      }
      target(symbol, quantity, at, session, source);
    }
  }

  function executionPrice(order: Order, baseTicks: number, s: BarSeries): string {
    const bps = spec.execution.slippage.type === 'uniform_bps' ? spec.execution.slippage.bps * random() : spec.execution.slippage.bps;
    let ticks = new Decimal(baseTicks).mul(new Decimal(1).plus(new Decimal(String(bps)).div(10000).mul(order.side === 'buy' ? 1 : -1)));
    ticks = order.side === 'buy' ? ticks.ceil() : ticks.floor();
    if (order.type === 'limit' && order.price) {
      const limit = new Decimal(order.price).div(s.instrument.tickSize);
      ticks = order.side === 'buy' ? Decimal.min(ticks, limit) : Decimal.max(ticks, limit);
    }
    assertThat(ticks.gt(0) && ticks.lte(Number.MAX_SAFE_INTEGER), 'INVALID_FILL_PRICE', 'Slippage produced an invalid execution price');
    return priceFromTicks(ticks.toNumber(), s.instrument.tickSize);
  }

  function candidates(symbol: string, s: BarSeries, index: number, at: number, phase: 'open' | 'close'): Candidate[] {
    const result: Candidate[] = [];
    if (!s.tradable[index] || delisted.has(symbol)) return result;
    for (const order of pending) {
      if (!live(order) || order.symbol !== symbol) continue;
      const m = meta.get(order.id)!;
      if (order.tif === 'day' && m.session < s.sessionIndex[index]!) { transition(order, 'expired', at, 'DAY_EXPIRED'); continue; }
      if (phase === 'open') {
        if (order.submittedAt > at) continue;
        if (m.firstBar === undefined) m.firstBar = index;
      } else if (m.firstBar === undefined || index < m.firstBar || order.submittedAt >= at) continue;
      let ticks: number | undefined;
      const open = s.openTicks[index]!;
      const limit = order.price ? ticksFromPrice(order.price, s.instrument.tickSize) : undefined;
      if (phase === 'open') {
        if (order.type === 'market' || m.triggered) ticks = open;
        else if (order.type === 'limit' && (order.side === 'buy' ? open <= limit! : open >= limit!)) ticks = open;
        else if (order.type === 'stop' && (order.side === 'buy' ? open >= limit! : open <= limit!)) ticks = open;
      } else {
        if (order.type === 'limit' && (order.side === 'buy' ? s.lowTicks[index]! <= limit! : s.highTicks[index]! >= limit!)) ticks = limit;
        if (order.type === 'stop' && !m.triggered && (order.side === 'buy' ? s.highTicks[index]! >= limit! : s.lowTicks[index]! <= limit!)) ticks = limit;
      }
      if (ticks === undefined) continue;
      if (order.type === 'stop') m.triggered = true;
      const price = executionPrice(order, ticks, s);
      const actualTicks = ticksFromPrice(price, s.instrument.tickSize);
      if ((order.side === 'buy' && Number.isFinite(s.limitUpTicks[index]) && actualTicks >= s.limitUpTicks[index]!) ||
          (order.side === 'sell' && Number.isFinite(s.limitDownTicks[index]) && actualTicks <= s.limitDownTicks[index]!)) {
        transition(order, order.status, at, 'PRICE_LIMIT'); continue;
      }
      // Never use the current bar's final volume to allocate a next-open fill.
      const liquidity = index > 0 ? Math.floor(s.volume[index - 1]! * spec.execution.participationRate) : 0;
      if (!liquidity) { transition(order, order.status, at, 'NO_PRIOR_LIQUIDITY'); continue; }
      const quantity = Math.min(order.remaining, liquidity, order.side === 'sell' ? ledger.sellable(symbol, s.sessionIndex[index]!) : order.remaining);
      if (!quantity) { transition(order, order.status, at, 'UNSETTLED_POSITION'); continue; }
      result.push({ order, s, index, price, maxQuantity: quantity, phase: phase === 'open' ? 'open' : 'intrabar' });
    }
    return result;
  }

  // Each bar has one shared volume allowance across all its orders and phases.
  const usedLiquidity = new Map<string, number>();
  const intrabarEntries = new Set<string>();
  function execute(batch: Candidate[], at: number, session: number): void {
    if (!batch.length) return;
    batch.sort((a, b) => (a.order.side === 'sell' ? 0 : 1) - (b.order.side === 'sell' ? 0 : 1) || a.order.symbol.localeCompare(b.order.symbol) || Number(a.order.id.slice(1)) - Number(b.order.id.slice(1)));
    function capacity(c: Candidate): number {
      const key = `${c.order.symbol}/${c.index}`;
      const max = c.index > 0 ? Math.floor(c.s.volume[c.index - 1]! * spec.execution.participationRate) : 0;
      return live(c.order) ? Math.max(0, Math.min(c.order.remaining, c.maxQuantity, max - (usedLiquidity.get(key) ?? 0))) : 0;
    }
    function fill(c: Candidate, quantity: number): void {
      if (!quantity) return;
      ledger.fill(c.order, quantity, c.price, at, session, `${c.order.source}:${c.phase}`);
      historyRows++;
      delete c.order.reason;
      if (c.order.side === 'buy' && c.phase === 'intrabar') intrabarEntries.add(`${c.order.symbol}/${c.index}`);
      const key = `${c.order.symbol}/${c.index}`;
      usedLiquidity.set(key, (usedLiquidity.get(key) ?? 0) + quantity);
    }
    for (const c of batch.filter(c => c.order.side === 'sell')) {
      const quantity = Math.min(capacity(c), ledger.sellable(c.order.symbol, session));
      fill(c, quantity);
    }
    const buys = batch.filter(c => c.order.side === 'buy' && live(c.order));
    const costs = buys.map(c => new Decimal(c.price).mul(capacity(c)).plus(ledger.estimateCosts(c.order, capacity(c), c.price, at).total));
    const total = costs.reduce((a, b) => a.plus(b), new Decimal(0));
    const available = ledger.cash;
    const equity = ledger.equityExact();
    buys.forEach((c, i) => {
      const budget = spec.execution.cashAllocation === 'proportional' && total.gt(available) ? available.mul(costs[i]!).div(total) : ledger.cash;
      const capValue = equity.mul(String(spec.execution.maxPositionWeight)).minus(new Decimal(c.price).mul(ledger.position(c.order.symbol)));
      const capQty = Math.max(0, capValue.div(c.price).floor().toNumber());
      const quantity = ledger.affordableQuantity(c.order, c.price, at, Math.min(capacity(c), capQty), budget, 1);
      if (quantity === 0) { transition(c.order, c.order.status, at, 'INSUFFICIENT_CASH_OR_POSITION_LIMIT'); return; }
      fill(c, quantity);
    });
    // Whole-share rounding can leave an affordable residual. Award it once in
    // stable symbol/order priority; this is independent of input/worker order.
    if (spec.execution.cashAllocation === 'proportional' && total.gt(available)) for (const c of buys) {
      const capValue = ledger.equityExact().mul(String(spec.execution.maxPositionWeight)).minus(new Decimal(c.price).mul(ledger.position(c.order.symbol)));
      const capQty = Math.max(0, capValue.div(c.price).floor().toNumber());
      const quantity = ledger.affordableQuantity(c.order, c.price, at, Math.min(capacity(c), capQty), ledger.cash, 1);
      fill(c, quantity);
    }
  }

  function protect(symbol: string, s: BarSeries, index: number, at: number, phase: 'open' | 'close'): void {
    if (!s.tradable[index] || !ledger.position(symbol)) return;
    if (spec.execution.stopLossPct === undefined && spec.execution.takeProfitPct === undefined && spec.execution.trailingStopPct === undefined) return;
    const entry = ledger.averageEntryExact(symbol);
    let stop = spec.execution.stopLossPct !== undefined ? entry.mul(new Decimal(1).minus(String(spec.execution.stopLossPct))) : new Decimal(0);
    if (spec.execution.trailingStopPct !== undefined) stop = Decimal.max(stop, ledger.holdingHighExact(symbol).mul(new Decimal(1).minus(String(spec.execution.trailingStopPct))));
    const take = spec.execution.takeProfitPct !== undefined ? entry.mul(new Decimal(1).plus(String(spec.execution.takeProfitPct))) : new Decimal(Infinity);
    const tick = new Decimal(s.instrument.tickSize);
    const stopHit = stop.gt(0) && tick.mul(phase === 'open' ? s.openTicks[index]! : s.lowTicks[index]!).lte(stop);
    let takeHit = tick.mul(phase === 'open' ? s.openTicks[index]! : s.highTicks[index]!).gte(take);
    if (!stopHit && !takeHit) return;
    if (phase === 'close' && intrabarEntries.has(`${symbol}/${index}`)) {
      assertThat(spec.execution.intrabarPolicy !== 'reject', 'AMBIGUOUS_ENTRY_EXIT', 'Ambiguous same-bar entry and protective exit ordering cannot be established from OHLC data');
      warn('AMBIGUOUS_ENTRY_EXIT_CONSERVATIVE', 'Intrabar entry uses pessimistic stop ordering; profit requires an available close at or above the target');
      takeHit = takeHit && tick.mul(s.closeTicks[index]!).gte(take);
      if (!stopHit && !takeHit) return;
    }
    if (stopHit && takeHit) {
      assertThat(spec.execution.intrabarPolicy !== 'reject', 'AMBIGUOUS_BAR', 'Both protective stop and take-profit touched within one OHLC bar');
      warn('AMBIGUOUS_BAR_CONSERVATIVE', 'Both protective levels touched; conservative stop-first path used');
    }
    if (pending.some(o => live(o) && o.symbol === symbol && meta.get(o.id)?.intent === 'risk')) return;
    for (const o of pending) if (live(o) && o.symbol === symbol) transition(o, 'canceled', at, 'PROTECTIVE_OVERRIDE');
    const open = tick.mul(s.openTicks[index]!);
    const price = stopHit ? Decimal.min(open, stop) : Decimal.max(open, take);
    const priceTicks = Math.max(1, price.div(tick).floor().toNumber());
    const order = newOrder(symbol, 'sell', ledger.position(symbol), at, s.sessionIndex[index]!, stopHit ? 'protective_stop' : 'take_profit', undefined, 'risk');
    if (!order || !live(order)) return;
    meta.get(order.id)!.firstBar = index;
    if (Number.isFinite(s.limitDownTicks[index]) && priceTicks <= s.limitDownTicks[index]!) { transition(order, order.status, at, 'PRICE_LIMIT'); return; }
    execute([{ order, s, index, price: executionPrice(order, priceTicks, s), maxQuantity: ledger.sellable(symbol, s.sessionIndex[index]!), phase: phase === 'open' ? 'open' : 'intrabar' }], at, s.sessionIndex[index]!);
  }

  let targetIndex = 0, closesSeen = 0, lastRebalanceSession = -1, rebalanceUnits = 0, lastPeriodKey = '';
  let processed = 0;
  function decisions(updates: Map<string, number>, at: number, session: number): void {
    const strategy = spec.strategy;
    if (strategy.kind === 'targets') {
      while (targetIndex < strategy.schedule.length && strategy.schedule[targetIndex]!.at <= at) {
        const p = strategy.schedule[targetIndex++]!;
        targets(p.weights, p.quantities, at, session, `target@${p.at}`);
      }
    } else if (strategy.kind === 'rules') {
      const weightIntents = new Map<string, number>();
      for (const [ri, rule] of strategy.rules.entries()) {
        for (const symbol of [...updates.keys()].sort()) {
          if (rule.symbols && !rule.symbols.includes(symbol)) continue;
          if (evaluator.value(rule.when, symbol) !== 1) continue;
          const a = rule.action;
          if (a.type === 'target_weight') weightIntents.set(symbol, a.value!);
          else if (a.type === 'target_quantity') target(symbol, a.value!, at, session, `rule:${ri}`);
          else if (a.type === 'close') target(symbol, 0, at, session, `rule:${ri}`);
          else if (a.type === 'cancel') {
            for (const o of pending) if (live(o) && o.symbol === symbol && (!a.tag || o.tag === a.tag)) transition(o, 'canceled', at, 'STRATEGY_CANCEL');
          }
          else newOrder(symbol, a.side!, a.quantity!, at, session, `rule:${ri}`, a);
        }
      }
      const totalWeight = [...weightIntents.values()].reduce((sum, v) => sum + v, 0);
      assertThat(totalWeight <= 1 + 1e-12, 'LEVERAGE_NOT_SUPPORTED', 'Simultaneous rule weights exceed available capital');
      for (const [symbol, weight] of weightIntents) {
        assertThat(weight <= spec.execution.maxPositionWeight, 'POSITION_LIMIT', 'Rule target exceeds position limit');
        target(symbol, ledger.equityExact().mul(String(weight)).div(ledger.markExact(symbol)).floor().toNumber(), at, session, 'rule:target_weight');
      }
    } else if (strategy.kind === 'rank') {
      const date = calendar[session]!;
      let key: string;
      if (strategy.rebalanceUnit === 'bar') key = String(at);
      else if (strategy.rebalanceUnit === 'session') key = date;
      else if (strategy.rebalanceUnit === 'month') key = date.slice(0, 7);
      else { const d = new Date(`${date}T00:00:00Z`); key = String(Math.floor((d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000) / 86400000)); }
      if (key === lastPeriodKey) return;
      lastPeriodKey = key;
      if (rebalanceUnits++ % strategy.rebalanceEvery !== 0) return;
      const ranked = [...updates.keys()].filter(s => evaluator.isMember(s) && (!strategy.filter || evaluator.value(strategy.filter, s) === 1))
        .map(symbol => ({ symbol, score: evaluator.value(strategy.score, symbol) })).filter(x => Number.isFinite(x.score))
        .sort((a, b) => (strategy.descending ? b.score - a.score : a.score - b.score) || a.symbol.localeCompare(b.symbol)).slice(0, strategy.topK);
      const weights: Record<string, number> = Object.create(null);
      if (strategy.weighting === 'equal') for (const r of ranked) weights[r.symbol] = strategy.grossWeight / ranked.length;
      else {
        assertThat(ranked.every(r => r.score >= 0), 'INVALID_SCORE_WEIGHT', 'Score weights require nonnegative scores');
        const sum = ranked.reduce((a, b) => a + b.score, 0);
        if (sum > 0) for (const r of ranked) weights[r.symbol] = strategy.grossWeight * r.score / sum;
      }
      targets(weights, undefined, at, session, 'rank_rebalance');
    }
  }

  while (clock.size && clock.peek()!.at < spec.end) {
    const at = clock.peek()!.at;
    const batch: ClockEvent[] = [];
    while (clock.size && clock.peek()!.at === at) batch.push(clock.pop());
    batch.sort((a, b) => (a.symbol ?? '').localeCompare(b.symbol ?? '') || a.index - b.index);
    const barEvent = batch.find(e => e.symbol !== undefined);
    const session = barEvent ? dataset.series.get(barEvent.symbol!)!.sessionIndex[barEvent.index]! : sessionAt(at);
    lastSession = session;
    const active = at >= spec.start;
    if (++processed % 1024 === 0) {
      assertThat(!hooks.canceled?.(), 'CANCELED', 'Backtest canceled');
      assertThat(performance.now() - started <= spec.limits.maxRuntimeMs, 'TIME_LIMIT', 'Backtest exceeded its runtime limit');
      hooks.progress?.(closesSeen, dataset.rowCount);
    }
    assertThat(!hooks.canceled?.(), 'CANCELED', 'Backtest canceled');
    for (const e of batch) if (e.kind === 'open' || e.kind === 'close') {
      const s = dataset.series.get(e.symbol!)!;
      const values = e.kind === 'open' ? s.openTime : s.closeTime;
      if (e.index + 1 < values.length) clock.push({ ...e, at: values[e.index + 1]!, index: e.index + 1 });
    }
    if (active) {
      for (const e of batch.filter(e => e.kind === 'action')) {
        const action = dataset.actions[e.index]!;
        if (action.type === 'split' || action.type === 'delist') for (const o of pending) if (live(o) && o.symbol === action.symbol) {
          if (action.type === 'split' && spec.execution.splitOrderPolicy === 'adjust') {
            const quantity = new Decimal(o.quantity).mul(action.ratio), remaining = new Decimal(o.remaining).mul(action.ratio);
            const price = o.price === undefined ? undefined : new Decimal(o.price).div(action.ratio);
            const tick = dataset.series.get(o.symbol)!.instrument.tickSize;
            if (quantity.isInteger() && quantity.lte(Number.MAX_SAFE_INTEGER) && remaining.isInteger() && remaining.gt(0) && (!price || price.div(tick).isInteger())) {
              (o.adjustments ??= []).push({ at, reason: 'split', ratio: action.ratio, priorQuantity: o.quantity, priorRemaining: o.remaining, ...(o.price ? { priorPrice: o.price } : {}) });
              o.quantity = quantity.toNumber(); o.remaining = remaining.toNumber(); if (price) o.price = price.toFixed();
            } else transition(o, 'canceled', at, 'SPLIT_ORDER_UNREPRESENTABLE');
          } else transition(o, 'canceled', at, action.type === 'split' ? 'SPLIT_CANCEL' : 'DELIST_CANCEL');
        }
        ledger.corporateAction(action, session);
        if (action.type === 'delist') delisted.add(action.symbol);
      }
      ledger.payDividends(at);
      for (const e of batch.filter(e => e.kind === 'flow')) ledger.cashFlow(spec.account.cashFlows[e.index]!.amount, at);
    }
    const closed = batch.filter(e => e.kind === 'close');
    if (closed.length) {
      const updates = new Map<string, number>();
      if (active && spec.strategy.kind !== 'replay') {
        const matched = closed.flatMap(e => candidates(e.symbol!, dataset.series.get(e.symbol!)!, e.index, at, 'close'));
        execute(matched, at, session);
        for (const e of closed) protect(e.symbol!, dataset.series.get(e.symbol!)!, e.index, at, 'close');
      }
      for (const e of closed) {
        const s = dataset.series.get(e.symbol!)!;
        current.set(e.symbol!, e.index);
        if (!delisted.has(e.symbol!)) ledger.setMarkTicks(e.symbol!, s.closeTicks[e.index]!, at, session);
        if (active) ledger.observeHighTicks(e.symbol!, s.highTicks[e.index]!);
        updates.set(e.symbol!, e.index); closesSeen++;
      }
      const before = hooks.measurePhases ? performance.now() : 0;
      evaluator.step(updates, at, symbol => ledger.state(symbol, session));
      if (hooks.measurePhases) indicatorMs += performance.now() - before;
      if (active) {
        ledger.recordEquity(at, session);
        if (spec.output.level === 'fullTrace') for (const [symbol, index] of updates) {
          const s = dataset.series.get(symbol)!;
          const values: Record<string, number | null> = { close: Number(priceFromTicks(s.closeTicks[index]!, s.instrument.tickSize)), volume: s.volume[index]! };
          if ('nodes' in spec.strategy) for (const [name, expression] of Object.entries(spec.strategy.nodes)) {
            const value = evaluator.value(expression, symbol);
            values[`node:${name}`] = Number.isFinite(value) ? value : null;
          }
          if (spec.strategy.kind === 'rank') {
            const value = evaluator.value(spec.strategy.score, symbol);
            values.score = Number.isFinite(value) ? value : null;
          }
          trace.push({ at, symbol, values, state: ledger.state(symbol, session),
            ...(spec.strategy.kind === 'rules' ? { rules: spec.strategy.rules.map((rule, index) => ({ index, matched: (!rule.symbols || rule.symbols.includes(symbol)) && evaluator.value(rule.when, symbol) === 1 })) } : {}) });
        }
        decisions(updates, at, session);
      }
      for (const e of closed) {
        const s = dataset.series.get(e.symbol!)!;
        if (e.index + 1 === s.closeTime.length || s.sessionIndex[e.index + 1] !== session) {
          for (const o of pending) if (live(o) && o.symbol === e.symbol && o.tif === 'day' && meta.get(o.id)!.session <= session) transition(o, 'expired', at, 'DAY_EXPIRED');
        }
        usedLiquidity.delete(`${e.symbol}/${e.index}`);
        intrabarEntries.delete(`${e.symbol}/${e.index}`);
      }
    }
    const opened = batch.filter(e => e.kind === 'open');
    for (const e of opened) {
      const s = dataset.series.get(e.symbol!)!;
      if (!delisted.has(e.symbol!)) ledger.setMarkTicks(e.symbol!, s.openTicks[e.index]!, at, session);
    }
    if (active && spec.strategy.kind !== 'replay') {
      for (const e of opened) protect(e.symbol!, dataset.series.get(e.symbol!)!, e.index, at, 'open');
      execute(opened.flatMap(e => candidates(e.symbol!, dataset.series.get(e.symbol!)!, e.index, at, 'open')), at, session);
    }
    if (active && spec.strategy.kind === 'replay') for (const e of batch.filter(e => e.kind === 'replay')) {
      const f = spec.strategy.fills[e.index]!;
      assertThat(ledger.hasMark(f.symbol), 'NO_KNOWN_PRICE', 'Replay execution precedes any observed instrument quote');
      // Supplied executions are accounting input: never lot-round or simulate slippage again.
      const order: Order = { id: `o${orders.length + 1}`, symbol: f.symbol, side: f.side, type: 'market', quantity: f.quantity, remaining: f.quantity, submittedAt: at, tif: 'gtc', status: 'accepted', cumulativeNotional: '0', commissionAccruedRaw: '0', commissionPaid: '0', source: 'replay' };
      assertThat(orders.length < spec.limits.maxOrders, 'ORDER_LIMIT', 'Replay exceeds order budget');
      orders.push(order);
      transition(order, 'accepted', at);
      ledger.fill(order, f.quantity, f.price, at, session, 'replay', spec.strategy.feePolicy === 'provided' ? f.fees : undefined);
      historyRows++;
      ledger.recordEquity(at, session);
    }
    if (active && !closed.length && batch.some(e => ['flow', 'action', 'pay'].includes(e.kind))) ledger.recordEquity(at, session);
    pending = pending.filter(live);
    assertThat(ledger.equity.length + ledger.fills.length + ledger.events.length + orders.length + trace.length + historyRows <= spec.limits.maxOutputRows, 'OUTPUT_LIMIT', 'Output row budget exceeded');
  }
  for (const o of pending) if (live(o)) transition(o, 'expired', spec.end, 'END_OF_RUN');
  if (ledger.lastEquity.at < spec.end - 1) ledger.recordEquity(spec.end - 1, sessionAt(spec.end - 1));
  assertThat(ledger.equity.length + ledger.fills.length + ledger.events.length + orders.length + trace.length + historyRows <= spec.limits.maxOutputRows, 'OUTPUT_LIMIT', 'Terminal observations exceed the output row budget');
  const metrics = calculateMetrics(spec, dataset, ledger, orders);
  const elapsed = performance.now() - started;
  assertThat(elapsed <= spec.limits.maxRuntimeMs, 'TIME_LIMIT', 'Backtest exceeded its runtime limit');
  hooks.progress?.(closesSeen, dataset.rowCount);
  return { schemaVersion: '1', engineVersion: ENGINE_VERSION, fingerprint: contentHash({ engineVersion: ENGINE_VERSION, spec, datasetHash: dataset.hash }),
    mode: spec.strategy.kind === 'replay' ? 'replay' : 'backtest', spec, datasetHash: dataset.hash, metrics,
    orders: spec.output.level === 'summary' ? [] : orders, fills: spec.output.level === 'summary' ? [] : ledger.fills,
    events: spec.output.level === 'fullTrace' ? ledger.events : [], equity: spec.output.level === 'fullTrace' ? ledger.equity : [],
    ...(spec.output.level === 'fullTrace' ? { trace } : {}), warnings: [...warnings, ...ledger.warnings], timing: { totalMs: elapsed,
      indicatorMs: hooks.measurePhases ? indicatorMs : null, engineMs: hooks.measurePhases ? elapsed - indicatorMs : null, phaseTiming: hooks.measurePhases ? 'measured' : 'disabled' } };
}
