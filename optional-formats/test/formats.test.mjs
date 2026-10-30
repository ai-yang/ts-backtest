import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { utils, write } from 'xlsx';
import { normalizeDataset, importDataset, runBacktest, setFormatAdapter } from '../../dist/src/index.js';
import { input, spec } from '../../dist/test/helpers.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const adapter = join(project, 'optional-formats', 'index.mjs');
const columns = { symbol: 'ticker', open: 'opening' };
function rows() { return input().bars.map(({ symbol, open, openTime, closeTime, ...rest }) => ({ ticker: symbol, opening: open, openTime: new Date(openTime).toISOString(), closeTime: new Date(closeTime).toISOString(), ...rest })); }
async function fixture(format, values = rows(), bookOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'backtest-optional-')); const path = join(root, `bars.${format}`);
  if (format === 'parquet') {
    const columnData = Object.keys(values[0]).map(name => ({ name, data: values.map(row => row[name]), type: typeof values[0][name] === 'string' ? 'STRING' : typeof values[0][name] === 'boolean' ? 'BOOLEAN' : 'DOUBLE' }));
    await writeFile(path, Buffer.from(parquetWriteBuffer({ columnData, ...(bookOptions.gzip ? { codec: 'GZIP', compressors: { GZIP: bytes => gzipSync(bytes) } } : {}) })));
  } else if (format === 'arrow') {
    const table = tableFromArrays(Object.fromEntries(Object.keys(values[0]).map(name => [name, values.map(row => row[name])])));
    await writeFile(path, tableToIPC(table, 'file'));
  } else {
    const book = utils.book_new(), sheet = utils.json_to_sheet(values); utils.book_append_sheet(book, sheet, 'Bars');
    if (bookOptions.second) utils.book_append_sheet(book, utils.json_to_sheet(values), 'Second');
    if (bookOptions.formula) sheet.B2.f = '1+9';
    await writeFile(path, write(book, { type: 'buffer', bookType: 'xlsx' }));
  }
  return { root, path, dispose: () => rm(root, { recursive: true, force: true }) };
}
for (const format of ['parquet', 'arrow', 'xlsx']) {
  test(`${format}: real writer → explicit mappings → core dataset and ledger equivalence`, async () => {
    const f = await fixture(format); setFormatAdapter(adapter);
    try {
      const actual = await importDataset({ path: f.path, format, metadata: input().metadata, columns });
      const expected = normalizeDataset(input()); assert.equal(actual.hash, expected.hash);
      const actualResult = runBacktest(actual, spec()), expectedResult = runBacktest(expected, spec());
      assert.deepEqual(actualResult.metrics, expectedResult.metrics); assert.deepEqual(actualResult.fills, expectedResult.fills);
      assert.equal(actualResult.metrics.finalEquity, '1100.00');
      await assert.rejects(importDataset({ path: f.path, format, metadata: input().metadata, columns, maxRows: 2 }), { code: 'ROW_LIMIT_EXCEEDED' });
      await assert.rejects(importDataset({ path: f.path, format, metadata: input().metadata, columns, maxFileBytes: 10 }), { code: 'DATA_TOO_LARGE' });
      const config = join(f.root, 'config.json'); await writeFile(config, JSON.stringify({ dataset: { path: f.path, format, metadata: input().metadata, columns }, spec: spec() }));
      const cli = spawnSync(process.execPath, [join(project, 'dist/src/adapters/cli.js'), 'run', '--config', config, '--formats', adapter], { encoding: 'utf8', timeout: 15000 });
      assert.equal(cli.status, 0, cli.stderr + cli.stdout); assert.equal(JSON.parse(cli.stdout).metrics.finalEquity, '1100.00');
    } finally { await f.dispose(); }
  });
  test(`${format}: floating-point prices are rejected rather than silently rounded`, async () => {
    const values = rows(); values[0].opening = 10;
    // Make all values the same physical numeric type for a meaningful binary fixture.
    values.forEach(row => { row.opening = Number(row.opening); });
    const f = await fixture(format, values); setFormatAdapter(adapter);
    try { await assert.rejects(importDataset({ path: f.path, format, metadata: input().metadata, columns }), { code: 'INVALID_DATA' }); }
    finally { await f.dispose(); }
  });
}

test('optional formats require explicit trusted host configuration', async () => {
  const f = await fixture('arrow'); const prior = process.env.BACKTEST_FORMAT_ADAPTER; delete process.env.BACKTEST_FORMAT_ADAPTER;
  try { await assert.rejects(importDataset({ path: f.path, format: 'arrow', metadata: input().metadata, columns }), { code: 'OPTIONAL_FORMAT_ADAPTER_REQUIRED' }); assert.throws(() => setFormatAdapter('./untrusted.js'), { code: 'INVALID_ADAPTER_PATH' }); }
  finally { if (prior === undefined) delete process.env.BACKTEST_FORMAT_ADAPTER; else process.env.BACKTEST_FORMAT_ADAPTER = prior; await f.dispose(); }
});

test('XLSX sheet choice is explicit and formula cached values are rejected', async () => {
  setFormatAdapter(adapter);
  const multiple = await fixture('xlsx', rows(), { second: true }); const formula = await fixture('xlsx', rows(), { formula: true });
  try {
    await assert.rejects(importDataset({ path: multiple.path, format: 'xlsx', metadata: input().metadata, columns }), { code: 'AMBIGUOUS_SHEET' });
    const selected = await importDataset({ path: multiple.path, format: 'xlsx', metadata: input().metadata, columns, formatOptions: { sheet: 'Second' } }); assert.equal(selected.hash, normalizeDataset(input()).hash);
    await assert.rejects(importDataset({ path: formula.path, format: 'xlsx', metadata: input().metadata, columns }), { code: 'FORMULA_CELL_UNSUPPORTED' });
  } finally { await multiple.dispose(); await formula.dispose(); }
});


test('Parquet GZIP pages decode within the expanded-byte budget', async () => {
  setFormatAdapter(adapter); const f = await fixture('parquet', rows(), { gzip: true });
  try { assert.equal((await importDataset({ path: f.path, format: 'parquet', metadata: input().metadata, columns })).hash, normalizeDataset(input()).hash); }
  finally { await f.dispose(); }
});

test('XLSX directory expansion limits and inconsistent member lengths fail before workbook parsing', async () => {
  setFormatAdapter(adapter); const f = await fixture('xlsx');
  try {
    const original = await readFile(f.path), directory = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(directory >= 0);
    const oversized = Buffer.from(original); oversized.writeUInt32LE(256 * 1024 * 1024 + 1, directory + 24); await writeFile(f.path, oversized);
    await assert.rejects(importDataset({ path: f.path, format: 'xlsx', metadata: input().metadata, columns }), { code: 'EXPANDED_DATA_LIMIT' });
    const dishonest = Buffer.from(original); dishonest.writeUInt32LE(0, directory + 24); await writeFile(f.path, dishonest);
    await assert.rejects(importDataset({ path: f.path, format: 'xlsx', metadata: input().metadata, columns }), { code: 'INVALID_XLSX' });
  } finally { await f.dispose(); }
});
