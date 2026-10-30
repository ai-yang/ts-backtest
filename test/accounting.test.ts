import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/accounting/ledger.js';
import { calculateMetrics, maximumDrawdown } from '../src/analytics/metrics.js';
import { normalizeDataset } from '../src/data/normalize.js';
import type { BacktestSpec, EquityPoint, Order } from '../src/spec/types.js';
import { input, instrument, spec, sessions, openAt, closeAt } from './helpers.js';

function order(side: 'buy' | 'sell', quantity: number, id = 'test-order'): Order {
  return { id, symbol: 'AAA', side, type: 'market', quantity, remaining: quantity, submittedAt: 0, tif: 'gtc', status: 'accepted', cumulativeNotional: '0', commissionAccruedRaw: '0', commissionPaid: '0', source: 'test' };
}
function account(options: { initialCash?: string; settlement?: number; costs?: BacktestSpec['costs'] } = {}) {
  const data = input();
  data.metadata.instruments = [instrument('AAA', { settlementDays: options.settlement ?? 0 })];
  const specification = spec();
  specification.account.initialCash = options.initialCash ?? '1000';
  if (options.costs) specification.costs = options.costs;
  const dataset = normalizeDataset(data);
  return { ledger: new Ledger(specification, dataset), specification, dataset };
}

test('AC-11 exact half-up charges and consideration reconcile to cash', () => {
  const { ledger } = account({ costs: { version: 'half-up', scope: 'fill', periods: [{ from: 0, commissionRate: '0.005', minimumCommission: '0', sellTaxRate: '0', transferRate: '0' }] } });
  const fill = ledger.fill(order('buy', 1), 1, '1', openAt(sessions[0]!), 0);
  assert.equal(fill.fees.commission, '0.01');
  assert.equal(fill.cashAfter, '998.99');
  assert.equal(ledger.events.at(-1)!.cashDelta, '-1.01');
});

test('AC-12 commission minimum is charged once across partial fills', () => {
  const { ledger } = account({ initialCash: '2000', costs: { version: 'minimum', scope: 'order', periods: [{ from: 0, commissionRate: '0.001', minimumCommission: '5', sellTaxRate: '0', transferRate: '0' }] } });
  const buy = order('buy', 100);
  const first = ledger.fill(buy, 40, '10', openAt(sessions[0]!), 0);
  const second = ledger.fill(buy, 60, '10', openAt(sessions[1]!), 1);
  assert.equal(first.fees.commission, '5.00');
  assert.equal(second.fees.commission, '0.00');
  assert.equal(buy.status, 'filled');
  assert.equal(buy.commissionAccruedRaw, '1');
  assert.equal(ledger.money(ledger.cash), '995.00');
});

test('AC-13 cumulative commission preserves earlier rates across schedule transitions', () => {
  const boundary = openAt(sessions[1]!);
  const { ledger } = account({ initialCash: '2000', costs: { version: 'dated', scope: 'order', periods: [
    { from: 0, to: boundary, commissionRate: '0.001', minimumCommission: '0', sellTaxRate: '0', transferRate: '0' },
    { from: boundary, commissionRate: '0.002', minimumCommission: '0', sellTaxRate: '0', transferRate: '0' },
  ] } });
  const buy = order('buy', 100);
  assert.equal(ledger.fill(buy, 40, '10', openAt(sessions[0]!), 0).fees.commission, '0.40');
  assert.equal(ledger.fill(buy, 60, '10', boundary, 1).fees.commission, '1.20');
  assert.equal(buy.commissionPaid, '1.6');
  assert.equal(ledger.money(ledger.cash), '998.40');
});

test('AC-06 sellability follows explicit sessions and failed sells are atomic', () => {
  const { ledger } = account({ settlement: 1 });
  const friday = 3, monday = 4;
  ledger.fill(order('buy', 10), 10, '10', openAt(sessions[friday]!), friday);
  assert.equal(ledger.sellable('AAA', friday), 0);
  assert.equal(ledger.sellable('AAA', monday), 10);
  const sell = order('sell', 10, 'sell');
  assert.throws(() => ledger.fill(sell, 10, '11', closeAt(sessions[friday]!), friday), /sellable/);
  assert.equal(sell.remaining, 10);
  assert.equal(ledger.position('AAA'), 10);
  assert.equal(ledger.money(ledger.cash), '900.00');
  ledger.fill(sell, 10, '11', openAt(sessions[monday]!), monday);
  assert.equal(ledger.money(ledger.cash), '1010.00');
  assert.equal(ledger.roundTrips[0]!.pnl, '10.00');
});

test('calendar settlement horizon and unfunded fills fail before mutations', () => {
  const { ledger, dataset } = account({ settlement: 1 });
  const buy = order('buy', 100);
  assert.throws(() => ledger.fill(buy, 100, '11', openAt(sessions[0]!), 0), /negative/);
  assert.equal(ledger.fills.length, 0);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.money(ledger.cash), '1000.00');
  assert.throws(() => ledger.fill(buy, 100, '10', openAt(sessions.at(-1)!), dataset.metadata.sessions.length - 1), /calendar/);
  assert.equal(buy.remaining, 100);
  assert.equal(ledger.position('AAA'), 0);
});

test('AC-09 affordability reserves exact minimum fees and supports partial fill step', () => {
  const { ledger } = account({ costs: { version: 'minimum', scope: 'order', periods: [{ from: 0, commissionRate: '0', minimumCommission: '5', sellTaxRate: '0', transferRate: '0' }] } });
  const buy = order('buy', 100);
  assert.equal(ledger.affordableQuantity(buy, '12', openAt(sessions[0]!), 100), 82);
  assert.equal(ledger.affordableQuantity(buy, '12', openAt(sessions[0]!), 40, ledger.cash, 1), 40);
});

test('AC-17 dividend receivable is equity but not spendable until payment', () => {
  const { ledger } = account();
  ledger.setMark('AAA', '10', openAt(sessions[0]!), 0);
  ledger.fill(order('buy', 100), 100, '10', openAt(sessions[0]!), 0);
  const accrue = openAt(sessions[1]!), pay = openAt(sessions[3]!);
  ledger.corporateAction({ type: 'dividend', symbol: 'AAA', at: accrue, payAt: pay, amountPerShare: '1' }, 1);
  ledger.setMark('AAA', '9', accrue, 1);
  assert.equal(ledger.money(ledger.equityExact()), '1000.00');
  assert.equal(ledger.money(ledger.cash), '0.00');
  assert.equal(ledger.money(ledger.receivables), '100.00');
  assert.throws(() => ledger.fill(order('buy', 1, 'unfunded'), 1, '9', accrue, 1), /negative/);
  ledger.payDividends(pay);
  assert.equal(ledger.money(ledger.cash), '100.00');
  assert.equal(ledger.money(ledger.receivables), '0.00');
  assert.equal(ledger.money(ledger.equityExact()), '1000.00');
  ledger.payDividends(pay + 1);
  assert.equal(ledger.money(ledger.cash), '100.00');
});

test('AC-18/19 split adjusts quantity and value, fractions require compensation', () => {
  const { ledger } = account({ initialCash: '100' });
  ledger.setMark('AAA', '12', openAt(sessions[0]!), 0);
  ledger.fill(order('buy', 3), 3, '12', openAt(sessions[0]!), 0);
  const action = { type: 'split' as const, symbol: 'AAA', at: openAt(sessions[1]!), ratio: '1.5' };
  assert.throws(() => ledger.corporateAction(action, 1), /cash-in-lieu/);
  assert.equal(ledger.position('AAA'), 3);
  assert.equal(ledger.money(ledger.cash), '64.00');
  ledger.corporateAction({ ...action, cashInLieuPrice: '8' }, 1);
  assert.equal(ledger.position('AAA'), 4);
  assert.equal(ledger.money(ledger.cash), '68.00');
  assert.equal(ledger.money(ledger.equityExact()), '100.00');
  assert.equal(ledger.averageEntry('AAA'), 8);
});

test('split allocation across lots does not lose independently rounded fractions', () => {
  const { ledger } = account();
  ledger.setMark('AAA', '12', openAt(sessions[0]!), 0);
  ledger.fill(order('buy', 1, 'a'), 1, '12', openAt(sessions[0]!), 0);
  ledger.fill(order('buy', 1, 'b'), 1, '12', openAt(sessions[0]!), 0);
  ledger.corporateAction({ type: 'split', symbol: 'AAA', at: openAt(sessions[1]!), ratio: '1.5' }, 1);
  assert.equal(ledger.position('AAA'), 3);
  assert.equal(ledger.sellable('AAA', 1), 3);
  assert.equal(ledger.money(ledger.equityExact()), '1000.00');
});

test('AC-20 stale valuation is explicit and cannot use future marks', () => {
  const { ledger } = account();
  ledger.setMark('AAA', '10', closeAt(sessions[0]!), 0);
  ledger.fill(order('buy', 10), 10, '10', closeAt(sessions[0]!), 0);
  const point = ledger.recordEquity(closeAt(sessions[1]!), 1);
  assert.deepEqual(point.staleSymbols, ['AAA']);
  assert.equal(point.equity, 1000);
  assert.throws(() => ledger.recordEquity(openAt(sessions[0]!), 0), /Future mark/);
});

test('AC-21 withdrawals preserve unit NAV, returns and exact profit', () => {
  const { ledger, specification, dataset } = account({ initialCash: '100' });
  const at = openAt(sessions[1]!);
  specification.account.cashFlows = [{ at, amount: '-20' }];
  ledger.cashFlow('-20', at);
  const point = ledger.recordEquity(closeAt(sessions[1]!), 1);
  assert.equal(point.equity, 80);
  assert.equal(point.unitNav, 1);
  const result = calculateMetrics(specification, dataset, ledger, []);
  assert.equal(result.netProfit, '0.00');
  assert.equal(result.timeWeightedReturn, 0);
  assert.equal(result.accountReturn, null);
  assert.equal(result.maxDrawdownPct.value, 0);
  assert.equal(result.maxDrawdownAmount.value, 20);
  assert.throws(() => ledger.cashFlow('-100', at + 1), /Withdrawal/);
  assert.equal(ledger.money(ledger.cash), '80.00');
});

test('AC-22 amount and percentage drawdown retain different peak/trough/recovery', () => {
  const points: EquityPoint[] = [100, 70, 200, 160].map((equity, at) => ({ at, session: '', cash: equity, marketValue: 0, receivables: 0, equity, externalFlow: 0, unitNav: equity / 100, staleSymbols: [] }));
  assert.deepEqual(maximumDrawdown(points, 'equity', true), { value: 0.3, peakAt: 0, troughAt: 1, recoveredAt: 2 });
  assert.deepEqual(maximumDrawdown(points, 'equity', false), { value: 40, peakAt: 2, troughAt: 3, recoveredAt: null });
});

test('AC-23 supplied aggregate fees remain unclassified rather than invented commission', () => {
  const { ledger } = account();
  const fill = ledger.fill(order('buy', 1), 1, '10', openAt(sessions[0]!), 0, 'provided replay', '1.23');
  assert.equal(fill.fees.other, '1.23');
  assert.equal(fill.fees.commission, '0.00');
  assert.equal(fill.fees.total, '1.23');
  assert.equal(ledger.money(ledger.cash), '988.77');
});

test('zero-trade statistics are undefined where appropriate, not fake ratios', () => {
  const { ledger, specification, dataset } = account();
  ledger.recordEquity(closeAt(sessions[0]!), 0);
  ledger.recordEquity(closeAt(sessions[1]!), 1);
  const metrics = calculateMetrics(specification, dataset, ledger, []);
  assert.equal(metrics.finalEquity, '1000.00');
  assert.equal(metrics.accountReturn, 0);
  assert.equal(metrics.annualizedVolatility, 0);
  assert.equal(metrics.sharpe, null);
  assert.equal(metrics.sortino, null);
  assert.equal(metrics.winRate, null);
  assert.ok(metrics.unavailable.sharpe);
});

test('exact final equity is not reconstructed from Number analytics snapshots', () => {
  const { ledger, specification, dataset } = account({ initialCash: '900719925474099.91' });
  ledger.recordEquity(closeAt(sessions[0]!), 0);
  assert.equal(calculateMetrics(specification, dataset, ledger, []).finalEquity, '900719925474099.91');
});

test('benchmark interval starts at an available opening price, not a future close', () => {
  const data = input(['20', '20']);
  data.bars[0]!.open = '10'; data.bars[0]!.low = '10';
  const dataset = normalizeDataset(data), specification = spec();
  specification.analytics.benchmarkSymbol = 'AAA';
  const ledger = new Ledger(specification, dataset);
  ledger.recordEquity(closeAt(sessions[1]!), 1);
  assert.equal(calculateMetrics(specification, dataset, ledger, []).benchmarkReturn, 1);
  dataset.actions.push({ type: 'split', symbol: 'AAA', at: openAt(sessions[1]!), ratio: '2' });
  const metrics = calculateMetrics(specification, dataset, ledger, []);
  assert.equal(metrics.benchmarkReturn, null);
  assert.match(metrics.unavailable.benchmarkReturn!, /corporate actions/);
});

test('split keeps distinct FIFO acquisition costs through a later partial sale',()=>{
  const {ledger}=account();
  ledger.fill(order('buy',1,'low'),1,'10',openAt(sessions[0]!),0);
  ledger.fill(order('buy',1,'high'),1,'20',openAt(sessions[1]!),1);
  ledger.corporateAction({type:'split',symbol:'AAA',at:openAt(sessions[2]!),ratio:'2'},2);
  ledger.fill(order('sell',2,'exit-old-lot'),2,'5',openAt(sessions[3]!),3);
  assert.equal(ledger.averageEntryExact('AAA').toFixed(),'10');
  assert.equal(ledger.position('AAA'),2);
});

test('fractional split carries cost with fractions and delays mixed-lot sellability',()=>{
  const {ledger}=account({settlement:1});
  ledger.fill(order('buy',1,'a'),1,'9',openAt(sessions[0]!),0);
  ledger.fill(order('buy',1,'b'),1,'18',openAt(sessions[1]!),1);
  ledger.corporateAction({type:'split',symbol:'AAA',at:closeAt(sessions[1]!),ratio:'1.5'},1);
  assert.equal(ledger.position('AAA'),3);
  assert.equal(ledger.sellable('AAA',1),1);
  ledger.fill(order('sell',1,'sell-settled'),1,'6',closeAt(sessions[1]!),1);
  assert.equal(ledger.averageEntryExact('AAA').toFixed(),'10.5');
  assert.equal(ledger.sellable('AAA',2),2);
});
