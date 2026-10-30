import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
import { BacktestService, type JobStatus } from '../src/runtime/manager.js';
import { BacktestError } from '../src/spec/errors.js';
import { input, spec } from './helpers.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function environment(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'ts-backtest-runtime-races-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { workspace: root, storeDir: join(root, 'store'), concurrency: 1 };
  const service = new BacktestService(options);
  t.after(() => service.close().catch(() => {}));
  return { root, options, service };
}
async function terminal(service: BacktestService, id: string): Promise<JobStatus> {
  for (let count = 0; count < 1_000; count++) {
    const status = await service.job(id);
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(status.state)) return status;
    await delay(5);
  }
  throw new Error('Timed out waiting for fixture job');
}

test('concurrent init calls share one complete initialization', async t => {
  const { service } = await environment(t);
  const results = await Promise.allSettled([service.init(), service.init(), service.init()]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled']);
});

test('close during initialization releases any acquired store lock before completing', async t => {
  const { service, options } = await environment(t), entered = deferred(), release = deferred();
  const internal = service as unknown as { acquireLock(): Promise<void> };
  const acquire = internal.acquireLock.bind(service);
  internal.acquireLock = async () => { entered.resolve(); await release.promise; await acquire(); };
  const initializing = service.init();
  await entered.promise;
  const closing = service.close();
  release.resolve();
  await Promise.allSettled([initializing, closing]);
  await assert.rejects(access(join(options.storeDir, 'service.lock')));
  const replacement = new BacktestService(options);
  try { await replacement.init(); } finally { await replacement.close(); }
});

test('concurrent close callers wait for the same completed cleanup', async t => {
  const { service } = await environment(t);
  await service.init();
  const entered = deferred(), release = deferred();
  const internal = service as unknown as { releaseLock(): Promise<void> };
  const original = internal.releaseLock.bind(service);
  internal.releaseLock = async () => { entered.resolve(); await release.promise; await original(); };
  const first = service.close();
  await entered.promise;
  let secondCompleted = false;
  const second = service.close().then(() => { secondCompleted = true; });
  await turn();
  const completedTooEarly = secondCompleted;
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(completedTooEarly, false, 'a concurrent close must not resolve before cleanup');
});

test('a dataset handle rejects another valid dataset stored at its path', async t => {
  const { service, root, options } = await environment(t);
  await service.init();
  const a = input(), b = input();
  b.bars[0]!.volume += 1;
  await writeFile(join(root, 'a.json'), JSON.stringify(a));
  await writeFile(join(root, 'b.json'), JSON.stringify(b));
  const preparedA = await terminal(service, (await service.prepare({ path: 'a.json', format: 'json' })).id);
  const preparedB = await terminal(service, (await service.prepare({ path: 'b.json', format: 'json' })).id);
  assert.equal(preparedA.state, 'succeeded'); assert.equal(preparedB.state, 'succeeded');
  const idA = preparedA.result!.datasetId!, idB = preparedB.result!.datasetId!;
  assert.notEqual(idA, idB);
  await copyFile(join(options.storeDir, 'datasets', `${idB}.json`), join(options.storeDir, 'datasets', `${idA}.json`));
  await assert.rejects(service.validate(idA, spec()), error => error instanceof BacktestError && error.code === 'DATASET_INTEGRITY_ERROR');
});

test('overlapping completion and cancellation fallback finish one job once', async t => {
  const { service } = await environment(t);
  await service.init();
  // Deterministic fault injection: hold the terminal write while a fallback runs.
  // This tests the service race without relying on OS disk latency or worker timing.
  const internal = service as unknown as {
    active: Map<string, any>; queue: string[]; slots: any[];
    persist(record: any): Promise<void>;
    start(slot: any, record: any): Promise<void>;
    message(slot: any, message: any): Promise<void>;
    stopSlot(slot: any, id: string, state: 'canceled'): Promise<void>;
  };
  const id = 'job_old', nextId = 'job_next', at = new Date().toISOString();
  const record = (jobId: string, state: string) => ({ schemaVersion: '1', status: { id: jobId, kind: 'prepare', state, createdAt: at, updatedAt: at }, task: { kind: 'prepare', options: { path: 'unused', format: 'json' } } });
  const old = record(id, 'running'), next = record(nextId, 'queued');
  internal.active.set(id, old); internal.active.set(nextId, next); internal.queue.push(nextId);
  const slot = internal.slots[0]!; slot.id = id;
  const entered = deferred(), release = deferred();
  let terminalWrites = 0, starts = 0;
  internal.persist = async value => {
    if (value.status.id === id && ['failed', 'canceled'].includes(value.status.state)) { terminalWrites++; entered.resolve(); await release.promise; }
  };
  internal.start = async (nextSlot, nextRecord) => { starts++; nextSlot.id = nextRecord.status.id; nextRecord.status.state = 'running'; };
  const completion = internal.message(slot, { type: 'error', id, error: { code: 'FIXTURE_FAILURE', message: 'fixture' } });
  await entered.promise;
  const fallback = internal.stopSlot(slot, id, 'canceled');
  await turn();
  release.resolve();
  await Promise.all([completion, fallback]);
  assert.equal(terminalWrites, 1, 'one terminal job transition must be persisted');
  assert.equal(starts, 1);
  assert.equal(slot.id, nextId, 'old completion must not release the next job slot');
});

test('failed background persistence is reported but cannot strand the store lock on close', async t => {
  const { service, options } = await environment(t);
  await service.init();
  const internal = service as unknown as { writes: Map<string, Promise<void>> };
  const failure = Promise.reject(new Error('fixture storage failure'));
  void failure.catch(() => {});
  internal.writes.set('job_fixture', failure);
  await assert.rejects(service.close(), /fixture storage failure/);
  await assert.rejects(access(join(options.storeDir, 'service.lock')));
  const replacement = new BacktestService(options);
  try { await replacement.init(); } finally { await replacement.close(); }
});
