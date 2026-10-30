import { parentPort, workerData } from 'node:worker_threads';
import { runBacktest } from '../engine/run.js';
import { errorJSON } from '../spec/errors.js';
import type { Dataset } from '../spec/types.js';
import type { Candidate } from './sweep.js';

const { dataset, cancel: buffer } = workerData as { dataset: Dataset; cancel: SharedArrayBuffer };
const cancel = new Int32Array(buffer);
parentPort!.on('message', ({ candidate }: { candidate: Candidate }) => {
  try {
    const result = runBacktest(dataset, candidate.specification, { canceled: () => Atomics.load(cancel, 0) !== 0 });
    parentPort!.postMessage({ id: candidate.id, metrics: result.metrics, fingerprint: result.fingerprint });
  } catch (error) { parentPort!.postMessage({ id: candidate.id, error: errorJSON(error) }); }
});
