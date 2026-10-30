import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir, symlink, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BacktestService, type ServiceOptions, type JobStatus } from '../src/runtime/manager.js';
import { readManifest, readSummary } from '../src/runtime/results.js';
import { input, spec, instrument } from './helpers.js';
import type { DatasetInput } from '../src/spec/types.js';

const terminal = (s: JobStatus) => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(s.state);
async function poll(service: BacktestService, id: string, predicate = terminal): Promise<JobStatus> {
  const end = Date.now() + 20_000;
  do { const value = await service.job(id); if (predicate(value)) return value; await delay(5); } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${id}`);
}
async function fixture(options: Partial<ServiceOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'backtest-runtime-'));
  const workspace = join(root, 'workspace'), storeDir = join(root, 'store');
  await mkdir(workspace); await writeFile(join(workspace, 'bars.json'), JSON.stringify(input()));
  const service = new BacktestService({ workspace, storeDir, concurrency: 1, ...options });
  await service.init();
  return { root, workspace, storeDir, service, async dispose() { await service.close(); await rm(root, { recursive: true, force: true }); } };
}
function minuteInput(count = 20_000): DatasetInput {
  const result = input(); result.metadata.frequency = 'minute'; result.metadata.instruments = [instrument()];
  result.metadata.sessions = []; result.bars = [];
  for (let i = 0; i < count; i++) {
    const day = Math.floor(i / 250), session = new Date(Date.UTC(2024, 0, 1 + day)).toISOString().slice(0, 10);
    if (i % 250 === 0) result.metadata.sessions.push(session);
    const openTime = Date.parse(`${session}T01:30:00Z`) + (i % 250) * 60_000;
    result.bars.push({ symbol: 'AAA', session, openTime, closeTime: openTime + 60_000, open: '10', high: '10', low: '10', close: '10', volume: 1000, amount: '10000', tradable: true });
  }
  return result;
}
async function prepare(service: BacktestService, path = 'bars.json') {
  const job = await service.prepare({ path, format: 'json' });
  const complete = await poll(service, job.id); assert.equal(complete.state, 'succeeded', JSON.stringify(complete.error));
  return complete.result!.datasetId!;
}

test('terminal job status is visible only after temporary staging has been cleaned', async () => {
  const f = await fixture({ maxStoreBytes: 1 });
  let entered!: () => void, release!: () => void;
  const cleaning = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const internal = f.service as unknown as { cleanupStage(id: string): Promise<void> };
  const cleanup = internal.cleanupStage.bind(f.service);
  internal.cleanupStage = async id => { entered(); await proceed; await cleanup(id); };
  try {
    const handle = await f.service.prepare({ path: 'bars.json', format: 'json' });
    await cleaning;
    const duringCleanup = await f.service.job(handle.id);
    assert.equal(duringCleanup.state, 'running', 'terminal status must not race ahead of staging cleanup');
    const rejected = await f.service.job(handle.id, 'cancel');
    assert.equal(rejected.cancellation?.accepted, false);
    assert.equal(rejected.cancellation?.reason, 'COMMIT_ALREADY_STARTED');
    release();
    const done = await poll(f.service, handle.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.error!.code, 'STORE_QUOTA_EXCEEDED');
    assert.deepEqual(await readdir(join(f.storeDir, 'staging')), []);
    const stored = JSON.parse(await readFile(join(f.storeDir, 'jobs', `${handle.id}.json`), 'utf8'));
    assert.equal(stored.status.state, 'failed', 'rejected cancellation cannot overwrite the durable terminal state');
  } finally { release(); await f.dispose(); }
});

test('durable prepare, plan and result handles survive a clean restart', async () => {
  const f = await fixture();
  try {
    const datasetId = await prepare(f.service);
    const validated = await f.service.validate(datasetId, spec());
    const job = await f.service.run(validated.planId); assert.ok(['queued', 'running'].includes(job.state));
    const done = await poll(f.service, job.id); assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    const runId = done.result!.runId!;
    assert.equal((await readManifest(f.storeDir, runId)).datasetHash.length, 64);
    const summary = await readSummary(f.storeDir, runId); assert.equal(summary.metrics.finalEquity, '1100.00');
    const manifest = JSON.parse(await readFile(join(f.storeDir, 'datasets', `${datasetId}.manifest.json`), 'utf8'));
    assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);
    const importedJobs = await readdir(join(f.storeDir, 'jobs'));
    const preparedRecords = await Promise.all(importedJobs.map(name => readFile(join(f.storeDir, 'jobs', name), 'utf8').then(value => JSON.parse(value))));
    const prepared = preparedRecords.find(record => record.status.kind === 'prepare').status.result;
    assert.equal(prepared.metadata, undefined); assert.equal(prepared.coverage.sessionCount, input().metadata.sessions.length);
    assert.ok(Buffer.byteLength(JSON.stringify(prepared)) < 4096);
    await f.service.close();
    const restart = new BacktestService({ workspace: f.workspace, storeDir: f.storeDir }); await restart.init();
    try { assert.deepEqual(await restart.job(job.id), done); const next = await poll(restart, (await restart.run(validated.planId)).id); assert.equal(next.state, 'succeeded'); }
    finally { await restart.close(); }
  } finally { await f.dispose(); }
});

test('bounded queue cancels queued work without creating data or a worker slot', async () => {
  const f = await fixture({ maxQueuedJobs: 2 });
  try {
    await writeFile(join(f.workspace, 'large.json'), JSON.stringify(minuteInput()));
    const first = await f.service.prepare({ path: 'large.json', format: 'json' });
    const second = await f.service.prepare({ path: 'bars.json', format: 'json' });
    assert.equal(second.state, 'queued');
    await assert.rejects(f.service.prepare({ path: 'bars.json', format: 'json' }), { code: 'QUEUE_LIMIT' });
    const canceled = await f.service.job(second.id, 'cancel'); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.result, undefined);
    assert.equal((await poll(f.service, first.id)).state, 'succeeded');
    assert.equal((await f.service.job(second.id)).state, 'canceled');
  } finally { await f.dispose(); }
});

test('background validation returns a cancellable queued handle and the completed plan matches waiting validation', async () => {
  const f = await fixture();
  try {
    const datasetId = await prepare(f.service);
    await writeFile(join(f.workspace, 'large.json'), JSON.stringify(minuteInput(30_000)));
    const busy = await f.service.prepare({ path: 'large.json', format: 'json' });
    const queued = await f.service.validateJob(datasetId, spec());
    assert.equal(queued.kind, 'validate'); assert.equal(queued.state, 'queued'); assert.equal(queued.result, undefined);
    const canceled = await f.service.job(queued.id, 'cancel');
    assert.equal(canceled.state, 'canceled'); assert.equal(canceled.cancellation?.accepted, true);
    assert.equal((await poll(f.service, busy.id)).state, 'succeeded');
    const handle = await f.service.validateJob(datasetId, spec());
    const complete = await poll(f.service, handle.id);
    assert.equal(complete.state, 'succeeded', JSON.stringify(complete.error));
    const waited = await f.service.validate(datasetId, spec());
    assert.equal(complete.result!.planId, waited.planId);
    assert.deepEqual(complete.result!.resolvedSpec, waited.resolvedSpec);
    assert.equal((await poll(f.service, (await f.service.run(waited.planId)).id)).state, 'succeeded');
  } finally { await f.dispose(); }
});

test('running engine honors shared cancellation and publishes no result', async () => {
  const f = await fixture();
  try {
    const data = minuteInput(30_000); await writeFile(join(f.workspace, 'large.json'), JSON.stringify(data));
    const datasetId = await prepare(f.service, 'large.json');
    const plan = await f.service.validate(datasetId, spec({ start: data.bars[0]!.openTime, end: data.bars.at(-1)!.closeTime + 1, strategy: { kind: 'targets', schedule: [{ at: data.bars[0]!.closeTime, availableAt: data.bars[0]!.closeTime, weights: { AAA: 0 } }] }, output: { level: 'summary' } }));
    const job = await f.service.run(plan.planId);
    await poll(f.service, job.id, s => s.progress?.stage === 'running' || terminal(s));
    const request = await f.service.job(job.id, 'cancel'); assert.equal(request.cancellation?.accepted, true);
    const done = await poll(f.service, job.id); assert.equal(done.state, 'canceled'); assert.equal(done.result, undefined);
    const next = await prepare(f.service); assert.match(next, /^ds_/);
  } finally { await f.dispose(); }
});

test('forced termination cancels normalization and its old timer cannot stop the next job', async () => {
  const f = await fixture({ cancelGraceMs: 1 });
  try {
    await writeFile(join(f.workspace, 'large.json'), JSON.stringify(minuteInput(30_000)));
    const job = await f.service.prepare({ path: 'large.json', format: 'json' });
    await poll(f.service, job.id, s => s.progress?.stage === 'normalizing' || terminal(s));
    await f.service.job(job.id, 'cancel');
    const next = await f.service.prepare({ path: 'bars.json', format: 'json' });
    const done = await poll(f.service, job.id); assert.equal(done.state, 'canceled'); assert.equal(done.cancellation?.reason, 'WORKER_TERMINATED');
    assert.equal((await poll(f.service, next.id)).state, 'succeeded');
    await delay(30); assert.equal((await f.service.job(next.id)).state, 'succeeded');
    assert.deepEqual(await readdir(join(f.storeDir, 'staging')), []);
  } finally { await f.dispose(); }
});

test('close while a job is starting interrupts it and releases store ownership', async () => {
  const f = await fixture();
  try {
    const job = await f.service.prepare({ path: 'bars.json', format: 'json' }); await f.service.close();
    const next = new BacktestService({ workspace: f.workspace, storeDir: f.storeDir }); await next.init();
    try { assert.equal((await next.job(job.id)).state, 'interrupted'); assert.match(await prepare(next), /^ds_/); }
    finally { await next.close(); }
  } finally { await f.dispose(); }
});

test('a killed owner is recovered, unfinished jobs become interrupted and staging is removed', async () => {
  const f = await fixture(); await f.service.close();
  const script = `import {BacktestService} from ${JSON.stringify(new URL('../src/runtime/manager.js', import.meta.url).href)}; const s=new BacktestService(${JSON.stringify({ workspace: f.workspace, storeDir: f.storeDir })}); await s.init(); const j=await s.prepare({path:'bars.json',format:'json'}); process.stdout.write(JSON.stringify(j)+'\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let text = ''; const id = await new Promise<string>((resolve, reject) => { child.stdout.on('data', c => { text += String(c); if (text.includes('\n')) resolve((JSON.parse(text.split('\n')[0]!) as JobStatus).id); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Child exited ${code}`))); });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const stage = join(f.storeDir, 'staging', id); await mkdir(stage, { recursive: true }); await writeFile(join(stage, 'orphan'), 'partial');
    const next = new BacktestService({ workspace: f.workspace, storeDir: f.storeDir }); await next.init();
    try { assert.equal((await next.job(id)).state, 'interrupted'); assert.deepEqual(await readdir(join(f.storeDir, 'staging')), []); }
    finally { await next.close(); }
  } finally { child.kill('SIGKILL'); await f.dispose(); }
});

test('live store owner is exclusive and path bounds reject traversal and symlinks', async () => {
  const f = await fixture();
  try {
    const duplicate = new BacktestService({ workspace: f.workspace, storeDir: f.storeDir });
    await assert.rejects(duplicate.init(), { code: 'STORE_IN_USE' }); await duplicate.close();
    await writeFile(join(f.root, 'outside.json'), JSON.stringify(input())); await symlink(join(f.root, 'outside.json'), join(f.workspace, 'escape.json'));
    for (const path of ['../outside.json', join(f.root, 'outside.json'), 'escape.json']) await assert.rejects(f.service.prepare({ path, format: 'json' }), { code: 'PATH_NOT_AUTHORIZED' });
    await assert.rejects(f.service.job('../outside'), { code: 'INVALID_HANDLE' });
    const other = join(f.root, 'badstore'); await mkdir(other); await symlink(f.workspace, join(other, 'datasets'));
    const bad = new BacktestService({ workspace: f.workspace, storeDir: other });
    await assert.rejects(bad.init(), { code: 'PATH_NOT_AUTHORIZED' }); await bad.close();
  } finally { await f.dispose(); }
});

test('import byte budgets and service wall-time limits fail jobs without partial datasets', async () => {
  const f = await fixture({ maxImportBytes: 100 });
  try {
    await assert.rejects(f.service.prepare({ path: 'bars.json', format: 'json', maxFileBytes: 101 }), { code: 'RESOURCE_LIMIT' });
    const done = await poll(f.service, (await f.service.prepare({ path: 'bars.json', format: 'json' })).id);
    assert.equal(done.state, 'failed'); assert.equal(done.error?.code, 'DATA_TOO_LARGE');
    assert.deepEqual(await readdir(join(f.storeDir, 'datasets')), []);
  } finally { await f.dispose(); }
  const timeout = await fixture({ maxJobRuntimeMs: 1, cancelGraceMs: 1 });
  try { const done = await poll(timeout.service, (await timeout.service.prepare({ path: 'bars.json', format: 'json' })).id); assert.equal(done.state, 'failed'); assert.equal(done.error?.code, 'JOB_TIMEOUT'); }
  finally { await timeout.dispose(); }
});

test('cancel versus completion remains terminal and never reports an uncommitted success', async () => {
  const f = await fixture();
  try {
    const id = await prepare(f.service), plan = await f.service.validate(id, spec());
    for (let i = 0; i < 8; i++) {
      const job = await f.service.run(plan.planId); if (i % 2) await delay(3);
      await f.service.job(job.id, 'cancel'); const done = await poll(f.service, job.id);
      assert.ok(['succeeded', 'canceled'].includes(done.state), JSON.stringify(done));
      if (done.state === 'succeeded') assert.equal((await readManifest(f.storeDir, done.result!.runId!)).status, 'complete');
      else assert.equal(done.result, undefined);
      assert.deepEqual(await f.service.job(job.id, 'cancel'), done);
    }
  } finally { await f.dispose(); }
});

test('validation estimates describe actual warmup and typed column storage', async () => {
  const f = await fixture();
  try {
    const id = await prepare(f.service);
    const data = input(); const validated = await f.service.validate(id, spec({ start: data.bars[2]!.openTime, strategy: { kind: 'targets', schedule: [{ at: data.bars[2]!.closeTime, availableAt: data.bars[2]!.closeTime, weights: { AAA: 0 } }] } }));
    assert.equal(validated.estimates.warmupBars, 2); assert.equal(validated.estimates.inputBars, 5); assert.equal(validated.estimates.evaluationBars, 3);
    assert.ok(Number(validated.estimates.estimatedColumnBytes) > 0);
    assert.deepEqual(validated.estimates.warmupRange, { start: data.bars[0]!.closeTime, end: data.bars[2]!.openTime });
  } finally { await f.dispose(); }
});

test('retained store quota rejects commits and explicitly documents retention and temporary bounds', async () => {
  const f = await fixture({ maxStoreBytes: 100 });
  try {
    const done = await poll(f.service, (await f.service.prepare({ path: 'bars.json', format: 'json' })).id);
    assert.equal(done.state, 'failed'); assert.equal(done.error?.code, 'STORE_QUOTA_EXCEEDED');
    assert.deepEqual(await readdir(join(f.storeDir, 'datasets')), []); assert.deepEqual(await readdir(join(f.storeDir, 'staging')), []);
    const policy = JSON.parse(await readFile(join(f.storeDir, 'store-policy.json'), 'utf8'));
    assert.equal(policy.retention, 'until-explicit-cleanup'); assert.equal(policy.automaticEviction, false); assert.equal(policy.maxStoreBytes, 100);
    assert.deepEqual(policy.quotaIncludes, ['datasets', 'plans', 'runs', 'studies']); assert.ok(policy.quotaExcludes.includes('job bookkeeping'));
  } finally { await f.dispose(); }
});

test('async explanation replays the original full range and records derivation', async () => {
  const f = await fixture();
  try {
    const id = await prepare(f.service), plan = await f.service.validate(id, spec({ output: { level: 'summary' } }));
    const first = await poll(f.service, (await f.service.run(plan.planId)).id); assert.equal(first.state, 'succeeded');
    const sourceRunId = first.result!.runId!;
    await assert.rejects(f.service.explain(sourceRunId, {}), { code: 'INVALID_EXPLANATION_QUERY' });
    await writeFile(join(f.workspace, 'large.json'), JSON.stringify(minuteInput(30_000)));
    const blocker = await f.service.prepare({ path: 'large.json', format: 'json' });
    const queuedBlocker = await f.service.prepare({ path: 'large.json', format: 'json' });
    const pending = await f.service.explain(sourceRunId, { at: input().bars[0]!.closeTime, symbol: 'AAA' });
    assert.equal(pending.state, 'queued', 'explain must return its handle while unrelated worker jobs are pending');
    await f.service.job(queuedBlocker.id, 'cancel'); await f.service.job(blocker.id, 'cancel');
    const explanation = await poll(f.service, pending.id); assert.equal(explanation.state, 'succeeded', JSON.stringify(explanation.error));
    assert.equal(explanation.result!.sourceRunId, sourceRunId); assert.deepEqual(explanation.result!.replayRange, { start: spec().start, end: spec().end });
    const replay = await readManifest(f.storeDir, explanation.result!.runId!); assert.equal(replay.derivedFrom!.runId, sourceRunId); assert.equal(replay.outputLevel, 'fullTrace');
    assert.deepEqual((await readSummary(f.storeDir, explanation.result!.runId!)).metrics, (await readSummary(f.storeDir, sourceRunId)).metrics);
  } finally { await f.dispose(); }
});


test('concurrent commits share one retained quota instead of each spending the same remainder', async () => {
  const f = await fixture();
  try {
    await prepare(f.service);
    const files = await readdir(join(f.storeDir, 'datasets'));
    const sizes = await Promise.all(files.map(name => stat(join(f.storeDir, 'datasets', name)).then(value => value.size)));
    const oneDatasetBytes = sizes.reduce((a, b) => a + b, 0);
    await writeFile(join(f.workspace, 'other.json'), JSON.stringify(input(['20', '20', '21', '22', '23'])));
    const limited = new BacktestService({ workspace: f.workspace, storeDir: join(f.root, 'limited'), concurrency: 2, maxStoreBytes: oneDatasetBytes + 256 });
    await limited.init();
    try {
      const jobs = await Promise.all(['bars.json', 'other.json'].map(path => limited.prepare({ path, format: 'json' })));
      const done = await Promise.all(jobs.map(job => poll(limited, job.id)));
      assert.deepEqual(done.map(value => value.state).sort(), ['failed', 'succeeded']);
      assert.equal(done.find(value => value.state === 'failed')!.error!.code, 'STORE_QUOTA_EXCEEDED');
    } finally { await limited.close(); }
  } finally { await f.dispose(); }
});
