import { assertThat, BacktestError } from '../spec/errors.js';
import type { BacktestSpec, BarSeries, Dataset, Expression, FeaturePoint, MembershipPoint, StateField } from '../spec/types.js';
import { ATR, Crossing, EMA, Lag, RollingExtreme, RollingQuantile, RSI, SMA, type NumericState } from './indicators.js';

export type StrategyState = Record<StateField, number>;
export type StateProvider = (symbol: string) => StrategyState;
/** Frame evaluation needs no fictitious execution frequency or account. */
export type EvaluationData = Pick<Dataset, 'series' | 'features' | 'membership'> & { metadata: Pick<Dataset['metadata'], 'universeMode'> };
export type EvaluationSpec = Pick<BacktestSpec, 'strategy'> & { limits: Pick<BacktestSpec['limits'], 'maxNodes'> };
type Memory = NumericState | ATR | Crossing;
interface CompiledNode { expr: Expression; args: number[]; values: Float64Array; memory: (Memory | undefined)[] }
interface FeatureCursor { points: FeaturePoint[]; next: number; value: number }
interface MembershipCursor { points: MembershipPoint[]; next: number; member: boolean }

/**
 * A topologically ordered DAG is evaluated across the entire completed-bar batch.
 * Cross-sectional rank is ascending, 1-based average rank for ties. zscore uses
 * population variance; a constant section is undefined (NaN). Stale symbols are
 * excluded from cross sections, as are symbols outside a point-in-time universe.
 */
export class StrategyEvaluator {
  readonly symbols: string[];
  private readonly symbolIndex = new Map<string, number>();
  private readonly series: BarSeries[];
  private readonly tick: number[];
  private readonly nodes: CompiledNode[] = [];
  private readonly keys = new Map<string, number>();
  private readonly expressionIds = new WeakMap<object, number>();
  private readonly named: Record<string, Expression>;
  private readonly features = new Map<string, Map<string, FeatureCursor>>();
  private readonly membership = new Map<string, MembershipCursor>();
  private readonly lastIndex: Float64Array;
  private reservedBytes = 0;
  private at = -1;

  constructor(private readonly dataset: EvaluationData, private readonly spec: EvaluationSpec) {
    this.symbols = [...dataset.series.keys()].sort();
    this.symbols.forEach((symbol, index) => this.symbolIndex.set(symbol, index));
    this.series = this.symbols.map(symbol => dataset.series.get(symbol)!);
    this.tick = this.series.map(series => Number(series.instrument.tickSize));
    this.lastIndex = new Float64Array(this.symbols.length).fill(-1);
    const strategy = spec.strategy;
    this.named = 'nodes' in strategy ? strategy.nodes : {};
    for (const expr of Object.values(this.named)) this.compile(expr);
    if (strategy.kind === 'rules') for (const rule of strategy.rules) this.compile(rule.when);
    if (strategy.kind === 'rank') {
      this.compile(strategy.score);
      if (strategy.filter) this.compile(strategy.filter);
    }
    for (const point of dataset.features) {
      let symbolFeatures = this.features.get(point.symbol);
      if (!symbolFeatures) this.features.set(point.symbol, symbolFeatures = new Map());
      let cursor = symbolFeatures.get(point.name);
      if (!cursor) symbolFeatures.set(point.name, cursor = { points: [], next: 0, value: NaN });
      cursor.points.push(point);
    }
    for (const symbolFeatures of this.features.values()) {
      for (const cursor of symbolFeatures.values()) cursor.points.sort((a, b) => a.availableAt - b.availableAt);
    }
    for (const point of dataset.membership) {
      let cursor = this.membership.get(point.symbol);
      if (!cursor) this.membership.set(point.symbol, cursor = { points: [], next: 0, member: false });
      cursor.points.push(point);
    }
    for (const cursor of this.membership.values()) cursor.points.sort((a, b) => a.availableAt - b.availableAt);
  }

  get nodeCount(): number { return this.nodes.length; }

  /** Membership visible at this symbol's latest completed-bar evaluation. */
  isMember(symbol: string): boolean {
    assertThat(this.symbolIndex.has(symbol), 'UNKNOWN_INSTRUMENT', `Unknown symbol ${symbol}`);
    return this.dataset.metadata.universeMode === 'static' || this.membership.get(symbol)?.member === true;
  }

  private reserve(bytes: number): void {
    assertThat(this.reservedBytes + bytes <= 256 * 1024 * 1024,
      'INDICATOR_MEMORY_LIMIT', 'Compiled values and indicator state exceed the 256 MiB budget');
    this.reservedBytes += bytes;
  }

  private compile(expr: Expression, visiting = new Set<string>()): number {
    const cached = this.expressionIds.get(expr);
    if (cached !== undefined) return cached;
    if ('ref' in expr) {
      assertThat(Object.hasOwn(this.named, expr.ref), 'UNKNOWN_REFERENCE', `Unknown node ${expr.ref}`);
      assertThat(!visiting.has(expr.ref), 'CYCLIC_EXPRESSION', `Cyclic reference ${expr.ref}`);
      visiting.add(expr.ref);
      const id = this.compile(this.named[expr.ref]!, visiting);
      visiting.delete(expr.ref);
      this.expressionIds.set(expr, id);
      return id;
    }
    if ('op' in expr && ['macd', 'macd_signal', 'macd_hist'].includes(expr.op)) {
      const input = expr.args[0]!;
      const line: Expression = { op: 'sub', args: [
        { op: 'ema', args: [input], period: expr.fast! },
        { op: 'ema', args: [input], period: expr.slow! },
      ] };
      const signal: Expression = { op: 'ema', args: [line], period: expr.signal! };
      const expanded: Expression = expr.op === 'macd' ? line : expr.op === 'macd_signal' ? signal
        : { op: 'sub', args: [line, signal] };
      const id = this.compile(expanded, visiting);
      this.expressionIds.set(expr, id);
      return id;
    }
    const args = 'op' in expr ? expr.args.map(arg => this.compile(arg, visiting)) : [];
    const key = 'op' in expr
      ? JSON.stringify([expr.op, args, expr.period ?? null, expr.quantile ?? null])
      : JSON.stringify(expr);
    let id = this.keys.get(key);
    if (id === undefined) {
      assertThat(this.nodes.length < this.spec.limits.maxNodes * 4, 'EXPRESSION_LIMIT', 'Expanded strategy exceeds node limit');
      id = this.nodes.length;
      this.reserve(this.symbols.length * 8);
      this.nodes.push({ expr, args, values: new Float64Array(this.symbols.length).fill(NaN), memory: [] });
      this.keys.set(key, id);
    }
    this.expressionIds.set(expr, id);
    return id;
  }

  /** Call once after all securities closing at `at` have become available. */
  step(updates: ReadonlyMap<string, number>, at: number, state: StateProvider): void {
    assertThat(Number.isSafeInteger(at) && at > this.at, 'INVALID_EVALUATION_TIME', 'Completed-bar batch timestamps must increase');
    const active: number[] = [];
    const stateValues: (StrategyState | undefined)[] = [];
    for (const [symbol, index] of updates) {
      const id = this.symbolIndex.get(symbol);
      assertThat(id !== undefined, 'UNKNOWN_INSTRUMENT', `Unknown symbol ${symbol}`);
      const series = this.series[id]!;
      assertThat(Number.isInteger(index) && index >= 0 && index < series.closeTime.length,
        'INVALID_BAR_INDEX', `Invalid completed-bar index for ${symbol}`);
      assertThat(series.closeTime[index] === at, 'FUTURE_DATA', 'Updates must refer to bars closing exactly at the batch timestamp');
      assertThat(this.lastIndex[id] === -1 || index === this.lastIndex[id]! + 1,
        'SKIPPED_BAR', 'Each security must advance one completed bar at a time');
      active.push(id);
      stateValues[id] = state(symbol);
    }
    active.sort((a, b) => a - b);
    this.at = at;
    for (const id of active) {
      this.lastIndex[id] = updates.get(this.symbols[id]!)!;
      for (const cursor of this.features.get(this.symbols[id]!)?.values() ?? []) {
        while (cursor.next < cursor.points.length && cursor.points[cursor.next]!.availableAt <= at) {
          cursor.value = cursor.points[cursor.next++]!.value ?? NaN;
        }
      }
    }
    // Universe changes can occur while an instrument has no bar in this batch.
    for (const membership of this.membership.values()) {
      while (membership.next < membership.points.length && membership.points[membership.next]!.availableAt <= at) {
        membership.member = membership.points[membership.next++]!.member;
      }
    }
    for (const node of this.nodes) {
      if ('op' in node.expr && (node.expr.op === 'rank' || node.expr.op === 'zscore')) {
        this.crossSection(node, active);
        continue;
      }
      for (const id of active) {
        const value = this.compute(node, id, this.lastIndex[id]!, stateValues[id]!);
        node.values[id] = Number.isFinite(value) ? value : NaN;
      }
    }
  }

  value(expr: Expression, symbol: string): number {
    const id = this.expressionIds.get(expr);
    assertThat(id !== undefined, 'UNKNOWN_EXPRESSION', 'Expression must belong to the compiled strategy');
    const index = this.symbolIndex.get(symbol);
    assertThat(index !== undefined, 'UNKNOWN_INSTRUMENT', `Unknown symbol ${symbol}`);
    return this.nodes[id]!.values[index]!;
  }

  private crossSection(node: CompiledNode, active: number[]): void {
    const expr = node.expr;
    if (!('op' in expr)) return;
    const source = this.nodes[node.args[0]!]!.values;
    const eligible = active.filter(id => Number.isFinite(source[id]) &&
      (this.dataset.metadata.universeMode === 'static' || this.membership.get(this.symbols[id]!)?.member === true));
    for (const id of active) node.values[id] = NaN;
    if (expr.op === 'rank') {
      eligible.sort((a, b) => source[a]! - source[b]! || a - b);
      for (let i = 0; i < eligible.length;) {
        let end = i + 1;
        while (end < eligible.length && source[eligible[end]!] === source[eligible[i]!]) end++;
        const rank = (i + 1 + end) / 2;
        for (let j = i; j < end; j++) node.values[eligible[j]!] = rank;
        i = end;
      }
    } else {
      let count = 0, mean = 0, m2 = 0;
      for (const id of eligible) {
        const value = source[id]!;
        const delta = value - mean; mean += delta / ++count; m2 += delta * (value - mean);
      }
      const deviation = Math.sqrt(m2 / count);
      if (deviation > 0 && Number.isFinite(deviation)) for (const id of eligible) node.values[id] = (source[id]! - mean) / deviation;
    }
  }

  private memory(node: CompiledNode, id: number): Memory {
    let memory = node.memory[id];
    if (memory) return memory;
    const expr = node.expr;
    if (!('op' in expr)) throw new BacktestError('INTERNAL_ERROR', 'Non-operator requested indicator memory');
    const period = expr.period!;
    if (period > this.series[id]!.closeTime.length) {
      // No result can warm up within this series; avoid an unused huge window.
      memory = { next: () => NaN };
      node.memory[id] = memory;
      return memory;
    }
    const bytes = ['sma', 'lag'].includes(expr.op) ? period * 8
      : ['rolling_min', 'rolling_max'].includes(expr.op) ? period * 24 + 16
      : expr.op === 'rolling_quantile' ? period * 104 : 128;
    this.reserve(bytes);
    switch (expr.op) {
      case 'sma': memory = new SMA(period); break;
      case 'ema': memory = new EMA(period); break;
      case 'rsi': memory = new RSI(period); break;
      case 'atr': memory = new ATR(period); break;
      case 'lag': memory = new Lag(period); break;
      case 'rolling_min': memory = new RollingExtreme(period, false); break;
      case 'rolling_max': memory = new RollingExtreme(period, true); break;
      case 'rolling_quantile': memory = new RollingQuantile(period, expr.quantile!); break;
      case 'cross_up': memory = new Crossing(true); break;
      case 'cross_down': memory = new Crossing(false); break;
      default: throw new BacktestError('INTERNAL_ERROR', `Unexpected stateful operator ${expr.op}`);
    }
    node.memory[id] = memory;
    return memory;
  }

  private compute(node: CompiledNode, id: number, index: number, state: StrategyState): number {
    const expr = node.expr;
    const series = this.series[id]!;
    if ('field' in expr) {
      switch (expr.field) {
        case 'open': return series.openTicks[index]! * this.tick[id]!;
        case 'high': return series.highTicks[index]! * this.tick[id]!;
        case 'low': return series.lowTicks[index]! * this.tick[id]!;
        case 'close': return series.closeTicks[index]! * this.tick[id]!;
        case 'volume': return series.volume[index]!;
        case 'amount': return series.amount[index]!;
      }
    }
    if ('feature' in expr) return this.features.get(this.symbols[id]!)?.get(expr.feature)?.value ?? NaN;
    if ('time' in expr) return this.at;
    if ('value' in expr) return Number(expr.value);
    if ('state' in expr) return state[expr.state];
    if (!('op' in expr)) throw new BacktestError('INTERNAL_ERROR', 'Unresolved expression reference');
    const left = node.args[0] === undefined ? NaN : this.nodes[node.args[0]]!.values[id]!;
    const right = node.args[1] === undefined ? NaN : this.nodes[node.args[1]]!.values[id]!;
    const finite = Number.isFinite(left) && Number.isFinite(right);
    switch (expr.op) {
      case 'add': return finite ? left + right : NaN;
      case 'sub': return finite ? left - right : NaN;
      case 'mul': return finite ? left * right : NaN;
      case 'div': return finite && right !== 0 ? left / right : NaN;
      case 'gt': return finite ? Number(left > right) : NaN;
      case 'gte': return finite ? Number(left >= right) : NaN;
      case 'lt': return finite ? Number(left < right) : NaN;
      case 'lte': return finite ? Number(left <= right) : NaN;
      case 'eq': return finite ? Number(left === right) : NaN;
      case 'not': return Number.isFinite(left) ? Number(left === 0) : NaN;
      case 'if': return Number.isFinite(left) ? this.nodes[node.args[left !== 0 ? 1 : 2]!]!.values[id]! : NaN;
      case 'and':
      case 'or': {
        let truth = expr.op === 'and';
        for (const arg of node.args) {
          const value = this.nodes[arg]!.values[id]!;
          if (!Number.isFinite(value)) return NaN;
          truth = expr.op === 'and' ? truth && value !== 0 : truth || value !== 0;
        }
        return Number(truth);
      }
      case 'cross_up':
      case 'cross_down': return (this.memory(node, id) as Crossing).next(left, right);
      case 'atr': return (this.memory(node, id) as ATR).next(series.highTicks[index]! * this.tick[id]!, series.lowTicks[index]! * this.tick[id]!, series.closeTicks[index]! * this.tick[id]!);
      case 'sma': case 'ema': case 'rsi': case 'lag': case 'rolling_min': case 'rolling_max': case 'rolling_quantile':
        return (this.memory(node, id) as NumericState).next(left);
      default: throw new BacktestError('INTERNAL_ERROR', `Uncompiled operator ${expr.op}`);
    }
  }
}
