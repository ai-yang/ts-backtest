import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { BacktestService, type ServiceOptions, type JobStatus } from '../src/runtime/manager.js';
import { queryStudy, readStudyManifest, cleanupStagingStudies, type StudyQuery } from '../src/runtime/research-results.js';
import { readSummary } from '../src/runtime/results.js';
import { input, spec, sessions, closeAt } from './helpers.js';
import type { SweepRequest } from '../src/research/sweep.js';
import type { WalkForwardRequest } from '../src/research/walk-forward.js';

async function poll(service: BacktestService, id: string): Promise<JobStatus> {
  for (let i = 0; i < 1500; i++) { const result = await service.job(id); if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(result.state)) return result; await delay(5); }
  throw new Error('Research fixture timed out');
}
async function fixture(t: { after(fn: () => Promise<void>): void }, overrides: Partial<ServiceOptions> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'ts-backtest-runtime-research-')), storeDir = join(workspace, 'store');
  const options = { workspace, storeDir, ...overrides }, service = new BacktestService(options);
  t.after(async () => { await service.close(); await rm(workspace, { recursive: true, force: true }); });
  const raw = input(['10', '10', '12', '13', '14', '15', '16', '17']);
  raw.features = [{ symbol: 'AAA', name: 'prediction', availableAt: closeAt(sessions[0]!), value: 1 }];
  await writeFile(join(workspace, 'prices.json'), JSON.stringify(raw));
  await service.init();
  const prepared = await poll(service, (await service.prepare({ path: 'prices.json', format: 'json' })).id);
  assert.equal(prepared.state, 'succeeded', JSON.stringify(prepared));
  const datasetId = prepared.result!.datasetId!;
  const plan = await service.validate(datasetId, spec({ end: closeAt(sessions[7]!) + 1, strategy: { kind: 'rules', nodes: {}, rules: [{ when: { value: true }, action: { type: 'target_quantity', value: 1 } }] } }));
  return { workspace, storeDir, options, service, datasetId, planId: plan.planId };
}
const request: SweepRequest = { space: { '/strategy/rules/0/action/value': [1, 2, 3] }, objective: { metric: 'netProfit', direction: 'maximize' }, seed: 42 };
const wf: WalkForwardRequest = { ...request, trainSessions: 3, testSessions: 2, mode: 'rolling', warmup: 'all_prior', positionPolicy: 'carry', pendingOrderPolicy: 'carry' };

test('async research jobs commit durable study handles with exact cursor pagination', async t => {
  const f = await fixture(t), pending = await f.service.sweep(f.planId, request);
  assert.ok(['queued', 'running'].includes(pending.state));
  const done = await poll(f.service, pending.id); assert.equal(done.state, 'succeeded', JSON.stringify(done));
  const studyId = String(done.result!.studyId);
  assert.match(studyId, /^study_/); assert.equal(done.result!.runId, undefined);
  const manifest = await readStudyManifest(f.storeDir, studyId); assert.equal(manifest.kind, 'sweep');
  const a = await f.service.study(studyId, { table: 'candidates', limit: 2, fields: ['id', 'seed'] });
  const b = await f.service.study(studyId, { table: 'candidates', limit: 2, fields: ['id', 'seed'], cursor: a.nextCursor! });
  assert.equal(a.totalRows, 3); assert.equal(b.nextCursor, null);
  assert.equal(new Set([...a.rows, ...b.rows].map(row => row.id)).size, 3);
  await f.service.close();
  const restarted = new BacktestService(f.options); await restarted.init();
  try {
    assert.deepEqual(await restarted.job(pending.id), done);
    assert.equal((await restarted.study(studyId, { table: 'summary' })).rows[0]!.candidateCount, 3);
  } finally { await restarted.close(); }
});

test('walk-forward study links a real continuous run and factors retain independent period tables', async t => {
  const f = await fixture(t), done = await poll(f.service, (await f.service.walkForward(f.planId, wf)).id);
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  const studyId = String(done.result!.studyId), runId = done.result!.runId!;
  const summary = (await f.service.study(studyId, { table: 'summary' })).rows[0]!;
  assert.equal(summary.runId, runId);
  assert.deepEqual(summary.metrics, (await readSummary(f.storeDir, runId)).metrics);
  const windows = await f.service.study(studyId, { table: 'windows' }); assert.equal(windows.rows.length, 2);
  assert.ok((await f.service.study(studyId, { table: 'orderWindows' })).rows.length > 0);
  const factors = await poll(f.service, (await f.service.factors(f.datasetId, { feature: 'prediction', from: closeAt(sessions[0]!), to: closeAt(sessions[7]!) + 1, horizonBars: 1 })).id);
  assert.equal(factors.state, 'succeeded', JSON.stringify(factors));
  assert.equal(factors.result!.runId, undefined);
  assert.equal((await f.service.study(String(factors.result!.studyId), { table: 'periods' })).totalRows, 8);
  await assert.rejects(f.service.study(studyId, { table: 'candidates' }), { code: 'STUDY_TABLE_UNAVAILABLE' });
});

test('global research worker allowance queues a second study and cancellation releases its reservation', async t => {
  const f = await fixture(t, { concurrency: 2, maxResearchWorkers: 2 });
  const large = { ...request, space: { '/strategy/rules/0/action/value': Array.from({ length: 1000 }, (_, index) => index + 1) }, concurrency: 2 };
  const first = await f.service.sweep(f.planId, large), second = await f.service.sweep(f.planId, request);
  assert.equal(second.state, 'queued', 'available parent slots must respect the shared child worker allowance');
  const slots = (f.service as unknown as { slots: Array<{ researchWorkers?: number }> }).slots;
  assert.equal(slots.reduce((sum, slot) => sum + (slot.researchWorkers ?? 0), 0), 2);
  await f.service.job(first.id, 'cancel');
  assert.equal((await poll(f.service, first.id)).state, 'canceled');
  const complete = await poll(f.service, second.id); assert.equal(complete.state, 'succeeded', JSON.stringify(complete));
  assert.equal((await readdir(join(f.storeDir, 'studies'))).length, 1);
  await assert.rejects(f.service.sweep(f.planId, { ...request, concurrency: 3 }), { code: 'RESOURCE_LIMIT' });
});

test('study queries reject cross-study cursors, malformed projections, altered hashes and missing files', async t => {
  const f = await fixture(t);
  const a = await poll(f.service, (await f.service.sweep(f.planId, request)).id), b = await poll(f.service, (await f.service.sweep(f.planId, request)).id);
  const idA = String(a.result!.studyId), idB = String(b.result!.studyId), page = await queryStudy(f.storeDir, idA, { table: 'candidates', limit: 1 });
  await assert.rejects(queryStudy(f.storeDir, idB, { table: 'candidates', cursor: page.nextCursor! }), { code: 'CURSOR_MISMATCH' });
  await assert.rejects(queryStudy(f.storeDir, idA, { table: 'candidates', cursor: page.nextCursor!, fields: ['id'] }), { code: 'CURSOR_MISMATCH' });
  for (const bad of [{ table: 'candidates', fields: ['missing'] }, { table: 'candidates', filter: { metrics: null } }, { table: 'candidates', limit: 201 }, { table: 'candidates', offset: 1 }]) await assert.rejects(queryStudy(f.storeDir, idA, bad as StudyQuery));
  const path = join(f.storeDir, 'studies', idA, 'candidates.jsonl'), text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('"status":"succeeded"', '"status":"succEeded"'));
  await assert.rejects(queryStudy(f.storeDir, idA, { table: 'candidates' }), { code: 'ARTIFACT_INTEGRITY' });
  await unlink(join(f.storeDir, 'studies', idB, 'candidates.jsonl'));
  await assert.rejects(queryStudy(f.storeDir, idB, { table: 'summary' }), { code: 'ARTIFACT_MISSING' });
});

test('study storage budgets publish no partial artifacts and quota includes studies', async t => {
  const f = await fixture(t, { maxOutputBytes: 100 });
  const done = await poll(f.service, (await f.service.sweep(f.planId, request)).id);
  assert.equal(done.state, 'failed'); assert.equal(done.error!.code, 'OUTPUT_BYTE_LIMIT');
  assert.deepEqual(await readdir(join(f.storeDir, 'studies')), []);
  const policy = JSON.parse(await readFile(join(f.storeDir, 'store-policy.json'), 'utf8'));
  assert.ok(policy.quotaIncludes.includes('studies'));
  assert.equal(policy.temporaryLimits.totalWorkers, 4);
});

test('walk-forward study failure rolls back its newly committed continuous run', async t => {
  const f = await fixture(t), done = await poll(f.service, (await f.service.walkForward(f.planId, wf)).id);
  assert.equal(done.state, 'succeeded');
  const runId = done.result!.runId!, files = await readdir(join(f.storeDir, 'runs', runId));
  let bytes = 0; for (const name of files) bytes += (await stat(join(f.storeDir, 'runs', runId, name))).size;
  await f.service.close();
  const limited = new BacktestService({ ...f.options, maxOutputBytes: bytes + 100 }); await limited.init();
  try {
    const failed = await poll(limited, (await limited.walkForward(f.planId, wf)).id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.error!.code, 'OUTPUT_BYTE_LIMIT');
    assert.deepEqual(await readdir(join(f.storeDir, 'runs')), [runId]);
    assert.deepEqual(await readdir(join(f.storeDir, 'studies')), [String(done.result!.studyId)]);
  } finally { await limited.close(); }
});

test('study recovery removes owned staging only and rejects symlink escapes', async t => {
  const f = await fixture(t), studies = join(f.storeDir, 'studies'), orphan = `.staging-study_abandoned-${randomUUID()}`;
  await mkdir(join(studies, orphan)); await writeFile(join(studies, orphan, 'partial'), 'partial');
  await mkdir(join(studies, '.staging-unrelated'));
  await cleanupStagingStudies(f.storeDir);
  assert.deepEqual(await readdir(studies), ['.staging-unrelated']);
  const external = join(f.workspace, 'external'); await mkdir(external); await writeFile(join(external, 'keep'), 'keep');
  await symlink(external, join(studies, `.staging-study_link-${randomUUID()}`), 'dir');
  await assert.rejects(cleanupStagingStudies(f.storeDir), { code: 'UNSAFE_STUDY_PATH' });
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'keep');
  await assert.rejects(queryStudy(f.storeDir, '../escape', { table: 'summary' }), { code: 'INVALID_STUDY_ID' });
});
