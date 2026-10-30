import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importDataset, parseTimestamp } from '../src/data/import.js';
import { encodeDataset, decodeDataset } from '../src/data/serialize.js';
import { normalizeDataset } from '../src/data/normalize.js';
import { contentHash } from '../src/spec/canonical.js';
import { BacktestError } from '../src/spec/errors.js';
import { input } from './helpers.js';

const headers = ['symbol', 'openTime', 'closeTime', 'session', 'open', 'high', 'low', 'close', 'volume', 'amount', 'tradable'] as const;
const csv = () => [headers.join(','), ...input().bars.map(b => headers.map(h => h === 'openTime' || h === 'closeTime' ? new Date(b[h]).toISOString() : b[h]).join(','))].join('\n');
const code = (expected: string) => (error: unknown) => error instanceof BacktestError && error.code === expected;

async function fixture(t: { after: (fn: () => Promise<void>) => void }, content: string | Buffer, suffix = 'csv') {
  const dir = await mkdtemp(join(tmpdir(), 'backtest-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `data.${suffix}`);
  await writeFile(path, content);
  return path;
}

test('CSV preserves exact decimal prices and normalizes like SDK input', async t => {
  const path = await fixture(t, csv());
  const dataset = await importDataset({ path, format: 'csv', metadata: input().metadata });
  assert.equal(dataset.hash, normalizeDataset(input()).hash);
  assert.deepEqual([...dataset.series.get('AAA')!.closeTicks], [1000, 1000, 1200, 1100, 1100]);
});

test('CSV supports explicit column mapping and quoted fields', async t => {
  const source = input(); source.metadata.instruments[0]!.symbol = 'A,A'; source.bars.forEach(b => b.symbol = 'A,A');
  const text = [headers.map(h => h === 'symbol' ? 'ticker' : h).join(','), ...source.bars.map(b => headers.map(h => h === 'symbol' ? '"A,A"' : b[h]).join(','))].join('\n');
  const dataset = await importDataset({ path: await fixture(t, text), format: 'csv', metadata: source.metadata, columns: { symbol: 'ticker' } });
  assert.equal(dataset.hash, normalizeDataset(source).hash);
});

test('CSV rejects duplicate/missing headers and ambiguous mappings', async t => {
  await assert.rejects(importDataset({ path: await fixture(t, csv().replace('volume,amount', 'amount,amount')), format: 'csv', metadata: input().metadata }), code('DUPLICATE_COLUMN'));
  await assert.rejects(importDataset({ path: await fixture(t, csv().replace('volume,amount', 'vol,amount')), format: 'csv', metadata: input().metadata }), code('MISSING_COLUMN'));
  await assert.rejects(importDataset({ path: await fixture(t, csv()), format: 'csv', metadata: input().metadata, columns: { open: 'close' } }), code('INVALID_COLUMN_MAPPING'));
});

test('imports require metadata and enforce byte/row/record budgets', async t => {
  const path = await fixture(t, csv());
  await assert.rejects(importDataset({ path, format: 'csv' }), code('MISSING_METADATA'));
  await assert.rejects(importDataset({ path, format: 'csv', metadata: input().metadata, maxRows: 2 }), code('ROW_LIMIT_EXCEEDED'));
  await assert.rejects(importDataset({ path, format: 'csv', metadata: input().metadata, maxFileBytes: 20 }), code('DATA_TOO_LARGE'));
  const jsonl = await fixture(t, JSON.stringify(input().bars[0]), 'jsonl');
  await assert.rejects(importDataset({ path: jsonl, format: 'jsonl', metadata: input().metadata, maxRecordBytes: 20 }), code('RECORD_TOO_LARGE'));
});

test('timestamps require milliseconds or an explicit valid ISO zone', () => {
  const at = Date.parse('2024-01-02T01:30:00Z');
  assert.equal(parseTimestamp(String(at), '/t'), at);
  assert.equal(parseTimestamp('2024-01-02T09:30:00+08:00', '/t'), at);
  for (const value of ['2024-01-02', '2024-01-02T09:30:00', '2024-02-30T01:00:00Z', '2024-01-02T24:00:00Z', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseTimestamp(value, '/t'), code('INVALID_TIMESTAMP'));
});

test('JSONL handles CRLF/no terminal newline and applies full data validation', async t => {
  const raw = input();
  const text = raw.bars.map(b => JSON.stringify({ ...b, openTime: new Date(b.openTime).toISOString() })).join('\r\n');
  assert.equal((await importDataset({ path: await fixture(t, text, 'jsonl'), format: 'jsonl', metadata: raw.metadata })).hash, normalizeDataset(raw).hash);
  const unsorted = [...raw.bars].reverse().map(b => JSON.stringify(b)).join('\n');
  await assert.rejects(importDataset({ path: await fixture(t, unsorted, 'jsonl'), format: 'jsonl', metadata: raw.metadata }), code('UNSORTED_OR_OVERLAPPING_BARS'));
});

test('JSON import retains events and rejects precision-losing numeric prices', async t => {
  const raw = input();
  raw.features = [{ symbol: 'AAA', name: 'score', availableAt: raw.bars[0]!.closeTime, value: 1.5 }];
  raw.membership = [{ symbol: 'AAA', availableAt: raw.bars[0]!.openTime, member: true }];
  raw.actions = [{ type: 'dividend', symbol: 'AAA', at: raw.bars[2]!.openTime, payAt: raw.bars[3]!.openTime, amountPerShare: '0.05' }];
  assert.equal((await importDataset({ path: await fixture(t, JSON.stringify(raw), 'json'), format: 'json' })).hash, normalizeDataset(raw).hash);
  const invalid = JSON.parse(JSON.stringify(raw)); invalid.bars[0].open = 10;
  await assert.rejects(importDataset({ path: await fixture(t, JSON.stringify(invalid), 'json'), format: 'json' }), code('INVALID_DATA'));
});

test('JSON bars array requires explicit metadata and does not override embedded metadata', async t => {
  const raw = input(), path = await fixture(t, JSON.stringify(raw.bars), 'json');
  await assert.rejects(importDataset({ path, format: 'json' }), code('MISSING_METADATA'));
  assert.equal((await importDataset({ path, format: 'json', metadata: raw.metadata })).hash, normalizeDataset(raw).hash);
  await assert.rejects(importDataset({ path: await fixture(t, JSON.stringify(raw), 'json'), format: 'json', metadata: { ...raw.metadata, calendarVersion: 'different' } }), code('CONFLICTING_METADATA'));
});

test('CSV rejects invalid UTF-8 instead of replacing data characters', async t => {
  const bytes = Buffer.concat([Buffer.from(csv()), Buffer.from([0xff])]);
  await assert.rejects(importDataset({ path: await fixture(t, bytes), format: 'csv', metadata: input().metadata }), code('INVALID_ENCODING'));
});

test('portable dataset codec preserves typed arrays, missing values, events, and identity', () => {
  const raw = input(); delete raw.bars[0]!.amount;
  raw.bars[1]!.limitUp = '11'; raw.bars[1]!.limitDown = '9';
  raw.features = [{ symbol: 'AAA', name: 'score', availableAt: raw.bars[0]!.closeTime, value: 3 }];
  const original = normalizeDataset(raw), restored = decodeDataset(encodeDataset(original));
  const envelope = JSON.parse(encodeDataset(original));
  assert.equal(envelope.format, 'ts-backtest-dataset');
  envelope.format = 'zwork-backtest-dataset';
  assert.deepEqual(decodeDataset(JSON.stringify(envelope)), original, 'the project rename preserves old cache readability');
  assert.equal(restored.hash, original.hash); assert.equal(restored.id, original.id);
  assert.deepEqual(restored, original);
  assert.ok(restored.series.get('AAA')!.openTime instanceof Float64Array);
  assert.ok(restored.series.get('AAA')!.sessionIndex instanceof Uint32Array);
  assert.ok(restored.series.get('AAA')!.tradable instanceof Uint8Array);
  assert.ok(Number.isNaN(restored.series.get('AAA')!.amount[0]));
});

test('codec rejects corruption, invented identities, and resource-limit violations', () => {
  const encoded = encodeDataset(normalizeDataset(input()));
  const damaged = JSON.parse(encoded); damaged.payload.rowCount++;
  assert.throws(() => decodeDataset(JSON.stringify(damaged)), code('DATASET_INTEGRITY_ERROR'));
  const forged = JSON.parse(encoded); forged.payload.hash = 'f'.repeat(64); forged.payload.id = `ds_${'f'.repeat(24)}`; forged.checksum = contentHash(forged.payload);
  assert.throws(() => decodeDataset(JSON.stringify(forged)), code('DATASET_INTEGRITY_ERROR'));
  assert.throws(() => decodeDataset(encoded, { maxBytes: 10 }), code('DATA_TOO_LARGE'));
  assert.throws(() => decodeDataset(encoded, { maxRows: 2 }), code('INVALID_DATASET_CACHE'));
});

test('codec validates column shapes and semantics even with a recomputed checksum', () => {
  const encoded = encodeDataset(normalizeDataset(input()));
  const damaged = JSON.parse(encoded); damaged.payload.series[0].columns.closeTicks.dtype = 'u8'; damaged.checksum = contentHash(damaged.payload);
  assert.throws(() => decodeDataset(JSON.stringify(damaged)), code('INVALID_DATASET_CACHE'));
  const badFlag = JSON.parse(encoded); const block = badFlag.payload.series[0].columns.tradable; const bytes = Buffer.from(block.base64, 'base64'); bytes[0] = 2; block.base64 = bytes.toString('base64'); badFlag.checksum = contentHash(badFlag.payload);
  assert.throws(() => decodeDataset(JSON.stringify(badFlag)), code('INVALID_DATASET_CACHE'));
});

test('codec rejects deeply nested envelopes before recursive canonical hashing', () => {
  const nested = '{"x":'.repeat(6000) + '0' + '}'.repeat(6000);
  const encoded = `{"format":"ts-backtest-dataset","version":1,"checksum":"${'0'.repeat(64)}","payload":${nested}}`;
  assert.throws(() => decodeDataset(encoded), code('INVALID_DATASET_CACHE'));
});

test('codec handles multi-megabyte base64 without regex stack overflow', () => {
  const encoded = JSON.parse(encodeDataset(normalizeDataset(input())));
  encoded.payload.series[0].columns.openTime = { dtype: 'f64le', length: 1_000_000, base64: Buffer.alloc(8_000_000).toString('base64') };
  encoded.checksum = contentHash(encoded.payload);
  // The array itself is valid base64. Its deliberate mismatch with the other
  // columns must produce a structured shape error, not a JS stack overflow.
  assert.throws(() => decodeDataset(JSON.stringify(encoded)), code('INVALID_DATASET_CACHE'));
});
