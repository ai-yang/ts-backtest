import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset, priceFromTicks, ticksFromPrice } from '../src/data/normalize.js';
import { input, instrument } from './helpers.js';

test('decimal prices are preserved as exact ticks', () => {
  assert.equal(ticksFromPrice('1.005', '0.001'), 1005);
  assert.equal(priceFromTicks(1005, '0.001'), '1.005');
  assert.throws(() => ticksFromPrice('1.005', '0.01'));
  assert.throws(() => ticksFromPrice('1000000000000000000', '0.01'));
});

test('data contract rejects unsorted, overlapping, malformed and wrong-session prices', () => {
  const source = input();
  assert.equal(normalizeDataset(source).rowCount, 5);
  const unsorted = structuredClone(source); unsorted.bars.reverse();
  assert.throws(() => normalizeDataset(unsorted), /increasing/);
  const bad = structuredClone(source); bad.bars[0]!.low = '99';
  assert.throws(() => normalizeDataset(bad), /OHLC/);
  const wrong = structuredClone(source); wrong.bars[0]!.session = source.bars[1]!.session;
  assert.throws(() => normalizeDataset(wrong), /session/);
});

test('price bands cannot silently disappear for instruments that require them', () => {
  const source = input(); source.metadata.instruments = [instrument('AAA', { requirePriceLimits: true })];
  assert.throws(() => normalizeDataset(source), /price bands/);
  source.bars.forEach(b => { b.limitUp = '20'; b.limitDown = '1'; });
  assert.equal(normalizeDataset(source).rowCount, 5);
});

test('unavailable features remain timestamped, duplicate and invalid actions are rejected', () => {
  const source = input();
  source.features = [{ symbol: 'AAA', name: 'pe', availableAt: source.bars[2]!.closeTime, value: 12 }];
  const data = normalizeDataset(source);
  assert.equal(data.features[0]!.availableAt, source.bars[2]!.closeTime);
  source.features.push({ ...source.features[0]! });
  assert.throws(() => normalizeDataset(source), /Duplicate/);
  source.features = [];
  source.actions = [{ type: 'dividend', symbol: 'AAA', at: 1000, payAt: 0, amountPerShare: '1' }];
  assert.throws(() => normalizeDataset(source), /Dividend/);
});

test('zero-volume records are not executable even if marked tradable', () => {
  const source = input(); source.bars[0]!.volume = 0;
  assert.equal(normalizeDataset(source).series.get('AAA')!.tradable[0], 0);
});

test('simultaneous corporate actions require explicit economic sequence',()=>{
  const source=input();const at=source.bars[2]!.openTime;
  source.actions=[{type:'split',symbol:'AAA',at,ratio:'2'},{type:'dividend',symbol:'AAA',at,payAt:at,amountPerShare:'1'}];
  assert.throws(()=>normalizeDataset(source),{code:'AMBIGUOUS_ACTION_SEQUENCE'});
  source.actions[0]!.sequence=2;source.actions[1]!.sequence=1;
  assert.deepEqual(normalizeDataset(source).actions.map(a=>a.type),['dividend','split']);
  assert.throws(()=>normalizeDataset({...input(),features:{} as never}),{code:'INVALID_DATA'});
});
