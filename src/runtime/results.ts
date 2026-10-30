import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, rename, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJSON, contentHash } from '../spec/canonical.js';
import { assertThat, BacktestError } from '../spec/errors.js';
import { parseSpec } from '../spec/validate.js';
import { renderReport } from '../reports/html.js';
import type { BacktestResult, BacktestSpec, OutputLevel } from '../spec/types.js';

export type ResultTable = 'summary' | 'orders' | 'fills' | 'events' | 'equity' | 'trace';
export interface Artifact { sha256: string; bytes: number; rows?: number; table?: string }
export interface RunManifest {
  schemaVersion: '1'; runId: string; status: 'complete'; engineVersion: string; datasetHash: string;
  fingerprint: string; outputLevel: OutputLevel; createdAt: string;
  availableTables: ResultTable[]; artifacts: Record<string, Artifact>;
  derivedFrom?: { runId: string; fingerprint: string };
}
export interface PersistOptions { maxBytes?: number; sourceRunId?: string; sourceFingerprint?: string }
export interface ResultQuery {
  table: ResultTable; limit?: number; cursor?: string; fields?: string[];
  filter?: Record<string, string | number | boolean | null>; from?: number; to?: number;
}
export interface ResultPage { runId: string; table: ResultTable; rows: Record<string, unknown>[]; nextCursor: string | null; totalRows: number; matchedRows: number }
export interface ExplainQuery { orderId?: string; fillId?: string; at?: number; symbol?: string }
export type ResultSummary = Omit<BacktestResult, 'spec' | 'orders' | 'fills' | 'events' | 'equity' | 'trace'>;

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const STAGING_NAME = /^\.staging-[A-Za-z0-9][A-Za-z0-9_-]{0,95}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tables = ['summary', 'orders', 'fills', 'events', 'equity', 'trace'] as const;
const filenames: Record<ResultTable, string> = { summary: 'summary.json', orders: 'orders.jsonl', fills: 'fills.jsonl', events: 'events.jsonl', equity: 'equity.jsonl', trace: 'trace.jsonl' };
const allowedFields: Record<ResultTable, readonly string[]> = {
  summary: ['schemaVersion', 'engineVersion', 'fingerprint', 'mode', 'datasetHash', 'metrics', 'warnings', 'timing'],
  orders: ['id', 'symbol', 'side', 'type', 'quantity', 'remaining', 'submittedAt', 'price', 'tif', 'tag', 'status', 'reason', 'cumulativeNotional', 'commissionAccruedRaw', 'commissionPaid', 'source', 'adjustments', 'history'],
  fills: ['id', 'orderId', 'at', 'symbol', 'side', 'quantity', 'price', 'notional', 'fees', 'cashAfter', 'positionAfter', 'reason'],
  events: ['id', 'at', 'type', 'cashDelta', 'receivableDelta', 'symbol', 'quantityDelta', 'fillId', 'details'],
  equity: ['at', 'session', 'cash', 'marketValue', 'receivables', 'equity', 'externalFlow', 'unitNav', 'staleSymbols'],
  trace: ['at', 'symbol', 'values', 'rules', 'state'],
};
const objectFields = new Set(['metrics', 'warnings', 'timing', 'fees', 'details', 'staleSymbols', 'values', 'rules', 'state', 'adjustments', 'history']);
const numericFields = new Set(['quantity', 'remaining', 'submittedAt', 'at', 'positionAfter', 'quantityDelta', 'cash', 'marketValue', 'receivables', 'equity', 'externalFlow', 'unitNav']);
const querySchema = z.strictObject({ table: z.enum(tables), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(4096).optional(), fields: z.array(z.string().max(80)).min(1).max(32).optional(), filter: z.record(z.string().max(80), z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()])).optional(), from: z.number().int().nonnegative().safe().optional(), to: z.number().int().nonnegative().safe().optional() });
const manifestSchema = z.strictObject({
  schemaVersion: z.literal('1'), runId: z.string().regex(RUN_ID), status: z.literal('complete'), engineVersion: z.string().min(1).max(128), datasetHash: z.string().regex(HASH), fingerprint: z.string().regex(HASH), outputLevel: z.enum(['summary', 'trades', 'fullTrace']), createdAt: z.iso.datetime(), availableTables: z.array(z.enum(tables)),
  artifacts: z.record(z.string(), z.strictObject({ sha256: z.string().regex(HASH), bytes: z.number().int().nonnegative().safe(), rows: z.number().int().nonnegative().safe().optional(), table: z.enum(tables).optional() })),
  derivedFrom: z.strictObject({ runId: z.string().regex(RUN_ID), fingerprint: z.string().regex(HASH) }).optional(),
});

function implementedTables(level: OutputLevel): ResultTable[] { return level === 'summary' ? ['summary'] : level === 'trades' ? ['summary', 'orders', 'fills'] : [...tables]; }
function validRunId(id: string): void { assertThat(typeof id === 'string' && RUN_ID.test(id), 'INVALID_RUN_ID', 'runId must contain only letters, digits, underscores and hyphens, and be at most 96 characters'); }
function ioError(error: unknown, code: string, message: string): never {
  if (error instanceof BacktestError) throw error;
  throw new BacktestError(code, message, '', { cause: error instanceof Error ? error.message : String(error) });
}
async function regular(path: string): Promise<void> {
  const stat = await lstat(path);
  assertThat(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_ARTIFACT', 'Artifact must be a regular file, not a symbolic link');
}
async function runRoot(storeDir: string, create: boolean): Promise<string> {
  const root = resolve(storeDir);
  if (create) await mkdir(root, { recursive: true });
  const canonical = await realpath(root);
  const runs = join(canonical, 'runs');
  if (create) await mkdir(runs, { recursive: true });
  const stat = await lstat(runs);
  assertThat(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_RESULT_PATH', 'runs must be a real directory owned by the result store');
  return runs;
}

/** Recover unpublished writes only while holding exclusive ownership of the store. */
export async function cleanupStagingRuns(storeDir: string): Promise<void> {
  let root: string;
  try { root = await runRoot(storeDir, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of await readdir(root)) {
    if (!STAGING_NAME.test(name)) continue;
    const path = join(root, name), info = await lstat(path);
    assertThat(info.isDirectory() && !info.isSymbolicLink(), 'UNSAFE_RESULT_PATH', 'Unpublished result staging must be an owned real directory');
    await rm(path, { recursive: true, force: true });
  }
}
async function directory(storeDir: string, runId: string): Promise<string> {
  validRunId(runId);
  try {
    const path = join(await runRoot(storeDir, false), runId), stat = await lstat(path);
    assertThat(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_RESULT_PATH', 'Run must be a real directory');
    return path;
  } catch (error) { return ioError(error, 'RUN_NOT_FOUND', `Run ${runId} is not available`); }
}
async function readSmall(path: string, limit = MAX_RECORD_BYTES): Promise<Buffer> {
  await regular(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    assertThat(stat.size <= limit, 'ARTIFACT_TOO_LARGE', 'JSON artifact exceeds its bounded size');
    const bytes = await handle.readFile();
    assertThat(bytes.length <= limit, 'ARTIFACT_TOO_LARGE', 'JSON artifact exceeds its bounded size');
    return bytes;
  } finally { await handle.close(); }
}
const keyInitializations = new Map<string, Promise<void>>();
async function cursorKey(storeDir: string, create: boolean): Promise<Buffer> {
  const root = await realpath(resolve(storeDir)), path = join(root, '.cursor-key');
  if (create) {
    let initialization = keyInitializations.get(root);
    if (!initialization) {
      initialization = (async () => {
        try { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      })();
      keyInitializations.set(root, initialization);
    }
    try { await initialization; } finally { if (keyInitializations.get(root) === initialization) keyInitializations.delete(root); }
  }
  const key = await readSmall(path, 32);
  assertThat(key.length === 32, 'INVALID_RESULT_STORE', 'Result store cursor key is invalid');
  return key;
}

interface ByteBudget { remaining: number }
function consume(budget: ByteBudget, bytes: number): void {
  assertThat(bytes <= budget.remaining, 'OUTPUT_BYTE_LIMIT', 'Persisted output exceeds its byte budget');
  budget.remaining -= bytes;
}
async function writeJSON(path: string, value: unknown, table?: string, budget?: ByteBudget): Promise<Artifact> {
  const data = Buffer.from(canonicalJSON(value) + '\n');
  assertThat(data.length <= MAX_RECORD_BYTES, 'ARTIFACT_TOO_LARGE', 'JSON artifact exceeds bounded size');
  if (budget) consume(budget, data.length);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, ...(table ? { rows: 1, table } : {}) };
}
async function writeReport(path: string, result: BacktestResult, budget: ByteBudget): Promise<Artifact> {
  const data = Buffer.from(renderReport(result), 'utf8');
  consume(budget, data.length);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}
async function writeRows(path: string, rows: readonly unknown[], table: string, budget: ByteBudget): Promise<Artifact> {
  const handle = await open(path, 'wx', 0o600), hash = createHash('sha256');
  let bytes = 0, batch = '', batchBytes = 0;
  const flush = async () => { if (batch) { await handle.writeFile(batch, 'utf8'); batch = ''; batchBytes = 0; } };
  try {
    for (const row of rows) {
      const line = canonicalJSON(row) + '\n', length = Buffer.byteLength(line);
      assertThat(length <= MAX_RECORD_BYTES, 'ARTIFACT_TOO_LARGE', 'A result row exceeds the bounded record size');
      consume(budget, length);
      hash.update(line); bytes += length; batch += line; batchBytes += length;
      if (batchBytes >= 64 * 1024) await flush();
    }
    await flush(); await handle.sync();
  } finally { await handle.close(); }
  return { sha256: hash.digest('hex'), bytes, rows: rows.length, table };
}

/** Publish only a complete directory. An existing immutable run is never overwritten. */
export async function persistResult(storeDir: string, runId: string, result: BacktestResult, options: PersistOptions = {}): Promise<RunManifest> {
  validRunId(runId);
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  assertThat(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'INVALID_OUTPUT_BUDGET', 'Output byte budget must be a positive safe integer');
  const budget = { remaining: maxBytes };
  assertThat(Boolean(options.sourceRunId) === Boolean(options.sourceFingerprint), 'INVALID_DERIVATION', 'Source run and fingerprint must be supplied together');
  let derivedFrom: RunManifest['derivedFrom'];
  if (options.sourceRunId) {
    const source = await readManifest(storeDir, options.sourceRunId);
    assertThat(source.fingerprint === options.sourceFingerprint && source.datasetHash === result.datasetHash && source.engineVersion === result.engineVersion, 'DERIVATION_MISMATCH', 'Replay source provenance differs from the saved original run');
    const originalSpec = await readResolvedSpec(storeDir, options.sourceRunId);
    assertThat(canonicalJSON({ ...result.spec, output: originalSpec.output }) === canonicalJSON(originalSpec), 'DERIVATION_MISMATCH', 'An explanatory replay must preserve the entire original specification except output detail');
    derivedFrom = { runId: options.sourceRunId, fingerprint: source.fingerprint };
  }
  assertThat(result.fingerprint === contentHash({ engineVersion: result.engineVersion, spec: result.spec, datasetHash: result.datasetHash }), 'INVALID_RESULT', 'Result fingerprint does not match its full resolved specification');
  const root = await runRoot(storeDir, true), target = join(root, runId), staging = join(root, `.staging-${runId}-${randomUUID()}`);
  try { await lstat(target); throw new BacktestError('RUN_EXISTS', `Immutable run ${runId} already exists`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await cursorKey(storeDir, true);
  await mkdir(staging, { mode: 0o700 });
  try {
    const { spec, orders, fills, events, equity, trace, ...summary } = result;
    const level = spec.output.level, availableTables = implementedTables(level);
    assertThat(level !== 'fullTrace' || Array.isArray(trace), 'TRACE_NOT_RECORDED', 'fullTrace result is missing its decision trace');
    const artifacts: Record<string, Artifact> = {};
    artifacts['resolved-spec.json'] = await writeJSON(join(staging, 'resolved-spec.json'), spec, undefined, budget);
    artifacts['summary.json'] = await writeJSON(join(staging, 'summary.json'), summary, 'summary', budget);
    const rows: Record<Exclude<ResultTable, 'summary'>, readonly unknown[]> = { orders, fills, events, equity, trace: trace ?? [] };
    for (const table of availableTables) if (table !== 'summary') artifacts[filenames[table]] = await writeRows(join(staging, filenames[table]), rows[table], table, budget);
    if (level === 'fullTrace') artifacts['report.html'] = await writeReport(join(staging, 'report.html'), result, budget);
    const manifest: RunManifest = { schemaVersion: '1', runId, status: 'complete', engineVersion: result.engineVersion, datasetHash: result.datasetHash, fingerprint: result.fingerprint, outputLevel: level, createdAt: new Date().toISOString(), availableTables, artifacts, ...(derivedFrom ? { derivedFrom } : {}) };
    assertThat(manifestSchema.safeParse(manifest).success, 'INVALID_RESULT', 'Result metadata does not satisfy the persisted manifest contract');
    await writeJSON(join(staging, 'manifest.json'), manifest, undefined, budget);
    await rename(staging, target);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    return ioError(error, 'RESULT_COMMIT_FAILED', `Could not commit complete run ${runId}`);
  }
}

export async function readManifest(storeDir: string, runId: string): Promise<RunManifest> {
  const path = await directory(storeDir, runId);
  try {
    const parsed = manifestSchema.safeParse(JSON.parse((await readSmall(join(path, 'manifest.json'), 256 * 1024)).toString('utf8')));
    assertThat(parsed.success, 'INVALID_MANIFEST', 'Result manifest is malformed');
    const manifest = parsed.data;
    assertThat(manifest.runId === runId, 'INVALID_MANIFEST', 'Manifest belongs to a different run');
    const expectedTables = implementedTables(manifest.outputLevel);
    assertThat(canonicalJSON(manifest.availableTables) === canonicalJSON(expectedTables), 'INVALID_MANIFEST', 'Manifest tables disagree with output level');
    const hasReport = Object.hasOwn(manifest.artifacts, 'report.html');
    assertThat(!hasReport || manifest.outputLevel === 'fullTrace', 'INVALID_MANIFEST', 'HTML reports require fullTrace output');
    // Reports were added without changing schema version; earlier runs stay readable.
    const expectedFiles = ['resolved-spec.json', ...expectedTables.map(table => filenames[table]), ...(hasReport ? ['report.html'] : [])].sort();
    assertThat(canonicalJSON(Object.keys(manifest.artifacts).sort()) === canonicalJSON(expectedFiles), 'INVALID_MANIFEST', 'Unexpected or missing artifact declaration');
    for (const [file, artifact] of Object.entries(manifest.artifacts)) {
      const table = expectedTables.find(t => filenames[t] === file);
      assertThat(table ? artifact.table === table && artifact.rows !== undefined : artifact.table === undefined && artifact.rows === undefined, 'INVALID_MANIFEST', 'Artifact table metadata is inconsistent');
      await regular(join(path, file));
      assertThat((await lstat(join(path, file))).size === artifact.bytes, 'ARTIFACT_INTEGRITY', `Artifact size differs for ${file}`);
    }
    return manifest;
  } catch (error) { return ioError(error, 'ARTIFACT_MISSING', `Run ${runId} has a missing or unreadable artifact`); }
}

export interface ReportArtifact { path: string; sha256: string; bytes: number; mimeType: 'text/html' }
/** Verify the complete stored report before exposing a small local artifact handle. */
export async function reportArtifact(storeDir: string, runId: string): Promise<ReportArtifact> {
  const manifest = await readManifest(storeDir, runId);
  const artifact = manifest.artifacts['report.html'];
  assertThat(artifact, 'DETAILS_NOT_RECORDED', 'report.html was not saved for this run; rerun with fullTrace output', '',
    { runId, requiredOutput: 'fullTrace', rerunRequired: true, rerunScope: 'original complete run with original data and versions' });
  const path = join(await directory(storeDir, runId), 'report.html');
  const data = await readSmall(path, 2 * 1024 * 1024);
  assertThat(data.length === artifact.bytes && createHash('sha256').update(data).digest('hex') === artifact.sha256,
    'ARTIFACT_INTEGRITY', 'HTML report content does not match the manifest');
  return { path, sha256: artifact.sha256, bytes: artifact.bytes, mimeType: 'text/html' };
}

function requireTable(manifest: RunManifest, table: ResultTable): void {
  assertThat(manifest.availableTables.includes(table), 'DETAILS_NOT_RECORDED', `${table} was not saved at output level ${manifest.outputLevel}`, '', { runId: manifest.runId, table, requiredOutput: 'fullTrace', rerunRequired: true, rerunScope: 'original complete run with original data and versions' });
}
async function checkedJSON(path: string, artifact: Artifact): Promise<Record<string, unknown>> {
  const data = await readSmall(path);
  assertThat(data.length === artifact.bytes && createHash('sha256').update(data).digest('hex') === artifact.sha256, 'ARTIFACT_INTEGRITY', 'Artifact content hash does not match manifest');
  const result: unknown = JSON.parse(data.toString('utf8'));
  assertThat(result && typeof result === 'object' && !Array.isArray(result), 'INVALID_ARTIFACT', 'Expected a JSON object artifact');
  return result as Record<string, unknown>;
}
export async function readSummary(storeDir: string, runId: string): Promise<ResultSummary> {
  const manifest = await readManifest(storeDir, runId), path = await directory(storeDir, runId);
  const value = await checkedJSON(join(path, 'summary.json'), manifest.artifacts['summary.json']!);
  assertThat(value.fingerprint === manifest.fingerprint && value.datasetHash === manifest.datasetHash && value.engineVersion === manifest.engineVersion, 'ARTIFACT_INTEGRITY', 'Summary provenance differs from manifest');
  return value as unknown as ResultSummary;
}
export async function readResolvedSpec(storeDir: string, runId: string): Promise<BacktestSpec> {
  const manifest = await readManifest(storeDir, runId), path = await directory(storeDir, runId);
  const spec = parseSpec(await checkedJSON(join(path, 'resolved-spec.json'), manifest.artifacts['resolved-spec.json']!));
  assertThat(contentHash({ engineVersion: manifest.engineVersion, spec, datasetHash: manifest.datasetHash }) === manifest.fingerprint, 'ARTIFACT_INTEGRITY', 'Resolved specification does not match original run fingerprint');
  return spec;
}

/** Streaming hash verification scans the complete file before returning any selected records. */
async function visitRows(path: string, artifact: Artifact, visitor: (row: Record<string, unknown>, index: number) => void): Promise<void> {
  await regular(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), hash = createHash('sha256');
  let pending = Buffer.alloc(0), bytes = 0, count = 0;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); bytes += bytesRead;
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        assertThat(newline <= MAX_RECORD_BYTES, 'ARTIFACT_TOO_LARGE', 'Result record exceeds bounded size');
        const line = pending.subarray(0, newline).toString('utf8'); pending = pending.subarray(newline + 1);
        assertThat(line.length > 0, 'INVALID_ARTIFACT', 'Blank result records are forbidden');
        const row: unknown = JSON.parse(line);
        assertThat(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_ARTIFACT', 'Result rows must be objects');
        visitor(row as Record<string, unknown>, count++);
      }
      assertThat(pending.length <= MAX_RECORD_BYTES, 'ARTIFACT_TOO_LARGE', 'Result record exceeds bounded size');
    }
    assertThat(pending.length === 0, 'INVALID_ARTIFACT', 'JSONL artifact is not newline terminated');
    assertThat(bytes === artifact.bytes && count === artifact.rows && hash.digest('hex') === artifact.sha256, 'ARTIFACT_INTEGRITY', 'Result artifact hash, size or row count differs from manifest');
  } catch (error) { ioError(error, 'INVALID_ARTIFACT', 'Result rows are malformed or unreadable'); }
  finally { await handle.close(); }
}

function parseQuery(query: ResultQuery): Required<Pick<ResultQuery, 'table' | 'limit'>> & Omit<ResultQuery, 'limit'> {
  const parsed = querySchema.safeParse(query);
  assertThat(parsed.success, 'INVALID_RESULT_QUERY', 'Malformed result query', '', { issues: parsed.error?.issues });
  const q = parsed.data;
  assertThat(q.from === undefined || q.to === undefined || q.from < q.to, 'INVALID_RESULT_QUERY', 'Time range must be nonempty [from,to)');
  assertThat(q.table !== 'summary' || (q.from === undefined && q.to === undefined), 'INVALID_RESULT_QUERY', 'Summary has no row timestamp');
  if (q.fields) assertThat(new Set(q.fields).size === q.fields.length && q.fields.every(f => allowedFields[q.table].includes(f)), 'INVALID_PROJECTION', 'Projection has an unknown or duplicate field');
  for (const [field, value] of Object.entries(q.filter ?? {})) {
    assertThat(allowedFields[q.table].includes(field) && !objectFields.has(field), 'INVALID_FILTER', `Field ${field} cannot be filtered`);
    assertThat(value === null || typeof value === (numericFields.has(field) ? 'number' : 'string'), 'INVALID_FILTER', `Filter value for ${field} has the wrong type`);
  }
  return { ...q, limit: q.limit ?? 100 };
}
interface Cursor { v: 1; runId: string; table: ResultTable; artifact: string; query: string; offset: number }
function encodeCursor(cursor: Cursor, key: Buffer): string {
  const data = Buffer.from(canonicalJSON(cursor)).toString('base64url');
  return `${data}.${createHmac('sha256', key).update(data).digest('base64url')}`;
}
function decodeCursor(token: string, key: Buffer): Cursor {
  try {
    const parts = token.split('.');
    assertThat(parts.length === 2, 'INVALID_CURSOR', 'Malformed result cursor');
    const data = parts[0]!, actual = Buffer.from(parts[1]!, 'base64url'), expected = createHmac('sha256', key).update(data).digest();
    assertThat(actual.length === expected.length && timingSafeEqual(actual, expected), 'INVALID_CURSOR', 'Result cursor signature is invalid');
    const cursor = z.strictObject({ v: z.literal(1), runId: z.string().regex(RUN_ID), table: z.enum(tables), artifact: z.string().regex(HASH), query: z.string().regex(HASH), offset: z.number().int().nonnegative().safe() }).safeParse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
    assertThat(cursor.success, 'INVALID_CURSOR', 'Malformed result cursor payload');
    return cursor.data;
  } catch (error) { return ioError(error, 'INVALID_CURSOR', 'Malformed result cursor'); }
}

export async function queryResult(storeDir: string, runId: string, query: ResultQuery): Promise<ResultPage> {
  const q = parseQuery(query), manifest = await readManifest(storeDir, runId);
  requireTable(manifest, q.table);
  const path = await directory(storeDir, runId), artifact = manifest.artifacts[filenames[q.table]]!;
  const queryHash = contentHash({ table: q.table, fields: q.fields ?? null, filter: q.filter ?? {}, from: q.from ?? null, to: q.to ?? null });
  const key = await cursorKey(storeDir, false);
  let offset = 0;
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor, key);
    assertThat(cursor.runId === runId && cursor.table === q.table && cursor.artifact === artifact.sha256 && cursor.query === queryHash, 'CURSOR_MISMATCH', 'Cursor belongs to another run, table, artifact or query');
    assertThat(cursor.offset <= artifact.rows!, 'INVALID_CURSOR', 'Cursor exceeds stored row count');
    offset = cursor.offset;
  }
  const rows: Record<string, unknown>[] = [];
  let matchedRows = 0, nextOffset = 0, hasMore = false, selectedBytes = 2;
  const select = (row: Record<string, unknown>, index: number) => {
    const at = row[q.table === 'orders' ? 'submittedAt' : 'at'];
    if (q.from !== undefined && (typeof at !== 'number' || at < q.from)) return;
    if (q.to !== undefined && (typeof at !== 'number' || at >= q.to)) return;
    if (!Object.entries(q.filter ?? {}).every(([field, value]) => row[field] === value)) return;
    matchedRows++;
    if (index < offset) return;
    if (rows.length >= q.limit || hasMore) { hasMore = true; return; }
    const selected = q.fields ? Object.fromEntries(q.fields.filter(f => Object.hasOwn(row, f)).map(f => [f, row[f]])) : row;
    const rowBytes = Buffer.byteLength(canonicalJSON(selected)) + 1;
    if (selectedBytes + rowBytes > MAX_PAGE_BYTES) {
      assertThat(rows.length > 0, 'RESULT_ROW_TOO_LARGE', 'Selected row exceeds the 256 KiB page budget; request fewer fields', '', { table: q.table, useProjection: true });
      hasMore = true; return;
    }
    rows.push(selected); selectedBytes += rowBytes;
    nextOffset = index + 1;
  };
  if (q.table === 'summary') select(await checkedJSON(join(path, filenames.summary), artifact), 0);
  else await visitRows(join(path, filenames[q.table]), artifact, select);
  return { runId, table: q.table, rows, nextCursor: hasMore ? encodeCursor({ v: 1, runId, table: q.table, artifact: artifact.sha256, query: queryHash, offset: nextOffset }, key) : null, totalRows: artifact.rows!, matchedRows };
}

async function latestDecision(storeDir: string, manifest: RunManifest, symbol: string, at: number, includeSameTime: boolean): Promise<Record<string, unknown> | null> {
  if (!manifest.availableTables.includes('trace')) return null;
  const path = await directory(storeDir, manifest.runId);
  let latest: Record<string, unknown> | null = null;
  await visitRows(join(path, filenames.trace), manifest.artifacts[filenames.trace]!, row => {
    if (row.symbol === symbol && typeof row.at === 'number' && (includeSameTime ? row.at <= at : row.at < at) && (!latest || row.at >= Number(latest.at))) latest = row;
  });
  assertThat(!latest || Buffer.byteLength(canonicalJSON(latest)) <= MAX_PAGE_BYTES, 'RESULT_ROW_TOO_LARGE', 'Recorded decision exceeds the explanation budget; query the trace table with a field projection');
  return latest;
}

/** Explain only recorded facts. Missing context requires a complete, version-pinned rerun. */
export async function explainResult(storeDir: string, runId: string, query: ExplainQuery): Promise<Record<string, unknown>> {
  const parsed = z.strictObject({ orderId: z.string().min(1).max(128).optional(), fillId: z.string().min(1).max(128).optional(), at: z.number().int().nonnegative().safe().optional(), symbol: z.string().min(1).max(128).optional() }).safeParse(query);
  assertThat(parsed.success, 'INVALID_EXPLAIN_QUERY', 'Malformed explanation selector');
  const q = parsed.data;
  assertThat([q.orderId, q.fillId, q.at].filter(v => v !== undefined).length === 1 && (!q.symbol || q.at !== undefined), 'INVALID_EXPLAIN_QUERY', 'Specify exactly one of orderId, fillId or at; symbol is only valid with at');
  const manifest = await readManifest(storeDir, runId);
  if (q.at !== undefined) {
    requireTable(manifest, 'trace');
    const recordedDecisions = await queryResult(storeDir, runId, { table: 'trace', from: q.at, to: q.at + 1, ...(q.symbol ? { filter: { symbol: q.symbol } } : {}), limit: 100 });
    const ordersSubmitted = await queryResult(storeDir, runId, { table: 'orders', from: q.at, to: q.at + 1, ...(q.symbol ? { filter: { symbol: q.symbol } } : {}), limit: 100 });
    return { runId, kind: 'at', at: q.at, recordedDecisions, ordersSubmitted, limitations: recordedDecisions.matchedRows ? ['A matched rule is not proof of a fill; inspect its order and execution records.'] : ['No decision trace was recorded at this exact timestamp. No indicator values or trading rationale were inferred.'] };
  }
  requireTable(manifest, 'orders'); requireTable(manifest, 'fills');
  let selectedFill: Record<string, unknown> | undefined;
  if (q.fillId) {
    selectedFill = (await queryResult(storeDir, runId, { table: 'fills', filter: { id: q.fillId }, limit: 1 })).rows[0];
    assertThat(selectedFill, 'RESULT_ROW_NOT_FOUND', `Fill ${q.fillId} was not found`);
  }
  const orderId = q.orderId ?? String(selectedFill!.orderId);
  const order = (await queryResult(storeDir, runId, { table: 'orders', filter: { id: orderId }, limit: 1 })).rows[0];
  assertThat(order, 'RESULT_ROW_NOT_FOUND', `Order ${orderId} was not found`);
  const fills = await queryResult(storeDir, runId, { table: 'fills', filter: { orderId }, limit: 100 });
  const source = String(order.source);
  const decision = source === 'replay' ? null : await latestDecision(storeDir, manifest, String(order.symbol), Number(order.submittedAt), /^(rule|target@|rank)/.test(source));
  const limitations: string[] = [];
  if (!decision) limitations.push(manifest.availableTables.includes('trace') ? 'No applicable decision snapshot was recorded for this order; its source/reason and executions remain authoritative.' : 'Indicator/rule/state snapshots were not saved. Re-run the complete original specification at fullTrace with the original dataset and engine versions to obtain them.');
  if (decision) limitations.push('Decision context is the latest recorded snapshot available to this order, not a reconstruction of unrecorded intrabar indicators.');
  if (fills.nextCursor) limitations.push('Linked fills are paginated; continue with the supplied cursor rather than treating this page as the complete order.');
  const explanation: Record<string, unknown> = { runId, kind: q.fillId ? 'fill' : 'order', order, fills, decisionContext: decision, limitations, ...(selectedFill ? { selectedFill } : {}) };
  if (selectedFill && manifest.availableTables.includes('events')) explanation.ledgerEvents = await queryResult(storeDir, runId, { table: 'events', filter: { fillId: String(selectedFill.id) }, limit: 100 });
  return explanation;
}

/** Internal persistence primitives shared by run and study stores; schemas remain separate. */
export const artifactIO = { writeJSON, writeRows, readSmall, regular, checkedJSON, visitRows, cursorKey };
