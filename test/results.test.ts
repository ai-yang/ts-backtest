import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDataset } from '../src/data/normalize.js';
import { runBacktest } from '../src/engine/run.js';
import { BacktestError } from '../src/spec/errors.js';
import type { OutputLevel } from '../src/spec/types.js';
import { persistResult, cleanupStagingRuns, readManifest, readResolvedSpec, readSummary, queryResult, explainResult, type ResultPage, type ResultQuery } from '../src/runtime/results.js';
import { input, spec, sessions, closeAt } from './helpers.js';

const code = (expected: string) => (error: unknown) => error instanceof BacktestError && error.code === expected;
function fixture(level: OutputLevel = 'fullTrace') {
  const dataset = normalizeDataset(input()), specification = spec();
  specification.datasetId = dataset.id;
  specification.output.level = level;
  return runBacktest(dataset, specification);
}
async function store(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ts-backtest-results-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('atomic fullTrace artifacts preserve original spec, hashes and recorded decisions', async t => {
  const root = await store(t), result = fixture();
  const manifest = await persistResult(root, 'run_one', result);
  assert.equal(manifest.status, 'complete');
  assert.deepEqual(manifest.availableTables, ['summary', 'orders', 'fills', 'events', 'equity', 'trace']);
  assert.deepEqual(await readResolvedSpec(root, 'run_one'), result.spec);
  assert.deepEqual((await readSummary(root, 'run_one')).metrics, result.metrics);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const bytes = await readFile(join(root, 'runs', 'run_one', name));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  assert.deepEqual(await readdir(join(root, 'runs')), ['run_one']);
});

test('existing immutable run cannot be overwritten', async t => {
  const root = await store(t), result = fixture();
  await persistResult(root, 'run_one', result);
  await assert.rejects(persistResult(root, 'run_one', result), code('RUN_EXISTS'));
  assert.equal((await readManifest(root, 'run_one')).fingerprint, result.fingerprint);
});

test('summary preserves real trade counts but omitted details require full rerun', async t => {
  const root = await store(t), result = fixture('summary');
  await persistResult(root, 'run_summary', result);
  assert.ok((await readSummary(root, 'run_summary')).metrics.fillCount > 0);
  assert.deepEqual((await readManifest(root, 'run_summary')).availableTables, ['summary']);
  await assert.rejects(queryResult(root, 'run_summary', { table: 'fills' }), error => code('DETAILS_NOT_RECORDED')(error) && (error as BacktestError).details.rerunRequired === true);
  await assert.rejects(explainResult(root, 'run_summary', { orderId: 'o1' }), code('DETAILS_NOT_RECORDED'));
});

test('trades output explains recorded fees but never invents indicator snapshots', async t => {
  const root = await store(t), result = fixture('trades');
  await persistResult(root, 'run_trades', result);
  const explanation = await explainResult(root, 'run_trades', { fillId: result.fills[0]!.id });
  assert.equal(explanation.decisionContext, null);
  assert.deepEqual((explanation.selectedFill as Record<string, unknown>).fees, result.fills[0]!.fees);
  assert.match((explanation.limitations as string[]).join(' '), /not saved/);
  await assert.rejects(queryResult(root, 'run_trades', { table: 'equity' }), code('DETAILS_NOT_RECORDED'));
  await assert.rejects(explainResult(root, 'run_trades', { at: closeAt(sessions[0]!) }), code('DETAILS_NOT_RECORDED'));
});

test('stable cursor pagination and projection have no repeated or omitted rows', async t => {
  const root = await store(t), result = fixture();
  await persistResult(root, 'run_pages', result);
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryResult(root, 'run_pages', { table: 'events', limit: 1, fields: ['id', 'type'], ...(cursor ? { cursor } : {}) });
    assert.equal(page.totalRows, result.events.length);
    assert.equal(page.matchedRows, result.events.length);
    assert.ok(page.rows.every(row => Object.keys(row).join(',') === 'id,type'));
    rows.push(...page.rows); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(rows.map(row => row.id), result.events.map(row => row.id));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});

test('cursor is bound to run, filter, projection and table, and rejects tampering', async t => {
  const root = await store(t), result = fixture();
  await persistResult(root, 'run_a', result); await persistResult(root, 'run_b', result);
  const first = await queryResult(root, 'run_a', { table: 'events', limit: 1 });
  const cursor = first.nextCursor!;
  await assert.rejects(queryResult(root, 'run_b', { table: 'events', limit: 1, cursor }), code('CURSOR_MISMATCH'));
  await assert.rejects(queryResult(root, 'run_a', { table: 'fills', limit: 1, cursor }), code('CURSOR_MISMATCH'));
  await assert.rejects(queryResult(root, 'run_a', { table: 'events', filter: { type: 'fill' }, cursor }), code('CURSOR_MISMATCH'));
  await assert.rejects(queryResult(root, 'run_a', { table: 'events', fields: ['id'], cursor }), code('CURSOR_MISMATCH'));
  const bad = `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
  await assert.rejects(queryResult(root, 'run_a', { table: 'events', cursor: bad }), code('INVALID_CURSOR'));
});

test('filters and half-open time bounds return precisely matching stored rows', async t => {
  const root = await store(t), result = fixture();
  await persistResult(root, 'run_filter', result);
  const buy = await queryResult(root, 'run_filter', { table: 'fills', filter: { side: 'buy' }, fields: ['id', 'side'] });
  assert.deepEqual(buy.rows.map(row => row.id), result.fills.filter(f => f.side === 'buy').map(f => f.id));
  const first = result.fills[0]!, second = result.fills[1]!;
  const page = await queryResult(root, 'run_filter', { table: 'fills', from: first.at, to: second.at });
  assert.deepEqual(page.rows.map(row => row.id), [first.id]);
});

test('invalid projections, filters, ranges and pagination limits are rejected', async t => {
  const root = await store(t); await persistResult(root, 'run_validate', fixture());
  const queries: Array<[unknown, string]> = [
    [{ table: 'fills', fields: ['missing'] }, 'INVALID_PROJECTION'],
    [{ table: 'fills', fields: ['id', 'id'] }, 'INVALID_PROJECTION'],
    [{ table: 'fills', filter: { absent: 'x' } }, 'INVALID_FILTER'],
    [{ table: 'fills', filter: { quantity: '100' } }, 'INVALID_FILTER'],
    [{ table: 'fills', filter: { fees: '0' } }, 'INVALID_FILTER'],
    [{ table: 'orders', filter: { adjustments: null } }, 'INVALID_FILTER'],
    [{ table: 'orders', filter: { history: null } }, 'INVALID_FILTER'],
    [{ table: 'fills', limit: 0 }, 'INVALID_RESULT_QUERY'],
    [{ table: 'fills', limit: 201 }, 'INVALID_RESULT_QUERY'],
    [{ table: 'fills', offset: 1 }, 'INVALID_RESULT_QUERY'],
    [{ table: 'fills', from: 20, to: 10 }, 'INVALID_RESULT_QUERY'],
    [{ table: 'summary', from: 1 }, 'INVALID_RESULT_QUERY'],
  ];
  for (const [query, errorCode] of queries) await assert.rejects(queryResult(root, 'run_validate', query as ResultQuery), code(errorCode));
});

test('selected artifact content corruption and missing declared artifacts fail loudly', async t => {
  const root = await store(t); await persistResult(root, 'run_bad', fixture());
  const path = join(root, 'runs', 'run_bad', 'fills.jsonl'), original = await readFile(path, 'utf8');
  const changed = original.replace('"price":"10"', '"price":"11"');
  assert.notEqual(changed, original); assert.equal(changed.length, original.length);
  await writeFile(path, changed);
  await assert.rejects(queryResult(root, 'run_bad', { table: 'fills' }), code('ARTIFACT_INTEGRITY'));
  await unlink(join(root, 'runs', 'run_bad', 'events.jsonl'));
  await assert.rejects(readSummary(root, 'run_bad'), code('ARTIFACT_MISSING'));
});

test('run IDs and symlink artifacts cannot escape owned result directories', async t => {
  const root = await store(t), result = fixture();
  await assert.rejects(persistResult(root, '../escape', result), code('INVALID_RUN_ID'));
  await persistResult(root, 'run_real', result);
  await symlink(join(root, 'runs', 'run_real'), join(root, 'runs', 'run_link'), 'dir');
  await assert.rejects(readManifest(root, 'run_link'), code('UNSAFE_RESULT_PATH'));
  const fills = join(root, 'runs', 'run_real', 'fills.jsonl');
  await writeFile(join(root, 'external.jsonl'), await readFile(fills));
  await unlink(fills); await symlink(join(root, 'external.jsonl'), fills, 'file');
  await assert.rejects(queryResult(root, 'run_real', { table: 'fills' }), code('UNSAFE_ARTIFACT'));
});

test('byte-budget and malformed-output failures never publish an incomplete run', async t => {
  const root = await store(t), result = fixture();
  await assert.rejects(persistResult(root, 'run_tiny', result, { maxBytes: 100 }), code('OUTPUT_BYTE_LIMIT'));
  assert.deepEqual(await readdir(join(root, 'runs')), []);
  const malformed = structuredClone(result);
  malformed.fills[0]!.quantity = NaN;
  await assert.rejects(persistResult(root, 'run_nan', malformed), code('NON_FINITE_VALUE'));
  assert.deepEqual(await readdir(join(root, 'runs')), []);
});

test('fullTrace explanations join exact fees, order reasons and only recorded context', async t => {
  const root = await store(t), result = fixture();
  await persistResult(root, 'run_explain', result);
  const fill = result.fills[0]!;
  const explanation = await explainResult(root, 'run_explain', { fillId: fill.id });
  assert.deepEqual((explanation.selectedFill as Record<string, unknown>).fees, fill.fees);
  assert.equal((explanation.order as Record<string, unknown>).id, fill.orderId);
  const events = explanation.ledgerEvents as ResultPage;
  assert.ok(events.rows.every(row => row.fillId === fill.id));
  const snapshot = explanation.decisionContext as Record<string, unknown>;
  assert.ok(result.trace!.some(row => row.at === snapshot.at && row.symbol === snapshot.symbol));
  await assert.rejects(explainResult(root, 'run_explain', { orderId: 'missing' }), code('RESULT_ROW_NOT_FOUND'));
  await assert.rejects(explainResult(root, 'run_explain', { orderId: 'o1', fillId: fill.id }), code('INVALID_EXPLAIN_QUERY'));
  const at = await explainResult(root, 'run_explain', { at: result.spec.start, symbol: 'AAA' });
  assert.equal((at.recordedDecisions as ResultPage).matchedRows, 0);
  assert.match((at.limitations as string[]).join(' '), /No decision trace/);
});

test('derived full rerun preserves source fingerprint and rejects altered strategy semantics', async t => {
  const root = await store(t), original = fixture('summary'), detailed = fixture('fullTrace');
  await persistResult(root, 'run_original', original);
  const options = { sourceRunId: 'run_original', sourceFingerprint: original.fingerprint };
  const manifest = await persistResult(root, 'run_derived', detailed, options);
  assert.deepEqual(manifest.derivedFrom, { runId: 'run_original', fingerprint: original.fingerprint });
  assert.notEqual(manifest.fingerprint, original.fingerprint);
  await assert.rejects(persistResult(root, 'run_bad_source', detailed, { ...options, sourceFingerprint: '0'.repeat(64) }), code('DERIVATION_MISMATCH'));
  const dataset = normalizeDataset(input()), altered = spec(); altered.datasetId = dataset.id; altered.seed = 999;
  await assert.rejects(persistResult(root, 'run_bad_replay', runBacktest(dataset, altered), options), code('DERIVATION_MISMATCH'));
});

test('concurrent first commits share one fully initialized cursor key', async t => {
  const root = await store(t), result = fixture();
  await Promise.all([persistResult(root, 'run_parallel_a', result), persistResult(root, 'run_parallel_b', result)]);
  const page = await queryResult(root, 'run_parallel_a', { table: 'events', limit: 1 });
  assert.ok(page.nextCursor);
  assert.equal((await queryResult(root, 'run_parallel_a', { table: 'events', limit: 1, cursor: page.nextCursor! })).rows.length, 1);
});

test('byte-bounded pages preserve every row while single oversized rows require projection', async t => {
  const root = await store(t), result = fixture();
  for (const event of result.events) event.details = { padding: 'x'.repeat(160 * 1024) };
  await persistResult(root, 'run_large_rows', result);
  const ids: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryResult(root, 'run_large_rows', { table: 'events', limit: 200, ...(cursor ? { cursor } : {}) });
    assert.equal(page.rows.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(page.rows)) <= 256 * 1024);
    ids.push(...page.rows.map(row => row.id)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ids, result.events.map(event => event.id));
  result.orders[0]!.reason = 'x'.repeat(300 * 1024);
  await persistResult(root, 'run_oversized_row', result);
  await assert.rejects(queryResult(root, 'run_oversized_row', { table: 'orders' }), code('RESULT_ROW_TOO_LARGE'));
  const projected = await queryResult(root, 'run_oversized_row', { table: 'orders', fields: ['id', 'adjustments', 'history'] });
  assert.deepEqual(projected.rows.map(row => row.id), result.orders.map(order => order.id));
});

test('restart cleanup removes only owned unpublished result directories', async t => {
  const root = await store(t);
  await cleanupStagingRuns(root);
  await persistResult(root, 'run_complete', fixture());
  const runs = join(root, 'runs'), orphan = `.staging-run_orphan-${randomUUID()}`;
  await mkdir(join(runs, orphan)); await writeFile(join(runs, orphan, 'partial.jsonl'), 'incomplete');
  await mkdir(join(runs, '.staging-unrelated'));
  await cleanupStagingRuns(root);
  assert.deepEqual((await readdir(runs)).sort(), ['.staging-unrelated', 'run_complete']);
  assert.equal((await readManifest(root, 'run_complete')).status, 'complete');
});

test('restart result cleanup refuses staging symlinks and preserves their targets', async t => {
  const root = await store(t);
  await persistResult(root, 'run_complete', fixture());
  const external = join(root, 'external'); await mkdir(external); await writeFile(join(external, 'keep.txt'), 'keep');
  await symlink(external, join(root, 'runs', `.staging-run_link-${randomUUID()}`), 'dir');
  await assert.rejects(cleanupStagingRuns(root), code('UNSAFE_RESULT_PATH'));
  assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'keep');
});
