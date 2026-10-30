import assert from 'node:assert/strict';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { BacktestError } from '../src/spec/errors.js';
import { backtestSpecJsonSchema, metadataJsonSchema, parseSpec, validateDatasetMetadata } from '../src/spec/validate.js';
import type { BacktestSpec, Expression, RulesStrategy } from '../src/spec/types.js';
import { input, spec } from './helpers.js';

function rejects(value: unknown, code?: string): void {
  assert.throws(() => parseSpec(value), (error: unknown) => {
    assert.ok(error instanceof BacktestError);
    if (code) assert.equal(error.code, code);
    assert.ok(error.path.startsWith('/') || error.path === '');
    return true;
  });
}

function rule(when: Expression, nodes: Record<string, Expression> = {}): BacktestSpec {
  return spec({ strategy: { kind: 'rules', nodes, rules: [{ when, action: { type: 'target_weight', value: 0.5 } }] } });
}

test('JSON and YAML share normalization without changing the caller input', () => {
  const original = spec();
  original.account.initialCash = '001000.00';
  original.costs.periods[0]!.commissionRate = '0.0000';
  const json = parseSpec(JSON.parse(JSON.stringify(original)));
  const yaml = parseSpec(parseYaml(stringifyYaml(original)));
  assert.deepEqual(json, yaml);
  assert.equal(json.account.initialCash, '1000');
  assert.equal(json.costs.periods[0]!.commissionRate, '0');
  assert.equal(original.account.initialCash, '001000.00');
});

test('only nonfinancial runtime controls receive defaults', () => {
  const value: Record<string, unknown> = { ...spec() };
  delete value.output;
  delete value.limits;
  delete value.seed;
  const normalized = parseSpec(value);
  assert.equal(normalized.output.level, 'summary');
  assert.equal(normalized.seed, 1);
  assert.equal(normalized.limits.maxNodes, 1024);
  for (const required of ['account', 'strategy', 'costs', 'execution', 'analytics', 'start', 'end']) {
    const missing = { ...value };
    delete missing[required];
    rejects(missing, 'INVALID_SPEC');
  }
});

test('unknown top-level, nested and unsupported execution fields are rejected', () => {
  rejects({ ...spec(), leverage: 2 }, 'INVALID_SPEC');
  const value = spec();
  rejects({ ...value, execution: { ...value.execution, fillAt: 'same_bar_close' } }, 'INVALID_SPEC');
  rejects({ ...value, account: { ...value.account, margin: true } }, 'INVALID_SPEC');
  rejects(rule({ field: 'close', period: 2 } as Expression), 'INVALID_SPEC');
});

test('timestamps are finite integer milliseconds and end is exclusive', () => {
  rejects(spec({ start: NaN }), 'INVALID_SPEC');
  rejects(spec({ end: Infinity }), 'INVALID_SPEC');
  rejects(spec({ start: 0.5 }), 'INVALID_SPEC');
  rejects(spec({ end: spec().start }), 'INVALID_RANGE');
  const value = spec();
  value.strategy = { kind: 'targets', schedule: [{ at: value.end, availableAt: value.end, weights: {} }] };
  rejects(value, 'INVALID_TARGET_TIME');
});

test('cash values remain exact strings and respect account precision', () => {
  const value = spec();
  rejects({ ...value, account: { ...value.account, initialCash: 1000 } }, 'INVALID_SPEC');
  for (const initialCash of ['0', '-1', 'Infinity', '1e3', '10.001']) {
    rejects({ ...value, account: { ...value.account, initialCash } });
  }
  rejects({ ...value, account: { ...value.account, moneyDecimals: 9 } }, 'INVALID_SPEC');
  rejects({ ...value, account: { ...value.account, cashFlows: [{ at: value.start, amount: '0' }] } }, 'INVALID_CASH_FLOW');
  rejects({ ...value, account: { ...value.account, cashFlows: [{ at: value.end, amount: '1' }] } }, 'INVALID_CASH_FLOW_TIME');
  const normalized = parseSpec({ ...value, account: { ...value.account, cashFlows: [{ at: value.start, amount: '-10.20' }] } });
  assert.equal(normalized.account.cashFlows[0]!.amount, '-10.2');
});

test('cost periods must cover the interval without overlapping or gaps', () => {
  const value = spec();
  const zero = value.costs.periods[0]!;
  const midpoint = Math.floor((value.start + value.end) / 2);
  const periods = [{ ...zero, from: 0, to: midpoint }, { ...zero, from: midpoint }];
  assert.equal(parseSpec({ ...value, costs: { ...value.costs, periods } }).costs.periods.length, 2);
  rejects({ ...value, costs: { ...value.costs, periods: [{ ...zero, to: midpoint }, { ...zero, from: midpoint - 1 }] } }, 'OVERLAPPING_COST_PERIODS');
  rejects({ ...value, costs: { ...value.costs, periods: [{ ...zero, to: midpoint }, { ...zero, from: midpoint + 1 }] } }, 'COST_PERIOD_GAP');
  rejects({ ...value, costs: { ...value.costs, periods: [{ ...zero, to: value.end - 1 }] } }, 'COST_PERIOD_GAP');
  rejects({ ...value, costs: { ...value.costs, periods: [{ ...zero, from: midpoint, to: midpoint }] } }, 'INVALID_COST_PERIOD');
});

test('cost rates and minimum commission are checked independently', () => {
  const value = spec();
  for (const commissionRate of ['-0.1', '1', '2', '0.0000000000000000001']) {
    rejects({ ...value, costs: { ...value.costs, periods: [{ ...value.costs.periods[0]!, commissionRate }] } });
  }
  rejects({ ...value, costs: { ...value.costs, periods: [{ ...value.costs.periods[0]!, minimumCommission: '0.001' }] } }, 'INVALID_PRECISION');
});

test('targets cannot contain future information, leverage or short positions', () => {
  const value = spec();
  const at = value.start + 1000;
  const target = (change: object) => ({ ...value, strategy: { kind: 'targets', schedule: [{ at, availableAt: at, weights: { AAA: 1 }, ...change }] } });
  rejects(target({ availableAt: at + 1 }), 'FUTURE_DATA');
  rejects(target({ weights: { AAA: 0.6, BBB: 0.5 } }), 'LEVERAGE_NOT_SUPPORTED');
  rejects(target({ weights: { AAA: -0.1 } }), 'INVALID_SPEC');
  rejects(target({ quantities: { AAA: 1 } }), 'INVALID_TARGET');
  rejects(target({ weights: undefined, quantities: undefined }), 'INVALID_TARGET');
  rejects(target({ weights: undefined, quantities: { AAA: 0.5 } }), 'INVALID_SPEC');
  assert.equal(parseSpec(target({ weights: { A: 0.1, B: 0.2, C: 0.7 } })).strategy.kind, 'targets');
  assert.equal(parseSpec(target({ weights: {} })).strategy.kind, 'targets');
});

test('target chronology is strict but replay allows multiple fills at one timestamp', () => {
  const value = spec();
  const point = { at: value.start + 1, availableAt: value.start, weights: { AAA: 1 } };
  rejects({ ...value, strategy: { kind: 'targets', schedule: [point, point] } }, 'INVALID_TARGET_TIME');
  const fill = { at: value.start + 1, symbol: 'AAA', side: 'buy', quantity: 1, price: '10', fees: '0' };
  assert.equal(parseSpec({ ...value, strategy: { kind: 'replay', feePolicy: 'provided', fills: [fill, fill] } }).strategy.kind, 'replay');
});

test('replay requires an explicit fee policy and refuses out-of-range fills', () => {
  const value = spec();
  const fill = { at: value.start + 1, symbol: 'AAA', side: 'buy', quantity: 1, price: '10' };
  const replay = (feePolicy: string, fills: object[]) => ({ ...value, strategy: { kind: 'replay', feePolicy, fills } });
  rejects(replay('provided', [fill]), 'INVALID_REPLAY_FEES');
  rejects(replay('recalculate', [{ ...fill, fees: '0' }]), 'INVALID_REPLAY_FEES');
  rejects(replay('recalculate', [{ ...fill, at: value.end }]), 'INVALID_REPLAY_TIME');
  rejects(replay('recalculate', [{ ...fill, price: '0' }]), 'INVALID_DECIMAL');
  rejects(replay('recalculate', [fill, { ...fill, at: value.start }]), 'INVALID_REPLAY_TIME');
  assert.equal(parseSpec(replay('recalculate', [fill])).strategy.kind, 'replay');
});

test('expression graph checks references, cycles and all unused nodes', () => {
  rejects(rule({ ref: 'missing' }), 'UNKNOWN_REFERENCE');
  rejects(rule({ value: true }, { a: { ref: 'b' }, b: { ref: 'a' } }), 'CYCLIC_EXPRESSION');
  rejects(rule({ value: true }, { unused: { ref: 'missing' } }), 'UNKNOWN_REFERENCE');
  assert.equal(parseSpec(rule({ ref: 'buy' }, {
    fast: { op: 'sma', args: [{ field: 'close' }], period: 5 },
    slow: { op: 'ema', args: [{ field: 'close' }], period: 20 },
    buy: { op: 'cross_up', args: [{ ref: 'fast' }, { ref: 'slow' }] },
  })).strategy.kind, 'rules');
});

test('expression operators enforce arity, applicable parameters and argument types', () => {
  rejects(rule({ op: 'gt', args: [{ value: 1 }] }), 'INVALID_ARITY');
  rejects(rule({ op: 'and', args: [{ value: true }] }), 'INVALID_ARITY');
  rejects(rule({ op: 'gt', args: [{ value: true }, { value: 1 }] }), 'EXPRESSION_TYPE');
  rejects(rule({ op: 'gt', args: [{ value: 1 }, { value: 2 }], period: 5 }), 'INVALID_OPERATOR_PARAMETER');
  rejects(rule({ op: 'gt', args: [{ op: 'sma', args: [{ field: 'close' }] }, { value: 2 }] }), 'MISSING_OPERATOR_PARAMETER');
  rejects(rule({ value: 1 }), 'EXPRESSION_TYPE');
  rejects(rule({ op: 'if', args: [{ value: true }, { value: true }, { value: 1 }] }), 'EXPRESSION_TYPE');
  assert.equal(parseSpec(rule({ op: 'if', args: [{ value: true }, { value: true }, { value: false }] })).strategy.kind, 'rules');
});

test('indicator-specific contracts include ATR and complete MACD parameters', () => {
  const numeric = (expr: Expression) => rule({ op: 'gt', args: [expr, { value: 0 }] });
  assert.equal(parseSpec(numeric({ op: 'atr', args: [], period: 14 })).strategy.kind, 'rules');
  rejects(numeric({ op: 'atr', args: [{ field: 'close' }], period: 14 }), 'INVALID_ARITY');
  rejects(numeric({ op: 'ema', args: [{ field: 'close' }], period: 0 }), 'INVALID_SPEC');
  rejects(numeric({ op: 'rolling_quantile', args: [{ feature: 'pe' }], period: 20 }), 'MISSING_OPERATOR_PARAMETER');
  rejects(numeric({ op: 'macd', args: [{ field: 'close' }], fast: 26, slow: 12, signal: 9 }), 'INVALID_OPERATOR_PARAMETER');
  assert.equal(parseSpec(numeric({ op: 'macd_hist', args: [{ field: 'close' }], fast: 12, slow: 26, signal: 9 })).strategy.kind, 'rules');
});

test('ranking score must be numeric and filtering must be boolean', () => {
  const ranking = { kind: 'rank', nodes: {}, score: { op: 'rank', args: [{ feature: 'pe' }] },
    filter: { op: 'gt', args: [{ field: 'volume' }, { value: 0 }] }, topK: 10, descending: true,
    rebalanceEvery: 1, rebalanceUnit: 'month', weighting: 'equal', grossWeight: 1 };
  assert.equal(parseSpec({ ...spec(), strategy: ranking }).strategy.kind, 'rank');
  rejects({ ...spec(), strategy: { ...ranking, score: { value: true } } }, 'EXPRESSION_TYPE');
  rejects({ ...spec(), strategy: { ...ranking, filter: { value: 1 } } }, 'EXPRESSION_TYPE');
});

test('order actions distinguish market and priced orders', () => {
  const value = rule({ value: true });
  const strategy = value.strategy as RulesStrategy;
  const action = { type: 'order', side: 'buy', quantity: 100, orderType: 'limit', tif: 'day' };
  const make = (change: object) => ({ ...value, strategy: { ...strategy, rules: [{ when: { value: true }, action: { ...action, ...change } }] } });
  rejects(make({}), 'INVALID_ORDER');
  rejects(make({ price: '0' }), 'INVALID_DECIMAL');
  rejects(make({ orderType: 'market', price: '10' }), 'INVALID_ORDER');
  rejects(make({ price: '10', quantity: -1 }), 'INVALID_SPEC');
  assert.equal(parseSpec(make({ price: '10.00' })).strategy.kind, 'rules');
});

test('cyclic objects, deep trees and excessive expression budgets fail safely', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejects(cycle, 'CYCLIC_INPUT');
  let expression: Expression = { value: true };
  for (let i = 0; i < 100; i++) expression = { op: 'not', args: [expression] };
  rejects(rule(expression), 'INPUT_TOO_DEEP');
  const value = rule({ op: 'gt', args: [{ field: 'close' }, { value: 10 }] });
  value.limits.maxNodes = 2;
  rejects(value, 'EXPRESSION_LIMIT');
  rejects(JSON.parse('{"__proto__":{}}'), 'INVALID_KEY');
  rejects(new Date(), 'INVALID_INPUT');
});

test('dataset metadata validates actual dates, currency and tick precision', () => {
  const metadata = input().metadata;
  assert.equal(validateDatasetMetadata(metadata).instruments[0]!.tickSize, '0.01');
  const bad = (change: object, code: string) => assert.throws(() => validateDatasetMetadata({ ...metadata, ...change }),
    (error: unknown) => error instanceof BacktestError && error.code === code);
  bad({ sessions: ['2024-02-30'] }, 'INVALID_SESSION');
  bad({ sessions: ['2024-01-02', '2024-01-02'] }, 'INVALID_CALENDAR');
  bad({ timezone: 'Not/AZone' }, 'INVALID_TIMEZONE');
  bad({ instruments: [...metadata.instruments, ...metadata.instruments] }, 'DUPLICATE_SYMBOL');
  bad({ instruments: [{ ...metadata.instruments[0]!, currency: 'USD' }] }, 'MULTI_CURRENCY_NOT_SUPPORTED');
  bad({ instruments: [{ ...metadata.instruments[0]!, tickSize: '0' }] }, 'INVALID_DECIMAL');
  bad({ instruments: [{ ...metadata.instruments[0]!, tickSize: '0.0000000000000000001' }] }, 'INVALID_PRECISION');
  bad({ priceAdjustment: 'forward' }, 'INVALID_SPEC');
});

test('machine-readable input schemas are published with no unknown top-level keys', () => {
  assert.equal(backtestSpecJsonSchema.type, 'object');
  assert.equal(backtestSpecJsonSchema.additionalProperties, false);
  assert.equal(metadataJsonSchema.type, 'object');
  assert.ok(JSON.stringify(backtestSpecJsonSchema).includes('next_bar_open'));
});
