import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset } from '../src/data/normalize.js';
import { runBacktest } from '../src/engine/run.js';
import { BacktestError } from '../src/spec/errors.js';
import type { BacktestSpec, DatasetInput, TargetPoint } from '../src/spec/types.js';
import { bar, input, instrument, spec, sessions, openAt, closeAt } from './helpers.js';

const targetPoint = (session: string, quantities: Record<string, number>): TargetPoint => ({ at: closeAt(session), availableAt: closeAt(session), quantities });
function configured(data: DatasetInput, schedule: TargetPoint[], initialCash = '1000'): { dataset: ReturnType<typeof normalizeDataset>; specification: BacktestSpec } {
  const specification = spec();
  specification.account.initialCash = initialCash;
  specification.strategy = { kind: 'targets', schedule };
  return { dataset: normalizeDataset(data), specification };
}

test('golden shared cash gives two instruments 50 shares each independent of source ordering', () => {
  function execute(reverse: boolean) {
    const data = input(['10', '10', '10', '10', '10']);
    const second = data.bars.map(b => ({ ...b, symbol: 'BBB' }));
    data.metadata.instruments = [instrument(), instrument('BBB')];
    data.bars = reverse ? [...second, ...data.bars] : [...data.bars, ...second];
    if (reverse) data.metadata.instruments.reverse();
    const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 100, BBB: 100 })]);
    return runBacktest(dataset, specification);
  }
  const a = execute(false), b = execute(true);
  const fills = (result: typeof a) => result.fills.map(f => [f.symbol, f.side, f.quantity, f.price, f.cashAfter]);
  assert.deepEqual(fills(a), [['AAA', 'buy', 50, '10', '500.00'], ['BBB', 'buy', 50, '10', '0.00']]);
  assert.deepEqual(fills(b), fills(a));
  assert.equal(a.metrics.finalEquity, '1000.00');
});

test('golden unchanged target retains its partial order and minimum commission', () => {
  const data = input(['10', '10', '10', '10', '10']);
  data.metadata.instruments = [instrument('AAA', { lotSize: 100 })];
  data.bars.forEach(b => { b.volume = 40; });
  const { dataset, specification } = configured(data, [0, 1, 2].map(i => targetPoint(sessions[i]!, { AAA: 100 })), '2000');
  specification.costs = { version: 'minimum-v1', scope: 'order', periods: [{ from: 0, commissionRate: '0.001', minimumCommission: '5', sellTaxRate: '0', transferRate: '0' }] };
  const result = runBacktest(dataset, specification);
  assert.deepEqual(result.fills.map(f => f.quantity), [40, 40, 20]);
  assert.equal(new Set(result.fills.map(f => f.orderId)).size, 1);
  assert.deepEqual(result.fills.map(f => f.fees.commission), ['5.00', '0.00', '0.00']);
  assert.equal(result.metrics.fees, '5.00');
  assert.equal(result.metrics.finalEquity, '1995.00');
});

test('golden minute T+1 blocks same-session sale and releases next declared session', () => {
  const data = input([]);
  data.metadata.frequency = 'minute';
  data.metadata.instruments = [instrument('AAA', { settlementDays: 1 })];
  data.bars = [];
  for (const session of [sessions[3]!, sessions[4]!]) for (let minute = 0; minute < 3; minute++) {
    const start = openAt(session) + minute * 60_000;
    data.bars.push(bar(session, '10', { openTime: start, closeTime: start + 60_000 }));
  }
  const specification = spec();
  specification.start = data.bars[0]!.openTime;
  specification.end = data.bars.at(-1)!.closeTime + 1;
  specification.strategy = { kind: 'targets', schedule: [
    { at: data.bars[0]!.closeTime, availableAt: data.bars[0]!.closeTime, quantities: { AAA: 100 } },
    { at: data.bars[1]!.closeTime, availableAt: data.bars[1]!.closeTime, quantities: { AAA: 0 } },
  ] };
  const result = runBacktest(normalizeDataset(data), specification);
  assert.equal(result.fills.length, 2);
  assert.equal(result.fills[0]!.at, data.bars[1]!.openTime);
  assert.equal(result.fills[1]!.at, data.bars[3]!.openTime);
  assert.equal(result.fills[1]!.side, 'sell');
  assert.equal(result.metrics.finalEquity, '1000.00');
});

test('golden external withdrawal decreases raw equity, not profit or TWR', () => {
  const { dataset, specification } = configured(input(['10', '10', '10', '10', '10']), [targetPoint(sessions[0]!, { AAA: 0 })], '100');
  specification.account.cashFlows = [{ at: openAt(sessions[1]!), amount: '-20' }];
  const result = runBacktest(dataset, specification);
  assert.equal(result.metrics.finalEquity, '80.00');
  assert.equal(result.metrics.netProfit, '0.00');
  assert.equal(result.metrics.timeWeightedReturn, 0);
  assert.equal(result.metrics.accountReturn, null);
  assert.equal(result.metrics.maxDrawdownPct.value, 0);
  assert.equal(result.metrics.maxDrawdownAmount.value, 20);
  assert.equal(result.events.filter(e => e.type === 'cash_flow').length, 1);
});

test('golden dividend accrual and payment preserve value without making receivable cash', () => {
  const data = input(['10', '10', '9', '9', '9']);
  const accrual = openAt(sessions[2]!), payment = openAt(sessions[3]!);
  data.actions = [{ type: 'dividend', symbol: 'AAA', at: accrual, payAt: payment, amountPerShare: '1' }];
  const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 100 })]);
  const result = runBacktest(dataset, specification);
  const exDividend = result.equity.find(p => p.at === accrual)!;
  assert.equal(exDividend.cash, 0);
  assert.equal(exDividend.receivables, 100);
  assert.equal(exDividend.equity, 1000);
  const paid = result.equity.find(p => p.at === payment)!;
  assert.equal(paid.cash, 100);
  assert.equal(paid.receivables, 0);
  assert.equal(result.metrics.finalEquity, '1000.00');
  assert.equal(result.events.filter(e => e.type === 'dividend_accrual').length, 1);
  assert.equal(result.events.filter(e => e.type === 'dividend_payment').length, 1);
});

test('golden split preserves account value and explicitly cancels pre-split pending orders', () => {
  const data = input(['10', '10', '5', '5', '5']);
  data.actions = [{ type: 'split', symbol: 'AAA', at: openAt(sessions[2]!), ratio: '2' }];
  const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 100 }), targetPoint(sessions[1]!, { AAA: 0 })]);
  const result = runBacktest(dataset, specification);
  assert.equal(result.fills.length, 1);
  assert.equal(result.orders[1]!.status, 'canceled');
  assert.equal(result.orders[1]!.reason, 'SPLIT_CANCEL');
  assert.equal(result.events.find(e => e.type === 'split')!.quantityDelta, 100);
  assert.equal(result.metrics.finalEquity, '1000.00');
  assert.equal(result.metrics.netProfit, '0.00');
});

test('golden fractional split compensates the remainder instead of losing it', () => {
  const data = input(['12', '12', '8', '8', '8']);
  data.actions = [{ type: 'split', symbol: 'AAA', at: openAt(sessions[2]!), ratio: '1.5', cashInLieuPrice: '8' }];
  const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 3 })], '100');
  const result = runBacktest(dataset, specification);
  const split = result.events.find(e => e.type === 'split')!;
  assert.equal(split.quantityDelta, 1);
  assert.equal(split.cashDelta, '4.00');
  assert.equal(result.metrics.finalEquity, '100.00');
  const unsupported = normalizeDataset({ ...data, actions: [{ type: 'split', symbol: 'AAA', at: openAt(sessions[2]!), ratio: '1.5' }] });
  assert.throws(() => runBacktest(unsupported, specification), /cash-in-lieu/);
});

test('golden delisting books explicit compensation without fabricating a normal sale', () => {
  const data = input(['10', '10']);
  data.actions = [{ type: 'delist', symbol: 'AAA', at: openAt(sessions[2]!), cashPrice: '6' }];
  const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 100 })]);
  const result = runBacktest(dataset, specification);
  assert.equal(result.fills.length, 1);
  assert.equal(result.events.find(e => e.type === 'delist')!.cashDelta, '600.00');
  assert.equal(result.events.find(e => e.type === 'delist')!.quantityDelta, -100);
  assert.equal(result.metrics.finalEquity, '600.00');
  assert.equal(result.metrics.netProfit, '-400.00');
  assert.equal(result.metrics.maxDrawdownAmount.value, 400);
});

test('golden supplied execution replay applies costs once and does not rematch prices', () => {
  const data = input(['10', '10', '10', '10', '10']);
  const specification = spec();
  specification.execution.slippage.bps = 100;
  specification.strategy = { kind: 'replay', feePolicy: 'provided', fills: [
    { at: openAt(sessions[0]!), symbol: 'AAA', side: 'buy', quantity: 50, price: '10', fees: '1' },
    { at: closeAt(sessions[1]!), symbol: 'AAA', side: 'sell', quantity: 50, price: '11', fees: '1' },
  ] };
  const result = runBacktest(normalizeDataset(data), specification);
  assert.equal(result.mode, 'replay');
  assert.deepEqual(result.fills.map(f => f.price), ['10', '11']);
  assert.equal(result.metrics.fees, '2.00');
  assert.equal(result.metrics.finalEquity, '1048.00');
  assert.equal(result.metrics.netProfit, '48.00');
  assert.equal(result.metrics.roundTripCount, 1);
});

test('golden protective stop gapped through trigger executes at the opening phase', () => {
  const data = input(['10', '10', '8', '8', '8']);
  const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 100 })]);
  specification.execution.stopLossPct = 0.1;
  const result = runBacktest(dataset, specification);
  const sale = result.fills.find(f => f.side === 'sell')!;
  assert.ok(sale);
  assert.equal(sale.at, openAt(sessions[2]!));
  assert.equal(sale.price, '8');
  assert.equal(result.metrics.finalEquity, '800.00');
});

test('golden end-exclusive event cannot become a terminal valuation mark', () => {
  const data = input(['10', '10', '100', '100', '100']);
  data.bars[2]!.open = '11'; data.bars[2]!.low = '11';
  const { dataset, specification } = configured(data, [targetPoint(sessions[0]!, { AAA: 100 })]);
  specification.end = closeAt(sessions[2]!);
  const result = runBacktest(dataset, specification);
  assert.equal(result.metrics.finalEquity, '1100.00');
  assert.ok(result.equity.every(p => p.at < specification.end));
});

test('golden protective stop is not blocked by an existing discretionary sell reservation', () => {
  const data = input(['10', '10', '8', '8', '8']);
  const specification = spec();
  specification.execution.stopLossPct = 0.1;
  specification.strategy = { kind: 'rules', nodes: {}, rules: [
    { when: { op: 'eq', args: [{ state: 'position' }, { value: 0 }] }, action: { type: 'target_quantity', value: 100 } },
    { when: { op: 'gt', args: [{ state: 'position' }, { value: 0 }] }, action: { type: 'order', side: 'sell', quantity: 100, orderType: 'limit', price: '12', tif: 'gtc' } },
  ] };
  const result = runBacktest(normalizeDataset(data), specification);
  const sale = result.fills.find(f => f.side === 'sell');
  assert.ok(sale, 'The active stop must take precedence over an unfilled discretionary exit');
  assert.equal(sale.at, openAt(sessions[2]!));
  assert.equal(sale.price, '8');
  assert.ok(result.orders.some(o => o.type === 'limit' && o.status === 'canceled'));
});

test('golden reject policy covers unknowable same-bar limit entry then target sequence', () => {
  const data = input(['10', '9', '9', '9', '9']);
  Object.assign(data.bars[1]!, { open: '10', high: '10', low: '8', close: '9' });
  const specification = spec();
  specification.execution.takeProfitPct = 0.05;
  specification.execution.intrabarPolicy = 'reject';
  specification.strategy = { kind: 'rules', nodes: {}, rules: [
    { when: { op: 'eq', args: [{ state: 'position' }, { value: 0 }] }, action: { type: 'order', side: 'buy', quantity: 100, orderType: 'limit', price: '9', tif: 'gtc' } },
  ] };
  assert.throws(() => runBacktest(normalizeDataset(data), specification), error => error instanceof BacktestError && error.code === 'AMBIGUOUS_ENTRY_EXIT');
});
