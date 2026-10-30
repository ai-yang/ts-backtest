import { parentPort, workerData } from 'node:worker_threads';
import { constants, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { importDataset, readBoundedText, type ImportDatasetOptions } from '../data/import.js';
import { decodeDataset, encodeDataset } from '../data/serialize.js';
import { runBacktest, validateBacktest } from '../engine/run.js';
import { BacktestError, errorJSON } from '../spec/errors.js';
import { runSweep, type SweepRequest } from '../research/sweep.js';
import { runWalkForward, type WalkForwardRequest } from '../research/walk-forward.js';
import { factorDiagnostics, type FactorRequest } from '../research/factors.js';
import { workspaceFile, storeFile } from './paths.js';
import type { BacktestSpec, Dataset } from '../spec/types.js';

export type WorkerTask =
  | { kind: 'prepare'; id: string; cancel: SharedArrayBuffer; options: ImportDatasetOptions; stagedPath: string }
  | { kind: 'run'; id: string; cancel: SharedArrayBuffer; datasetPath: string; expectedDatasetId: string; expectedHash?: string; spec: BacktestSpec }
  | { kind: 'validate'; id: string; cancel: SharedArrayBuffer; datasetPath: string; expectedDatasetId: string; expectedHash?: string; spec: unknown }
  | { kind: 'sweep'; id: string; cancel: SharedArrayBuffer; datasetPath: string; expectedDatasetId: string; expectedHash?: string; spec: BacktestSpec; request: SweepRequest }
  | { kind: 'walk_forward'; id: string; cancel: SharedArrayBuffer; datasetPath: string; expectedDatasetId: string; expectedHash?: string; spec: BacktestSpec; request: WalkForwardRequest }
  | { kind: 'factors'; id: string; cancel: SharedArrayBuffer; datasetPath: string; expectedDatasetId: string; expectedHash?: string; request: FactorRequest };

const config = workerData as { workspace: string; storeDir: string; maxCacheBytes: number };
const datasets = new Map<string, Dataset>();
let busy = false;

async function snapshotSource(path: string, target: string, maxBytes: number, canceled: () => boolean): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
  if (!(await file.stat()).isFile()) throw new BacktestError('INVALID_DATA_PATH', 'Source must be a regular file');
  await pipeline(file.createReadStream({ autoClose: false }), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    if (canceled()) { callback(new BacktestError('CANCELED', 'Operation canceled')); return; }
    bytes += chunk.byteLength;
    if (bytes > maxBytes) { callback(new BacktestError('DATA_TOO_LARGE', 'Source exceeds the import byte budget')); return; }
    hash.update(chunk); callback(null, chunk);
  } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  return hash.digest('hex');
  } finally { await file.close(); }
}

parentPort?.on('message', async (task: WorkerTask) => {
  if (busy) { parentPort!.postMessage({ type: 'error', id: task.id, error: { code: 'WORKER_BUSY', message: 'Worker received overlapping jobs', retryable: true } }); return; }
  busy = true;
  const flag = new Int32Array(task.cancel);
  const canceled = () => Atomics.load(flag, 0) !== 0;
  const check = () => { if (canceled()) throw new BacktestError('CANCELED', 'Operation canceled'); };
  try {
    check();
    if (task.kind === 'prepare') {
      const path = await workspaceFile(config.workspace, task.options.path);
      parentPort!.postMessage({ type: 'progress', id: task.id, stage: 'importing', done: 0, total: 1 });
      await mkdir(dirname(task.stagedPath), { recursive: true });
      const snapshotPath = `${task.stagedPath}.source`;
      let dataset: Dataset, hash: string;
      try {
        hash = await snapshotSource(path, snapshotPath, task.options.maxFileBytes ?? 64 * 1024 * 1024, canceled);
        parentPort!.postMessage({ type: 'progress', id: task.id, stage: 'normalizing', done: 0, total: 1 });
        dataset = await importDataset({ ...task.options, path: snapshotPath });
      } finally { await rm(snapshotPath, { force: true }); }
      check();
      const encoded = encodeDataset(dataset);
      if (Buffer.byteLength(encoded) > config.maxCacheBytes) throw new BacktestError('CACHE_BUDGET_EXCEEDED', 'Prepared dataset exceeds the cache byte budget');
      await writeFile(task.stagedPath, encoded, { flag: 'wx', mode: 0o600 });
      check();
      parentPort!.postMessage({ type: 'done', id: task.id, result: { datasetId: dataset.id, hash: dataset.hash, rowCount: dataset.rowCount, metadata: dataset.metadata, warnings: dataset.warnings, sourceHash: hash } });
    } else {
      const path = await storeFile(config.storeDir, task.datasetPath);
      let dataset = datasets.get(path);
      if (!dataset) {
        parentPort!.postMessage({ type: 'progress', id: task.id, stage: 'loading', done: 0, total: 1 });
        dataset = decodeDataset(await readBoundedText(path, config.maxCacheBytes), { maxBytes: config.maxCacheBytes });
        datasets.clear(); datasets.set(path, dataset);
      }
      if (dataset.id !== task.expectedDatasetId || (task.expectedHash && dataset.hash !== task.expectedHash)) throw new BacktestError('DATASET_INTEGRITY_ERROR', 'Dataset content differs from its immutable handle');
      check();
      if (task.kind === 'validate') {
        const spec = validateBacktest(dataset, task.spec);
        let warmupBars = 0, inputBars = 0, firstWarmupAt: number | undefined;
        let estimatedColumnBytes = 0;
        for (const series of dataset.series.values()) {
          for (const value of Object.values(series)) if (ArrayBuffer.isView(value)) estimatedColumnBytes += value.byteLength;
          for (const at of series.closeTime) if (at < spec.end) { inputBars++; if (at < spec.start) { warmupBars++; firstWarmupAt = Math.min(firstWarmupAt ?? at, at); } }
        }
        const estimates = { warmupBars, inputBars, evaluationBars: inputBars - warmupBars, estimatedColumnBytes, warmupRange: firstWarmupAt === undefined ? null : { start: firstWarmupAt, end: spec.start }, note: 'Column bytes exclude source parsing, indicators, engine state and result objects; warmup consumes all supplied completed bars before start.' };
        parentPort!.postMessage({ type: 'done', id: task.id, result: { estimates, datasetId: dataset.id, datasetHash: dataset.hash, resolvedSpec: { ...spec, datasetId: dataset.id }, warnings: dataset.warnings } });
        return;
      }
      let last = 0;
      const hooks = {
        canceled,
        progress(done: number, total: number) {
          const now = Date.now();
          if (now - last >= 100 || done === total) { parentPort!.postMessage({ type: 'progress', id: task.id, stage: task.kind === 'run' ? 'running' : task.kind, done, total }); last = now; }
        },
      };
      const result = task.kind === 'sweep' ? await runSweep(dataset, task.spec, task.request, hooks)
        : task.kind === 'walk_forward' ? await runWalkForward(dataset, task.spec, task.request, hooks)
          : task.kind === 'factors' ? factorDiagnostics(dataset, task.request, hooks)
            : runBacktest(dataset, task.spec, hooks);
      check();
      parentPort!.postMessage({ type: 'done', id: task.id, result });
    }
  } catch (error) { parentPort!.postMessage({ type: 'error', id: task.id, error: errorJSON(error) }); }
  finally { busy = false; }
});
