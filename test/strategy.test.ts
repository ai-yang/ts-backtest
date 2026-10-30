import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDataset } from '../src/data/normalize.js';
import { BacktestError } from '../src/spec/errors.js';
import { parseSpec } from '../src/spec/validate.js';
import type { DatasetInput, Expression, RulesStrategy } from '../src/spec/types.js';
import { StrategyEvaluator, type StrategyState } from '../src/strategy/evaluator.js';
import { RollingExtreme, RollingQuantile } from '../src/strategy/indicators.js';
import { bar, closeAt, input, instrument, sessions, spec } from './helpers.js';

const emptyState: StrategyState = { position: 0, holding_sessions: 0, holding_high: 0, cooldown_sessions: 0 };
const state = () => emptyState;
const close: Expression = { field: 'close' };

function run(nodes: Record<string, Expression>, data = input(['1', '2', '3', '4', '5', '6', '7', '8'])) {
  const parsed = parseSpec(spec({ strategy: { kind: 'rules', nodes, rules: [{ when: { value: false }, action: { type: 'close' } }] } }));
  const strategy = parsed.strategy as RulesStrategy;
  const evaluator = new StrategyEvaluator(normalizeDataset(data), parsed);
  const output = new Map<string, number[]>();
  for (const name of Object.keys(nodes)) output.set(name, []);
  for (let i = 0; i < data.bars.length; i++) {
    evaluator.step(new Map([['AAA', i]]), data.bars[i]!.closeTime, state);
    for (const [name, expression] of Object.entries(strategy.nodes)) output.get(name)!.push(evaluator.value(expression, 'AAA'));
  }
  return { evaluator, output };
}

function near(actual: number[], expected: number[], epsilon = 1e-10): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    const want = expected[index]!;
    if (Number.isNaN(want)) assert.ok(Number.isNaN(value), `index ${index}: expected NaN, got ${value}`);
    else assert.ok(Math.abs(value - want) <= epsilon, `index ${index}: expected ${want}, got ${value}`);
  });
}

test('SMA, SMA-seeded EMA and lag have explicit warmup behavior', () => {
  const { output } = run({
    sma: { op: 'sma', args: [close], period: 3 },
    ema: { op: 'ema', args: [close], period: 3 },
    lag: { op: 'lag', args: [close], period: 2 },
  });
  near(output.get('sma')!, [NaN, NaN, 2, 3, 4, 5, 6, 7]);
  near(output.get('ema')!, [NaN, NaN, 2, 3, 4, 5, 6, 7]);
  near(output.get('lag')!, [NaN, NaN, 1, 2, 3, 4, 5, 6]);
});

test('RSI uses Wilder averages and needs period plus one prices', () => {
  const { output } = run({ rsi: { op: 'rsi', args: [close], period: 2 } }, input(['10', '12', '11', '14']));
  near(output.get('rsi')!, [NaN, NaN, 100 - 100 / 3, 100 - 100 / 9]);
  near(run({ rsi: { op: 'rsi', args: [close], period: 2 } }, input(['10', '10', '10', '10'])).output.get('rsi')!, [NaN, NaN, 50, 50]);
});

test('ATR includes overnight gaps and uses Wilder smoothing', () => {
  const data = input(['10', '12', '11', '14']);
  data.bars = [
    bar(sessions[0]!, '10', { high: '11', low: '9' }),
    bar(sessions[1]!, '12', { high: '13', low: '11' }),
    bar(sessions[2]!, '11', { high: '12', low: '10' }),
    bar(sessions[3]!, '14', { high: '15', low: '13' }),
  ];
  near(run({ atr: { op: 'atr', args: [], period: 2 } }, data).output.get('atr')!, [NaN, 2.5, 2.25, 3.125]);
});

test('MACD lines share EMA nodes and signal warmup is explicit', () => {
  const parameters = { args: [close], fast: 2, slow: 3, signal: 2 };
  const { evaluator, output } = run({
    line: { op: 'macd', ...parameters }, signal: { op: 'macd_signal', ...parameters },
    histogram: { op: 'macd_hist', ...parameters },
  });
  near(output.get('line')!, [NaN, NaN, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  near(output.get('signal')!, [NaN, NaN, NaN, 0.5, 0.5, 0.5, 0.5, 0.5]);
  near(output.get('histogram')!, [NaN, NaN, NaN, 0, 0, 0, 0, 0]);
  assert.equal(evaluator.nodeCount, 7); // close, fast EMA, slow EMA, diff, signal EMA, hist, false
});

test('rolling minima, maxima and quantiles match full-window gold values', () => {
  const { output } = run({
    min: { op: 'rolling_min', args: [close], period: 3 },
    max: { op: 'rolling_max', args: [close], period: 3 },
    median: { op: 'rolling_quantile', args: [close], period: 3, quantile: 0.5 },
    quarter: { op: 'rolling_quantile', args: [close], period: 3, quantile: 0.25 },
  }, input(['1', '5', '2', '4', '3']));
  near(output.get('min')!, [NaN, NaN, 1, 2, 2]);
  near(output.get('max')!, [NaN, NaN, 5, 5, 4]);
  near(output.get('median')!, [NaN, NaN, 2, 4, 3]);
  near(output.get('quarter')!, [NaN, NaN, 1.5, 3, 2.5]);
});

test('rolling order statistics match a reference under duplicates and missing data', () => {
  const length = 17;
  const min = new RollingExtreme(length, false), max = new RollingExtreme(length, true);
  const quantiles = [0, 0.1, 0.5, 0.99, 1].map(q => new RollingQuantile(length, q));
  const values: number[] = [];
  let random = 42;
  for (let i = 0; i < 2000; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const value = i % 113 === 0 ? NaN : (random % 51) - 25;
    values.push(value);
    const window = values.slice(-length).sort((a, b) => a - b);
    const complete = window.length === length && window.every(Number.isFinite);
    near([min.next(value)], [complete ? window[0]! : NaN]);
    near([max.next(value)], [complete ? window.at(-1)! : NaN]);
    quantiles.forEach(operator => {
      const at = (length - 1) * operator.quantile, lo = Math.floor(at), fraction = at - lo;
      const expected = !complete ? NaN : fraction === 0 ? window[lo]! : window[lo]! + fraction * (window[lo + 1]! - window[lo]!);
      near([operator.next(value)], [expected]);
    });
  }
});

test('crossing compares previous and current values including equality boundaries', () => {
  const { output } = run({
    up: { op: 'cross_up', args: [close, { value: 2 }] },
    down: { op: 'cross_down', args: [close, { value: 2 }] },
  }, input(['1', '2', '3', '3', '2', '1']));
  near(output.get('up')!, [NaN, 0, 1, 0, 0, 0]);
  near(output.get('down')!, [NaN, 0, 0, 0, 0, 1]);
});

test('unavailable features and division by zero never become actionable truth', () => {
  const data = input(['10', '10', '10', '10']);
  data.features = [{ symbol: 'AAA', name: 'pe', availableAt: closeAt(sessions[2]!), value: 5 }];
  const { output } = run({
    feature: { feature: 'pe' },
    mean: { op: 'sma', args: [{ feature: 'pe' }], period: 2 },
    zero: { op: 'div', args: [{ value: 1 }, { value: 0 }] },
    invalidTruth: { op: 'not', args: [{ op: 'gt', args: [{ feature: 'pe' }, { value: 0 }] }] },
    choose: { op: 'if', args: [{ value: true }, { value: 7 }, { feature: 'missing' }] },
  }, data);
  near(output.get('feature')!, [NaN, NaN, 5, 5]);
  near(output.get('mean')!, [NaN, NaN, NaN, 5]);
  near(output.get('zero')!, [NaN, NaN, NaN, NaN]);
  near(output.get('invalidTruth')!, [NaN, NaN, 0, 0]);
  near(output.get('choose')!, [7, 7, 7, 7]);
});

test('feature publish timestamps are causal, including updates between bar closes', () => {
  const data = input(['10', '10', '10', '10']);
  data.features = [
    { symbol: 'AAA', name: 'value', availableAt: closeAt(sessions[0]!) + 1, value: 10 },
    { symbol: 'AAA', name: 'value', availableAt: closeAt(sessions[2]!), value: 20 },
    { symbol: 'AAA', name: 'value', availableAt: closeAt(sessions[3]!) + 1, value: 999 },
  ];
  near(run({ feature: { feature: 'value' } }, data).output.get('feature')!, [NaN, 10, 20, 20]);
});

function multiData(): DatasetInput {
  const data = input(['1', '3', '2']);
  data.metadata.instruments.push(instrument('BBB'), instrument('CCC'));
  data.bars.push(...['3', '2', '1'].map((price, i) => bar(sessions[i]!, price, { symbol: 'BBB' })));
  data.bars.push(...['3', '1', '3'].map((price, i) => bar(sessions[i]!, price, { symbol: 'CCC' })));
  return data;
}

test('cross sections are synchronized, deterministic under symbol order, and ties average', () => {
  const rank: Expression = { op: 'rank', args: [close] };
  const zscore: Expression = { op: 'zscore', args: [close] };
  const averageRank: Expression = { op: 'sma', args: [rank], period: 2 };
  const parsed = parseSpec(spec({ strategy: { kind: 'rules', nodes: { rank, zscore, averageRank }, rules: [{ when: { value: false }, action: { type: 'close' } }] } }));
  const nodes = (parsed.strategy as RulesStrategy).nodes;
  const a = new StrategyEvaluator(normalizeDataset(multiData()), parsed);
  const b = new StrategyEvaluator(normalizeDataset(multiData()), parsed);
  const expectedRanks = [[1, 2.5, 2.5], [3, 2, 1], [2, 1, 3]];
  for (let i = 0; i < 3; i++) {
    a.step(new Map([['AAA', i], ['BBB', i], ['CCC', i]]), closeAt(sessions[i]!), state);
    b.step(new Map([['CCC', i], ['AAA', i], ['BBB', i]]), closeAt(sessions[i]!), state);
    near(a.symbols.map(symbol => a.value(nodes.rank!, symbol)), expectedRanks[i]!);
    for (const expr of Object.values(nodes)) near(a.symbols.map(symbol => a.value(expr, symbol)), a.symbols.map(symbol => b.value(expr, symbol)));
    if (i === 0) near(a.symbols.map(symbol => a.value(nodes.zscore!, symbol)), [-Math.SQRT2, 1 / Math.SQRT2, 1 / Math.SQRT2]);
    if (i === 1) near(a.symbols.map(symbol => a.value(nodes.averageRank!, symbol)), [2, 2.25, 1.75]);
  }
});

test('point-in-time membership excludes unavailable constituents from cross sections', () => {
  const data = multiData();
  data.metadata.universeMode = 'point_in_time';
  data.membership = [
    { symbol: 'AAA', availableAt: closeAt(sessions[0]!), member: true },
    { symbol: 'BBB', availableAt: closeAt(sessions[1]!), member: true },
    { symbol: 'CCC', availableAt: closeAt(sessions[0]!), member: true },
    { symbol: 'CCC', availableAt: closeAt(sessions[1]!), member: false },
  ];
  const parsed = parseSpec(spec({ strategy: { kind: 'rank', nodes: {}, score: { op: 'rank', args: [close] }, topK: 1,
    descending: true, rebalanceEvery: 1, rebalanceUnit: 'bar', weighting: 'equal', grossWeight: 1 } }));
  const expression = parsed.strategy.kind === 'rank' ? parsed.strategy.score : close;
  const evaluator = new StrategyEvaluator(normalizeDataset(data), parsed);
  assert.equal(evaluator.isMember('AAA'), false);
  assert.equal(evaluator.isMember('BBB'), false);
  evaluator.step(new Map([['AAA', 0], ['BBB', 0], ['CCC', 0]]), closeAt(sessions[0]!), state);
  assert.equal(evaluator.isMember('AAA'), true);
  assert.equal(evaluator.isMember('BBB'), false);
  assert.equal(evaluator.isMember('CCC'), true);
  near(evaluator.symbols.map(symbol => evaluator.value(expression, symbol)), [1, NaN, 2]);
  evaluator.step(new Map([['AAA', 1], ['BBB', 1], ['CCC', 1]]), closeAt(sessions[1]!), state);
  assert.equal(evaluator.isMember('BBB'), true);
  assert.equal(evaluator.isMember('CCC'), false);
  near(evaluator.symbols.map(symbol => evaluator.value(expression, symbol)), [2, 1, NaN]);
});

test('stale securities do not affect current cross sections and constant zscore is missing', () => {
  const parsed = parseSpec(spec({ strategy: { kind: 'rules', nodes: {
    rank: { op: 'rank', args: [close] }, z: { op: 'zscore', args: [close] },
  }, rules: [{ when: { value: false }, action: { type: 'close' } }] } }));
  const nodes = (parsed.strategy as RulesStrategy).nodes;
  const evaluator = new StrategyEvaluator(normalizeDataset(multiData()), parsed);
  assert.equal(evaluator.isMember('AAA'), true);
  assert.equal(evaluator.isMember('BBB'), true);
  evaluator.step(new Map([['AAA', 0], ['BBB', 0], ['CCC', 0]]), closeAt(sessions[0]!), state);
  evaluator.step(new Map([['AAA', 1]]), closeAt(sessions[1]!), state);
  assert.equal(evaluator.value(nodes.rank!, 'AAA'), 1);
  assert.ok(Number.isNaN(evaluator.value(nodes.z!, 'AAA')));
});

test('universe changes are visible even when a constituent has no new bar', () => {
  const data = multiData();
  data.metadata.universeMode = 'point_in_time';
  data.membership = [
    { symbol: 'AAA', availableAt: closeAt(sessions[0]!), member: true },
    { symbol: 'AAA', availableAt: closeAt(sessions[1]!), member: false },
  ];
  const parsed = parseSpec(spec({ strategy: { kind: 'rules', nodes: {}, rules: [{ when: { value: true }, action: { type: 'close' } }] } }));
  const evaluator = new StrategyEvaluator(normalizeDataset(data), parsed);
  evaluator.step(new Map([['AAA', 0], ['BBB', 0]]), closeAt(sessions[0]!), state);
  assert.equal(evaluator.isMember('AAA'), true);
  evaluator.step(new Map([['BBB', 1]]), closeAt(sessions[1]!), state);
  assert.equal(evaluator.isMember('AAA'), false);
});

test('state-dependent rolling expressions consume the current runtime state', () => {
  const parsed = parseSpec(spec({ strategy: { kind: 'rules', nodes: {
    position: { state: 'position' }, average: { op: 'sma', args: [{ state: 'position' }], period: 2 },
    held: { op: 'gte', args: [{ state: 'holding_sessions' }, { value: 2 }] },
  }, rules: [{ when: { value: false }, action: { type: 'close' } }] } }));
  const nodes = (parsed.strategy as RulesStrategy).nodes;
  const evaluator = new StrategyEvaluator(normalizeDataset(input()), parsed);
  const states = [0, 100, 50];
  const averages = [NaN, 50, 75];
  for (let i = 0; i < 3; i++) {
    evaluator.step(new Map([['AAA', i]]), closeAt(sessions[i]!), () => ({ ...emptyState, position: states[i]!, holding_sessions: i }));
    assert.equal(evaluator.value(nodes.position!, 'AAA'), states[i]);
    near([evaluator.value(nodes.average!, 'AAA')], [averages[i]!]);
    assert.equal(evaluator.value(nodes.held!, 'AAA'), Number(i >= 2));
  }
});

test('time.at exposes the current completed batch timestamp for window gates', () => {
  const result = run({ at: { time: 'at' }, inWindow: { op: 'and', args: [
    { op: 'gte', args: [{ time: 'at' }, { value: closeAt(sessions[1]!) }] },
    { op: 'lt', args: [{ time: 'at' }, { value: closeAt(sessions[3]!) }] },
  ] } });
  near(result.output.get('at')!, sessions.map(closeAt));
  near(result.output.get('inWindow')!, [0, 1, 1, 0, 0, 0, 0, 0]);
});

test('appending future bars or features does not change historical evaluations', () => {
  const short = input(['10', '12', '11', '14']);
  const long = input(['10', '12', '11', '14', '50', '100', '1', '20']);
  short.features = [{ symbol: 'AAA', name: 'pe', availableAt: closeAt(sessions[1]!), value: 12 }];
  long.features = [...short.features, { symbol: 'AAA', name: 'pe', availableAt: closeAt(sessions[5]!), value: 999 }];
  const nodes: Record<string, Expression> = {
    ema: { op: 'ema', args: [close], period: 2 },
    relative: { op: 'div', args: [close, { feature: 'pe' }] },
    cross: { op: 'cross_up', args: [close, { op: 'ema', args: [close], period: 2 }] },
  };
  const before = run(nodes, short).output, after = run(nodes, long).output;
  for (const name of Object.keys(nodes)) near(before.get(name)!, after.get(name)!.slice(0, 4));
});

test('structurally identical indicators are deduplicated at compile time', () => {
  const { evaluator } = run({
    a: { op: 'sma', args: [{ field: 'close' }], period: 3 },
    b: { op: 'sma', args: [{ field: 'close' }], period: 3 },
    c: { ref: 'a' },
  });
  assert.equal(evaluator.nodeCount, 3); // close, SMA, false predicate
});

test('future bars, repeated batches and skipped history are rejected', () => {
  const parsed = parseSpec(spec({ strategy: { kind: 'rules', nodes: { close }, rules: [{ when: { value: false }, action: { type: 'close' } }] } }));
  const evaluator = new StrategyEvaluator(normalizeDataset(input()), parsed);
  const fail = (callback: () => void, code: string) => assert.throws(callback, (e: unknown) => e instanceof BacktestError && e.code === code);
  fail(() => evaluator.step(new Map([['AAA', 1]]), closeAt(sessions[0]!), state), 'FUTURE_DATA');
  evaluator.step(new Map([['AAA', 0]]), closeAt(sessions[0]!), state);
  fail(() => evaluator.step(new Map([['AAA', 0]]), closeAt(sessions[0]!), state), 'INVALID_EVALUATION_TIME');
  fail(() => evaluator.step(new Map([['AAA', 2]]), closeAt(sessions[2]!), state), 'SKIPPED_BAR');
  fail(() => evaluator.step(new Map([['UNKNOWN', 1]]), closeAt(sessions[1]!), state), 'UNKNOWN_INSTRUMENT');
});
