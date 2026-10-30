import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/accounting/ledger.js';
import { EquityStatistics } from '../src/analytics/equity-statistics.js';
import { maximumDrawdown } from '../src/analytics/metrics.js';
import { statisticalDifference } from '../src/analytics/numeric.js';
import { normalizeDataset } from '../src/data/normalize.js';
import { runBacktest } from '../src/engine/run.js';
import type { EquityPoint, Order } from '../src/spec/types.js';
import { input, spec, sessions, openAt, closeAt } from './helpers.js';

test('a split-created exact high cannot be lowered by a double-rounded tick product', () => {
  const raw = input(['700', '700', '700', '700', '700']); raw.metadata.instruments[0]!.tickSize = '0.07';
  const configuration = spec(), ledger = new Ledger(configuration, normalizeDataset(raw));
  const order: Order = { id: 'one', symbol: 'AAA', side: 'buy', type: 'market', quantity: 1, remaining: 1, submittedAt: configuration.start, tif: 'gtc', status: 'accepted', cumulativeNotional: '0', commissionAccruedRaw: '0', commissionPaid: '0', source: 'test' };
  ledger.setMarkTicks('AAA', 10001, configuration.start, 0);
  ledger.fill(order, 1, '700.07', configuration.start, 0);
  ledger.corporateAction({ symbol: 'AAA', type: 'split', at: openAt(sessions[1]!), ratio: '1.000099999999999943', cashInLieuPrice: '0' }, 1);
  const high = ledger.holdingHighExact('AAA'); assert.ok(high.gt(700));
  assert.equal(10000 * 0.07, 700.0000000000001);
  ledger.observeHighTicks('AAA', 10000);
  assert.equal(ledger.holdingHighExact('AAA').toFixed(), high.toFixed());
});

test('zero-cost round trips at an unchanged price cannot manufacture drawdown or volatility', () => {
  const raw = input(['700', '700', '700', '700', '700']); raw.metadata.instruments[0]!.tickSize = '0.07';
  const result = runBacktest(normalizeDataset(raw), spec());
  assert.equal(result.metrics.netProfit, '0.00');
  assert.equal(result.metrics.timeWeightedReturn, 0);
  assert.equal(result.metrics.maxDrawdownPct.value, 0);
  assert.equal(result.metrics.rawEquityDrawdownPct.value, 0);
  assert.equal(result.metrics.maxDrawdownAmount.value, 0);
  assert.equal(result.metrics.annualizedVolatility, 0);
  assert.equal(result.metrics.sharpe, null);
  assert.equal(result.metrics.sortino, null);
  assert.equal(result.metrics.drawdownCoverage.status, 'complete');
});

test('statistical tolerance is relative only and preserves representable economic changes', () => {
  assert.equal(statisticalDifference(1000.0000000000001, 1000), 0);
  assert.ok(statisticalDifference(1000.000001, 1000) > 0);
  assert.ok(statisticalDifference(2e-18, 1e-18) > 0);
  const points = [100, 80, 120, 90, 120].map((equity, at): EquityPoint => ({ at, session: String(at), equity, cash: equity, marketValue: 0, receivables: 0, externalFlow: 0, unitNav: equity / 100, staleSymbols: [] }));
  const stats = new EquityStatistics(); points.forEach(point => stats.add(point));
  assert.deepEqual(stats.rawEquityDrawdownPct(), maximumDrawdown(points, 'equity', true));
  assert.deepEqual(stats.drawdownAmount(), { value: 30, peakAt: 2, troughAt: 3, recoveredAt: 4 });
});

test('withdrawal exposes independent raw-equity percentage and monetary drawdowns alongside NAV drawdown', () => {
  const configuration = spec(); configuration.account = { ...configuration.account, initialCash: '100', cashFlows: [{ at: openAt(sessions[1]!), amount: '-20' }] };
  configuration.strategy = { kind: 'rules', nodes: {}, rules: [{ when: { value: false }, action: { type: 'close' } }] };
  const result = runBacktest(normalizeDataset(input()), configuration);
  assert.equal(result.metrics.rawEquityDrawdownPct.value, 0.2);
  assert.equal(result.metrics.rawEquityDrawdownPct.peakAt, configuration.start);
  assert.equal(result.metrics.rawEquityDrawdownPct.troughAt, openAt(sessions[1]!));
  assert.equal(result.metrics.rawEquityDrawdownPct.recoveredAt, null);
  assert.equal(result.metrics.maxDrawdownAmount.value, 20);
  assert.equal(result.metrics.maxDrawdownPct.value, 0);
  assert.equal(result.metrics.drawdownCoverage.status, 'complete');
});

test('replay with one quote session reports incomplete full-period risk even below stale threshold', () => {
  const raw = input(); raw.bars = raw.bars.slice(0, 1);
  const configuration = spec({ strategy: { kind: 'replay', feePolicy: 'provided', fills: [{ at: openAt(sessions[0]!), symbol: 'AAA', side: 'buy', quantity: 10, price: '10', fees: '0' }] } });
  const result = runBacktest(normalizeDataset(raw), configuration);
  assert.equal(result.metrics.finalEquity, '1000.00');
  assert.equal(result.metrics.drawdownCoverage.status, 'incomplete');
  assert.equal(result.metrics.drawdownCoverage.scope, 'observed_marks');
  assert.equal(result.metrics.drawdownCoverage.missingSessions, 4);
  assert.match(result.metrics.unavailable.maxDrawdownPct!, /not full-period risk/);
  assert.ok(result.warnings.some(warning => warning.code === 'INCOMPLETE_VALUATION_COVERAGE'));
  const cashOnly = runBacktest(normalizeDataset(raw), spec({ strategy: { kind: 'replay', feePolicy: 'provided', fills: [] } }));
  assert.equal(cashOnly.metrics.drawdownCoverage.status, 'complete');
});

test('a missing held session stays in coverage after quotes resume and after liquidation', () => {
  const raw = input(); raw.bars.splice(1, 1);
  const result = runBacktest(normalizeDataset(raw), spec({ strategy: { kind: 'replay', feePolicy: 'provided', fills: [
    { at: openAt(sessions[0]!), symbol: 'AAA', side: 'buy', quantity: 10, price: '10', fees: '0' },
    { at: openAt(sessions[2]!), symbol: 'AAA', side: 'sell', quantity: 10, price: '12', fees: '0' },
  ] } }));
  assert.equal(result.metrics.drawdownCoverage.status, 'incomplete');
  assert.equal(result.metrics.drawdownCoverage.missingSessions, 1);
  assert.equal(result.metrics.drawdownCoverage.examples[0]!.fromSession, sessions[1]);
});

test('minute quote completeness is not claimed without a validated cadence; phase timing does not alter outcomes', () => {
  const raw = input(); raw.metadata.frequency = 'minute';
  raw.bars.forEach(bar => { bar.closeTime = bar.openTime + 60_000; });
  const dataset = normalizeDataset(raw), configuration = spec({ end: raw.bars.at(-1)!.closeTime + 1, strategy: { kind: 'rules', nodes: {}, rules: [{ when: { value: true }, action: { type: 'target_quantity', value: 1 } }] } });
  const a = runBacktest(dataset, configuration), b = runBacktest(dataset, configuration, { measurePhases: true });
  assert.equal(a.metrics.drawdownCoverage.status, 'unverified');
  assert.match(a.metrics.unavailable.maxDrawdownAmount!, /Intraday/);
  assert.deepEqual(a.metrics, b.metrics); assert.deepEqual(a.fills, b.fills);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.timing.phaseTiming, 'disabled'); assert.equal(a.timing.indicatorMs, null);
  assert.equal(b.timing.phaseTiming, 'measured'); assert.ok(b.timing.indicatorMs! >= 0);
});
