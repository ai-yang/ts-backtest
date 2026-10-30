import { mkdir, realpath, lstat, readdir, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJSON, contentHash } from '../spec/canonical.js';
import { assertThat, BacktestError } from '../spec/errors.js';
import type { BacktestSpec } from '../spec/types.js';
import type { SweepResult } from '../research/sweep.js';
import type { WalkForwardResult } from '../research/walk-forward.js';
import type { FactorResult } from '../research/factors.js';
import { artifactIO, readManifest as readRunManifest, type Artifact } from './results.js';

export type StudyResult = SweepResult | WalkForwardResult | FactorResult;
export type StudyTable = 'summary' | 'candidates' | 'windows' | 'periods' | 'orderWindows';
export interface StudyInput { datasetId: string; planId?: string; specification?: BacktestSpec; request: unknown }
export interface StudyManifest {
  schemaVersion: '1'; studyId: string; kind: StudyResult['kind']; status: 'complete'; createdAt: string;
  datasetHash: string; fingerprint: string; engineVersion: string; availableTables: StudyTable[]; artifacts: Record<string, Artifact>;
  runId?: string;
}
export interface StudyQuery { table: StudyTable; limit?: number; cursor?: string; fields?: string[]; filter?: Record<string, string | number | null>; from?: number; to?: number }
export interface StudyPage { studyId: string; table: StudyTable; rows: Record<string, unknown>[]; nextCursor: string | null; totalRows: number; matchedRows: number }
const tables = ['summary', 'candidates', 'windows', 'periods', 'orderWindows'] as const;
const idPattern = /^study_[A-Za-z0-9_-]{1,80}$/;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const tableForKind = { sweep: ['summary', 'candidates'], walk_forward: ['summary', 'windows', 'orderWindows'], factors: ['summary', 'periods'] } satisfies Record<StudyResult['kind'], StudyTable[]>;
const filename = (table: StudyTable) => table === 'summary' ? 'summary.json' : `${table}.jsonl`;
const fields: Record<StudyTable, string[]> = {
  summary: ['schemaVersion', 'kind', 'engineVersion', 'datasetHash', 'fingerprint', 'objective', 'seed', 'candidateCount', 'winnerId', 'sharedDatasetBytes', 'policies', 'unusedTailSessions', 'limitations', 'runId', 'metrics', 'feature', 'horizonBars', 'from', 'to', 'observations', 'summary', 'excluded'],
  candidates: ['id', 'parameters', 'seed', 'status', 'score', 'metrics', 'fingerprint', 'error'],
  windows: ['index', 'trainStart', 'trainEnd', 'testStart', 'testEnd', 'selectedAt', 'selected', 'sweepFingerprint', 'candidateCount', 'compiledRuleIndexes'],
  periods: ['at', 'count', 'ic', 'rankIC', 'groups', 'topMinusBottom'],
  orderWindows: ['orderId', 'windowIndex', 'candidateId', 'selectedAt'],
};
const nested = new Set(['objective', 'policies', 'limitations', 'metrics', 'summary', 'excluded', 'parameters', 'error', 'selected', 'compiledRuleIndexes', 'groups']);
const numeric = new Set(['seed', 'candidateCount', 'sharedDatasetBytes', 'unusedTailSessions', 'horizonBars', 'from', 'to', 'observations', 'index', 'trainStart', 'trainEnd', 'testStart', 'testEnd', 'selectedAt', 'at', 'count', 'ic', 'rankIC', 'topMinusBottom', 'windowIndex']);
const manifestSchema = z.strictObject({ schemaVersion: z.literal('1'), studyId: z.string().regex(idPattern), kind: z.enum(['sweep', 'walk_forward', 'factors']), status: z.literal('complete'), createdAt: z.iso.datetime(), datasetHash: hash, fingerprint: hash, engineVersion: z.string().min(1).max(128), availableTables: z.array(z.enum(tables)), artifacts: z.record(z.string(), z.strictObject({ sha256: hash, bytes: z.number().int().nonnegative().safe(), rows: z.number().int().nonnegative().safe().optional(), table: z.enum(tables).optional() })), runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,80}$/).optional() });
const querySchema = z.strictObject({ table: z.enum(tables), limit: z.number().int().min(1).max(200).default(100), cursor: z.string().min(1).max(4096).optional(), fields: z.array(z.string().max(128)).min(1).max(32).optional(), filter: z.record(z.string().max(128), z.union([z.string().max(1024), z.number().finite(), z.null()])).optional(), from: z.number().int().nonnegative().safe().optional(), to: z.number().int().nonnegative().safe().optional() });
function validId(id: string) { assertThat(typeof id === 'string' && idPattern.test(id), 'INVALID_STUDY_ID', 'Invalid study handle'); }
async function studyRoot(storeDir: string, create = false): Promise<string> {
  if (create) await mkdir(resolve(storeDir), { recursive: true });
  const root = await realpath(resolve(storeDir)), path = join(root, 'studies');
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  assertThat(info.isDirectory() && !info.isSymbolicLink(), 'UNSAFE_STUDY_PATH', 'studies must be an owned real directory');
  return path;
}
async function studyDirectory(storeDir: string, id: string): Promise<string> {
  validId(id); const path = join(await studyRoot(storeDir), id);
  let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BacktestError('STUDY_NOT_FOUND', 'Study handle does not exist'); throw error; }
  assertThat(info.isDirectory() && !info.isSymbolicLink(), 'UNSAFE_STUDY_PATH', 'Study must be a real directory'); return path;
}
export async function cleanupStagingStudies(storeDir: string): Promise<void> {
  let root: string; try { root = await studyRoot(storeDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of await readdir(root)) if (/^\.staging-study_[A-Za-z0-9_-]{1,80}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)) {
    const path = join(root, name), info = await lstat(path); assertThat(info.isDirectory() && !info.isSymbolicLink(), 'UNSAFE_STUDY_PATH', 'Study staging must be a real directory'); await rm(path, { recursive: true, force: true });
  }
}
export async function persistStudy(storeDir: string, studyId: string, result: StudyResult, input: StudyInput, options: { maxBytes?: number; runId?: string } = {}): Promise<StudyManifest> {
  validId(studyId);
  assertThat(input.datasetId === `ds_${result.datasetHash.slice(0, 24)}`, 'STUDY_DATASET_MISMATCH', 'Study input handle does not match its dataset hash');
  assertThat((result.kind === 'walk_forward') === Boolean(options.runId), 'WF_RUN_REQUIRED', 'Only walk-forward studies must reference a continuous run');
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024; assertThat(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'INVALID_OUTPUT_BUDGET', 'Study byte budget must be positive');
  const budget = { remaining: maxBytes }, root = await studyRoot(storeDir, true), destination = join(root, studyId), staging = join(root, `.staging-${studyId}-${randomUUID()}`);
  try { await lstat(destination); throw new BacktestError('STUDY_EXISTS', 'Immutable study already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let summary: unknown; const rows: Partial<Record<StudyTable, unknown[]>> = {};
  if (result.kind === 'sweep') { const { candidates, ...value } = result; summary = value; rows.candidates = candidates; }
  else if (result.kind === 'factors') { const { periods, ...value } = result; summary = value; rows.periods = periods; }
  else {
    assertThat(options.runId, 'WF_RUN_REQUIRED', 'Walk-forward study must reference its persisted continuous run');
    const run = await readRunManifest(storeDir, options.runId!);
    assertThat(run.fingerprint === result.continuous.fingerprint && run.datasetHash === result.datasetHash, 'STUDY_RUN_MISMATCH', 'Continuous run does not match walk-forward study');
    const { continuous, windows, orderWindows, ...value } = result; summary = { ...value, runId: options.runId, metrics: continuous.metrics }; rows.windows = windows; rows.orderWindows = orderWindows;
  }
  await artifactIO.cursorKey(storeDir, true); await mkdir(staging, { mode: 0o700 });
  try {
    const availableTables = tableForKind[result.kind], artifacts: Record<string, Artifact> = {};
    artifacts['resolved-input.json'] = await artifactIO.writeJSON(join(staging, 'resolved-input.json'), input, undefined, budget);
    artifacts['summary.json'] = await artifactIO.writeJSON(join(staging, 'summary.json'), summary, 'summary', budget);
    for (const table of availableTables) if (table !== 'summary') artifacts[filename(table)] = await artifactIO.writeRows(join(staging, filename(table)), rows[table]!, table, budget);
    const manifest: StudyManifest = { schemaVersion: '1', studyId, kind: result.kind, status: 'complete', createdAt: new Date().toISOString(), engineVersion: result.engineVersion, datasetHash: result.datasetHash, fingerprint: result.fingerprint, availableTables: [...availableTables], artifacts, ...(options.runId ? { runId: options.runId } : {}) };
    assertThat(manifestSchema.safeParse(manifest).success, 'INVALID_STUDY', 'Invalid study provenance');
    await artifactIO.writeJSON(join(staging, 'manifest.json'), manifest, undefined, budget); await rename(staging, destination); return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
export async function readStudyManifest(storeDir: string, studyId: string): Promise<StudyManifest> {
  const path = await studyDirectory(storeDir, studyId);
  try {
    const parsed = manifestSchema.safeParse(JSON.parse((await artifactIO.readSmall(join(path, 'manifest.json'), 256 * 1024)).toString('utf8')));
    assertThat(parsed.success, 'INVALID_STUDY_MANIFEST', 'Malformed study manifest'); const manifest = parsed.data;
    assertThat(manifest.studyId === studyId && canonicalJSON(manifest.availableTables) === canonicalJSON(tableForKind[manifest.kind]), 'INVALID_STUDY_MANIFEST', 'Study identity or table set differs');
    assertThat((manifest.kind === 'walk_forward') === Boolean(manifest.runId), 'INVALID_STUDY_MANIFEST', 'Only walk-forward studies reference continuous runs');
    const files = ['resolved-input.json', ...manifest.availableTables.map(filename)].sort();
    assertThat(canonicalJSON(Object.keys(manifest.artifacts).sort()) === canonicalJSON(files), 'INVALID_STUDY_MANIFEST', 'Study artifacts differ from declared table set');
    for (const [file, artifact] of Object.entries(manifest.artifacts)) {
      const table = manifest.availableTables.find(value => filename(value) === file);
      assertThat(table ? artifact.table === table && artifact.rows !== undefined && (table !== 'summary' || artifact.rows === 1) : artifact.table === undefined && artifact.rows === undefined, 'INVALID_STUDY_MANIFEST', 'Study artifact table metadata differs');
      await artifactIO.regular(join(path, file)); assertThat((await lstat(join(path, file))).size === artifact.bytes, 'ARTIFACT_INTEGRITY', 'Study artifact size differs from manifest');
    }
    return manifest;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BacktestError('ARTIFACT_MISSING', 'Study artifact is missing'); throw error; }
}

export async function queryStudy(storeDir: string, studyId: string, input: StudyQuery): Promise<StudyPage> {
  const parsed = querySchema.safeParse(input); assertThat(parsed.success, 'INVALID_STUDY_QUERY', 'Malformed study query'); const query = parsed.data;
  assertThat(query.from === undefined || query.to === undefined || query.from < query.to, 'INVALID_STUDY_QUERY', 'Time range must be nonempty [from,to)');
  const timeKey = query.table === 'windows' ? 'testStart' : query.table === 'periods' ? 'at' : query.table === 'orderWindows' ? 'selectedAt' : undefined;
  assertThat(timeKey || (query.from === undefined && query.to === undefined), 'INVALID_STUDY_QUERY', 'This table has no row timestamp');
  if (query.fields) assertThat(new Set(query.fields).size === query.fields.length && query.fields.every(field => fields[query.table].includes(field)), 'INVALID_PROJECTION', 'Unknown or duplicate study projection');
  for (const [field, value] of Object.entries(query.filter ?? {})) {
    assertThat(fields[query.table].includes(field) && !nested.has(field), 'INVALID_FILTER', 'Field cannot be filtered');
    assertThat(value === null || field === 'score' || typeof value === (numeric.has(field) ? 'number' : 'string'), 'INVALID_FILTER', 'Filter value has the wrong type');
  }
  const manifest = await readStudyManifest(storeDir, studyId); assertThat(manifest.availableTables.includes(query.table), 'STUDY_TABLE_UNAVAILABLE', 'Table is not available for this study kind');
  const path = await studyDirectory(storeDir, studyId), artifact = manifest.artifacts[filename(query.table)]!, key = await artifactIO.cursorKey(storeDir, false);
  const queryHash = contentHash({ table: query.table, fields: query.fields ?? null, filter: query.filter ?? {}, from: query.from ?? null, to: query.to ?? null });
  let offset = 0;
  if (query.cursor) {
    try {
      const parts = query.cursor.split('.'); assertThat(parts.length === 2, 'INVALID_CURSOR', 'Malformed cursor');
      const expected = createHmac('sha256', key).update(parts[0]!).digest(), actual = Buffer.from(parts[1]!, 'base64url');
      assertThat(actual.length === expected.length && timingSafeEqual(actual, expected), 'INVALID_CURSOR', 'Cursor signature differs');
      const decoded = z.strictObject({ v: z.literal(1), studyId: z.string().regex(idPattern), table: z.enum(tables), artifact: hash, query: hash, offset: z.number().int().nonnegative().safe() }).safeParse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
      assertThat(decoded.success, 'INVALID_CURSOR', 'Malformed study cursor'); const cursor = decoded.data;
      assertThat(cursor.studyId === studyId && cursor.table === query.table && cursor.artifact === artifact.sha256 && cursor.query === queryHash, 'CURSOR_MISMATCH', 'Cursor belongs to another study or query');
      assertThat(cursor.offset <= artifact.rows!, 'INVALID_CURSOR', 'Cursor exceeds row count'); offset = cursor.offset;
    } catch (error) { if (error instanceof BacktestError) throw error; throw new BacktestError('INVALID_CURSOR', 'Malformed study cursor'); }
  }
  const rows: Record<string, unknown>[] = []; let nextOffset = 0, hasMore = false, matchedRows = 0, selectedBytes = 2;
  const select = (row: Record<string, unknown>, index: number) => {
    const at = timeKey ? row[timeKey] : undefined;
    if (query.from !== undefined && (typeof at !== 'number' || at < query.from)) return;
    if (query.to !== undefined && (typeof at !== 'number' || at >= query.to)) return;
    if (!Object.entries(query.filter ?? {}).every(([field, value]) => row[field] === value)) return;
    matchedRows++; if (index < offset) return;
    if (hasMore || rows.length >= query.limit) { hasMore = true; return; }
    const selected = query.fields ? Object.fromEntries(query.fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])) : row;
    const bytes = Buffer.byteLength(canonicalJSON(selected)) + 1;
    if (selectedBytes + bytes > 256 * 1024) { assertThat(rows.length > 0, 'RESULT_ROW_TOO_LARGE', 'Study row exceeds 256 KiB; use projection'); hasMore = true; return; }
    rows.push(selected); selectedBytes += bytes; nextOffset = index + 1;
  };
  if (query.table === 'summary') {
    const summary = await artifactIO.checkedJSON(join(path, filename(query.table)), artifact);
    assertThat(summary.fingerprint === manifest.fingerprint && summary.datasetHash === manifest.datasetHash && summary.engineVersion === manifest.engineVersion && summary.kind === manifest.kind, 'ARTIFACT_INTEGRITY', 'Study summary provenance differs from manifest');
    select(summary, 0);
  }
  else await artifactIO.visitRows(join(path, filename(query.table)), artifact, select);
  const payload = Buffer.from(canonicalJSON({ v: 1, studyId, table: query.table, artifact: artifact.sha256, query: queryHash, offset: nextOffset })).toString('base64url');
  return { studyId, table: query.table, rows, nextCursor: hasMore ? `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}` : null, matchedRows, totalRows: artifact.rows! };
}
