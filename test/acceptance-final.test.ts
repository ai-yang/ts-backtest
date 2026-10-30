import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/accounting/ledger.js';
import { normalizeDataset } from '../src/data/normalize.js';
import { runBacktest } from '../src/engine/run.js';
import type { Action, Expression, Order } from '../src/spec/types.js';
import { input, spec, openAt, closeAt, sessions } from './helpers.js';

test('AC-11 fees immediately below, at, and above half a cent round exactly and reconcile cash', () => {
  for (const [rate, commission, cashAfter] of [['0.004999', '0.00', '999.00'], ['0.005', '0.01', '998.99'], ['0.005001', '0.01', '998.99']] as const) {
    const specification = spec(); specification.costs.periods[0]!.commissionRate = rate!;
    const ledger = new Ledger(specification, normalizeDataset(input()));
    const order: Order = { id: 'boundary', symbol: 'AAA', side: 'buy', type: 'market', quantity: 1, remaining: 1,
      submittedAt: specification.start, tif: 'gtc', status: 'accepted', cumulativeNotional: '0', commissionAccruedRaw: '0', commissionPaid: '0', source: 'acceptance' };
    const fill = ledger.fill(order, 1, '1', openAt(sessions[0]!), 0);
    assert.equal(fill.fees.commission, commission, rate);
    assert.equal(fill.fees.total, commission, rate);
    assert.equal(fill.cashAfter, cashAfter, rate);
    assert.equal(ledger.money(ledger.cash), cashAfter, rate);
  }
});

test('AC-10 changing an unfilled buy target to zero cancels its intention without fees', () => {
  const raw = input(['10', '10', '10', '10', '10']);
  raw.bars[1]!.tradable = false;
  const specification = spec({ strategy: { kind: 'targets', schedule: [
    { at: closeAt(sessions[0]!), availableAt: closeAt(sessions[0]!), quantities: { AAA: 100 } },
    { at: closeAt(sessions[1]!), availableAt: closeAt(sessions[1]!), quantities: { AAA: 0 } },
  ] } });
  specification.costs.periods[0]!.minimumCommission = '5';
  const result = runBacktest(normalizeDataset(raw), specification);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0]!.status, 'canceled');
  assert.equal(result.orders[0]!.reason, 'REPLACED_TARGET');
  assert.equal(result.orders[0]!.remaining, 100);
  assert.equal(result.orders[0]!.history!.at(-1)!.at, closeAt(sessions[1]!));
  assert.deepEqual(result.fills, []);
  assert.equal(result.metrics.fees, '0.00');
  assert.equal(result.metrics.finalEquity, '1000.00');
});

test('AC-10 ordinary sells cannot reserve holdings twice and cancellation releases the reservation', () => {
  const at = (index: number): Expression => ({ op: 'eq', args: [{ time: 'at' }, { value: closeAt(sessions[index]!) }] });
  const rule = (index: number, action: Action) => ({ when: at(index), action });
  const specification = spec({ account: { ...spec().account, initialCash: '2000' }, strategy: { kind: 'rules', nodes: {}, rules: [
    rule(0, { type: 'target_quantity', value: 100 }),
    rule(1, { type: 'order', side: 'sell', quantity: 100, orderType: 'limit', price: '20', tif: 'gtc', tag: 'reserved' }),
    rule(1, { type: 'order', side: 'sell', quantity: 100, orderType: 'market', tif: 'gtc', tag: 'duplicate' }),
    rule(2, { type: 'cancel', tag: 'reserved' }),
    rule(2, { type: 'order', side: 'sell', quantity: 100, orderType: 'market', tif: 'gtc', tag: 'replacement' }),
  ] } });
  specification.costs.periods[0]!.minimumCommission = '5';
  const result = runBacktest(normalizeDataset(input(['10', '11', '12', '13', '14'])), specification);
  const duplicate = result.orders.find(order => order.tag === 'duplicate')!;
  assert.equal(duplicate.status, 'rejected');
  assert.equal(duplicate.reason, 'INSUFFICIENT_UNRESERVED_POSITION');
  assert.equal(result.orders.find(order => order.tag === 'reserved')!.status, 'canceled');
  assert.equal(result.orders.find(order => order.tag === 'replacement')!.status, 'filled');
  assert.deepEqual(result.fills.map(fill => [fill.side, fill.quantity, fill.price, fill.positionAfter]), [
    ['buy', 100, '11', 100], ['sell', 100, '13', 0],
  ]);
  assert.equal(result.fills[1]!.at, openAt(sessions[3]!));
  assert.equal(result.metrics.fees, '10.00');
  assert.equal(result.metrics.finalEquity, '2190.00');
});
