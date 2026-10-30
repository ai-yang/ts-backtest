import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDataset } from '../src/data/normalize.js';
import { runBacktest } from '../src/engine/run.js';
import type { DatasetInput, Expression, RulesStrategy } from '../src/spec/types.js';
import { bar, closeAt, input, instrument, openAt, sessions, spec } from './helpers.js';

const always: Expression = { value: true };
const held: Expression = { op: 'gt', args: [{ state: 'position' }, { value: 0 }] };
const flat: Expression = { op: 'eq', args: [{ state: 'position' }, { value: 0 }] };
const buyTen: RulesStrategy = { kind: 'rules', nodes: {}, rules: [{ when: always, action: { type: 'target_quantity', value: 10 } }] };

function minuteData(): DatasetInput {
  const data = input();
  data.metadata.frequency = 'minute';
  data.bars = ['10', '11', '12', '13'].map((price, i) => bar(sessions[0]!, price, {
    openTime: openAt(sessions[0]!) + i * 60_000,
    closeTime: openAt(sessions[0]!) + (i + 1) * 60_000,
    volume: i === 1 ? 1 : 100,
  }));
  return data;
}

test('engine warms indicators from pre-start bars without trading before start', () => {
  const data = input(['1', '2', '3', '4', '5', '6']);
  const strategy: RulesStrategy = { kind: 'rules', nodes: {
    mean: { op: 'sma', args: [{ field: 'close' }], period: 3 },
  }, rules: [{ when: { op: 'gte', args: [{ ref: 'mean' }, { value: 2 }] }, action: { type: 'target_quantity', value: 10 } }] };
  const result = runBacktest(normalizeDataset(data), spec({ start: openAt(sessions[2]!), end: closeAt(sessions[5]!) + 1, strategy }));
  assert.equal(result.orders[0]!.submittedAt, closeAt(sessions[2]!));
  assert.equal(result.fills[0]!.at, openAt(sessions[3]!));
  assert.equal(result.fills[0]!.price, '4');
  assert.equal(result.fills[0]!.quantity, 10);
  assert.ok(result.orders.every(order => order.submittedAt >= result.spec.start));
  assert.ok(result.events.every(event => event.type === 'initial' || event.at >= result.spec.start));
});

test('same-timestamp minute close decisions fill at the adjacent next-minute open', () => {
  const data = minuteData();
  const result = runBacktest(normalizeDataset(data), spec({ strategy: buyTen, end: data.bars.at(-1)!.closeTime + 1 }));
  assert.equal(data.bars[0]!.closeTime, data.bars[1]!.openTime);
  assert.equal(result.orders[0]!.submittedAt, data.bars[0]!.closeTime);
  assert.equal(result.fills[0]!.at, data.bars[1]!.openTime);
  assert.equal(result.fills[0]!.price, '11');
  assert.equal(result.fills[0]!.quantity, 10); // previous bar volume 100, not future current-bar volume 1
  assert.equal(result.fills.length, 1);
});

test('feature observations cannot trigger orders before publication', () => {
  const data = input(['10', '10', '10', '10', '10']);
  data.features = [{ symbol: 'AAA', name: 'pe_signal', availableAt: closeAt(sessions[2]!) + 1, value: 1 }];
  const strategy: RulesStrategy = { kind: 'rules', nodes: {}, rules: [{
    when: { op: 'and', args: [flat, { op: 'gt', args: [{ feature: 'pe_signal' }, { value: 0 }] }] },
    action: { type: 'target_quantity', value: 10 },
  }] };
  const result = runBacktest(normalizeDataset(data), spec({ strategy }));
  assert.equal(result.orders[0]!.submittedAt, closeAt(sessions[3]!));
  assert.equal(result.fills[0]!.at, openAt(sessions[4]!));
  assert.equal(result.fills.length, 1);
});

test('PIT ranking waits for membership and feature publication then rebalances together', () => {
  const data = input(['10', '10', '10', '10', '10']);
  data.metadata.instruments.push(instrument('BBB'));
  data.metadata.universeMode = 'point_in_time';
  data.bars.push(...sessions.slice(0, 5).map(day => bar(day, '10', { symbol: 'BBB' })));
  data.membership = [
    { symbol: 'AAA', availableAt: closeAt(sessions[0]!), member: true },
    { symbol: 'BBB', availableAt: closeAt(sessions[1]!), member: true },
  ];
  data.features = [
    { symbol: 'AAA', name: 'score', availableAt: closeAt(sessions[0]!), value: 1 },
    { symbol: 'BBB', name: 'score', availableAt: closeAt(sessions[2]!), value: 10 },
  ];
  const result = runBacktest(normalizeDataset(data), spec({ strategy: { kind: 'rank', nodes: {},
    score: { op: 'rank', args: [{ feature: 'score' }] }, topK: 1, descending: true,
    rebalanceEvery: 1, rebalanceUnit: 'session', weighting: 'equal', grossWeight: 0.5,
  } }));
  const purchases = result.fills.filter(fill => fill.side === 'buy');
  assert.deepEqual(purchases.map(fill => [fill.symbol, fill.at]), [['AAA', openAt(sessions[1]!)], ['BBB', openAt(sessions[3]!)]]);
  assert.ok(result.fills.some(fill => fill.side === 'sell' && fill.symbol === 'AAA' && fill.at === openAt(sessions[3]!)));
});

test('removal from a PIT universe blocks entry but still allows a held position to exit', () => {
  const data = input(['10', '10', '10', '10', '10']);
  data.metadata.universeMode = 'point_in_time';
  data.membership = [
    { symbol: 'AAA', availableAt: closeAt(sessions[0]!), member: true },
    { symbol: 'AAA', availableAt: closeAt(sessions[1]!), member: false },
  ];
  const strategy: RulesStrategy = { kind: 'rules', nodes: {}, rules: [
    { when: flat, action: { type: 'target_quantity', value: 10 } },
    { when: held, action: { type: 'close' } },
  ] };
  const result = runBacktest(normalizeDataset(data), spec({ strategy }));
  assert.deepEqual(result.fills.map(fill => [fill.side, fill.at]), [['buy', openAt(sessions[1]!)], ['sell', openAt(sessions[2]!)]]);
});

test('daily DAY orders expire in submission session while GTC targets survive to next open', () => {
  const day: RulesStrategy = { kind: 'rules', nodes: {}, rules: [{ when: flat,
    action: { type: 'order', side: 'buy', orderType: 'market', quantity: 1, tif: 'day' },
  }] };
  const result = runBacktest(normalizeDataset(input()), spec({ strategy: day }));
  assert.equal(result.fills.length, 0);
  assert.ok(result.orders.length > 0);
  assert.ok(result.orders.every(order => order.status === 'expired' && order.reason === 'DAY_EXPIRED'));
  const gtc = runBacktest(normalizeDataset(input()), spec({ strategy: buyTen }));
  assert.equal(gtc.fills[0]!.at, openAt(sessions[1]!));
});

test('a close exactly at end cannot improve terminal valuation', () => {
  const data = input(['10', '100']);
  data.bars[1]!.open = '10';
  data.bars[1]!.low = '10';
  const result = runBacktest(normalizeDataset(data), spec({ strategy: buyTen, end: closeAt(sessions[1]!) }));
  assert.equal(result.fills[0]!.price, '10');
  assert.equal(result.metrics.finalEquity, '1000.00');
  assert.ok(result.equity.every(point => point.at < result.spec.end));
});

test('appending future data and publications does not change historical orders and fills', () => {
  const before = input(['10', '12', '11']);
  const after = input(['10', '12', '11', '100', '1']);
  before.features = [{ symbol: 'AAA', name: 'factor', availableAt: closeAt(sessions[0]!), value: 1 }];
  after.features = [...before.features, { symbol: 'AAA', name: 'factor', availableAt: closeAt(sessions[3]!), value: -100 }];
  const strategy: RulesStrategy = { kind: 'rules', nodes: { mean: { op: 'ema', args: [{ field: 'close' }], period: 2 } },
    rules: [{ when: { op: 'and', args: [
      { op: 'gt', args: [{ ref: 'mean' }, { value: 0 }] },
      { op: 'gt', args: [{ feature: 'factor' }, { value: 0 }] },
    ] }, action: { type: 'target_quantity', value: 10 } }],
  };
  const configuration = spec({ strategy, end: closeAt(sessions[2]!) + 1 });
  const a = runBacktest(normalizeDataset(before), configuration);
  const b = runBacktest(normalizeDataset(after), configuration);
  assert.deepEqual(a.orders, b.orders);
  assert.deepEqual(a.fills, b.fills);
  assert.deepEqual(a.equity, b.equity);
  assert.deepEqual(a.metrics, b.metrics);
});

test('explicit targets cannot increase exposure outside the PIT universe', () => {
  const data = input();
  data.metadata.universeMode = 'point_in_time';
  data.membership = [{ symbol: 'AAA', availableAt: closeAt(sessions[2]!), member: true }];
  const result = runBacktest(normalizeDataset(data), spec({ strategy: {
    kind: 'targets', schedule: [{ at: closeAt(sessions[0]!), availableAt: closeAt(sessions[0]!), quantities: { AAA: 10 } }],
  } }));
  assert.equal(result.fills.length, 0);
  assert.equal(result.orders[0]!.status, 'rejected');
  assert.equal(result.orders[0]!.reason, 'OUTSIDE_UNIVERSE');
});
