import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { contentHash, canonicalJSON } from '../spec/canonical.js';
import { Decimal } from '../spec/decimal.js';
import { assertThat, BacktestError, errorJSON } from '../spec/errors.js';
import { parseSpec } from '../spec/validate.js';
import { ENGINE_VERSION } from '../engine/run.js';
import type { BacktestSpec, Dataset, Metrics, BarSeries } from '../spec/types.js';

export type ParameterValue = number | string | boolean;
export type ParameterSpace = Record<string, ParameterValue[]>;
export type ObjectiveMetric = 'timeWeightedReturn' | 'annualizedReturn' | 'sharpe' | 'sortino' | 'calmar' | 'netProfit' | 'finalEquity' | 'maxDrawdownPct' | 'maxDrawdownAmount';
export interface Objective { metric: ObjectiveMetric; direction: 'maximize' | 'minimize' }
export interface ResearchHooks { canceled?: () => boolean; progress?: (done: number, total: number) => void }
export interface SweepRequest {
  space: ParameterSpace; objective: Objective; seed?: number; concurrency?: number;
  maxCandidates?: number; maxTotalBars?: number; maxRuntimeMs?: number; maxDatasetBytes?: number; workerMemoryMb?: number;
}
export interface Candidate { id: string; parameters: Record<string, ParameterValue>; seed: number; specification: BacktestSpec }
export interface CandidateResult {
  id: string; parameters: Record<string, ParameterValue>; seed: number;
  status: 'succeeded' | 'failed'; score: number | string | null;
  metrics?: Metrics; fingerprint?: string; error?: ReturnType<typeof errorJSON>;
}
export interface SweepResult {
  schemaVersion: '1'; kind: 'sweep'; engineVersion: string; datasetHash: string; fingerprint: string;
  objective: Objective; seed: number; candidateCount: number; winnerId: string;
  candidates: CandidateResult[]; sharedDatasetBytes: number;
}

const scalar = z.union([z.number().finite(), z.string().min(1).max(128), z.boolean()]);
export const objectiveSchema = z.strictObject({ metric: z.enum(['timeWeightedReturn', 'annualizedReturn', 'sharpe', 'sortino', 'calmar', 'netProfit', 'finalEquity', 'maxDrawdownPct', 'maxDrawdownAmount']), direction: z.enum(['maximize', 'minimize']) });
export const spaceSchema = z.record(z.string().min(2).max(512), z.array(scalar).min(1).max(10_000));
export const researchBudgetShape = {
  seed: z.number().int().min(0).max(0xffff_ffff).default(1),
  concurrency: z.number().int().min(1).max(8).default(2),
  maxCandidates: z.number().int().min(1).max(10_000).default(1_000),
  maxTotalBars: z.number().int().min(1).max(1_000_000_000).default(100_000_000),
  maxRuntimeMs: z.number().int().min(1).max(3_600_000).default(120_000),
  maxDatasetBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(256 * 1024 * 1024),
  workerMemoryMb: z.number().int().min(16).max(2048).default(512),
};
export const sweepRequestSchema = z.strictObject({ space: spaceSchema, objective: objectiveSchema, ...researchBudgetShape });
export type ResolvedSweepRequest = z.infer<typeof sweepRequestSchema>;
export function parseSweepRequest(request: unknown): ResolvedSweepRequest {
  const parsed = sweepRequestSchema.safeParse(request);
  assertThat(parsed.success, 'INVALID_SWEEP_REQUEST', 'Invalid parameter sweep request', '', { issues: parsed.error?.issues.slice(0, 10) });
  assertThat(Object.keys(parsed.data.space).length > 0 && Object.keys(parsed.data.space).length <= 16, 'INVALID_PARAMETER_SPACE', 'Use between 1 and 16 parameter pointers');
  return parsed.data;
}

function pointerTokens(pointer: string): string[] {
  assertThat(pointer.startsWith('/') && !/~(?![01])/u.test(pointer), 'INVALID_PARAMETER_POINTER', 'Use canonical RFC 6901 JSON pointers');
  const tokens = pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  assertThat(tokens.every(token => token.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(token)), 'INVALID_PARAMETER_POINTER', 'Empty/reserved pointer tokens are forbidden');
  assertThat(['strategy', 'execution', 'costs'].includes(tokens[0]!) && tokens.length > 1, 'INVALID_PARAMETER_POINTER', 'Only existing scalar strategy, execution, or cost parameters may vary');
  return tokens;
}
function leaf(spec: BacktestSpec, pointer: string): { parent: Record<string, unknown>; key: string; value: unknown } {
  const tokens = pointerTokens(pointer); let parent: unknown = spec;
  for (const token of tokens.slice(0, -1)) {
    assertThat(parent !== null && typeof parent === 'object' && Object.hasOwn(parent, token) && (!Array.isArray(parent) || /^(0|[1-9]\d*)$/.test(token)), 'INVALID_PARAMETER_POINTER', `Pointer ${pointer} does not resolve to an existing property`);
    parent = (parent as Record<string, unknown>)[token];
  }
  const key = tokens.at(-1)!;
  assertThat(parent !== null && typeof parent === 'object' && Object.hasOwn(parent, key) && (!Array.isArray(parent) || /^(0|[1-9]\d*)$/.test(key)), 'INVALID_PARAMETER_POINTER', `Pointer ${pointer} does not resolve to an existing property`);
  return { parent: parent as Record<string, unknown>, key, value: (parent as Record<string, unknown>)[key] };
}

/** Existing scalar leaves only: no object replacement, array insertion, prototype keys, or code. */
export function applyParameters(base: BacktestSpec, parameters: Record<string, ParameterValue>): BacktestSpec {
  const result = structuredClone(base);
  for (const [pointer, value] of Object.entries(parameters)) {
    const target = leaf(result, pointer);
    assertThat(['string', 'number', 'boolean'].includes(typeof target.value) && typeof target.value === typeof value, 'PARAMETER_TYPE_MISMATCH', `Parameter ${pointer} must preserve its scalar type`);
    target.parent[target.key] = value;
  }
  return parseSpec(result);
}

export function expandCandidates(base: BacktestSpec, request: ResolvedSweepRequest): Candidate[] {
  const pointers = Object.keys(request.space).sort();
  let count = 1;
  for (const pointer of pointers) {
    const values = request.space[pointer]!, target = leaf(base, pointer);
    assertThat(values.every(value => typeof value === typeof target.value), 'PARAMETER_TYPE_MISMATCH', `Parameter ${pointer} must preserve its scalar type`);
    assertThat(new Set(values.map(canonicalJSON)).size === values.length, 'DUPLICATE_PARAMETER_VALUE', `Parameter ${pointer} repeats a candidate value`);
    count *= values.length;
    assertThat(count <= request.maxCandidates, 'CANDIDATE_LIMIT', 'Cartesian parameter space exceeds maxCandidates');
  }
  let combinations: Array<Record<string, ParameterValue>> = [{}];
  for (const pointer of pointers) combinations = combinations.flatMap(parameters => request.space[pointer]!.map(value => ({ ...parameters, [pointer]: value })));
  let specificationBytes = 0;
  return combinations.map(parameters => {
    const id = `candidate_${contentHash(parameters).slice(0, 24)}`;
    const seed = Number.parseInt(contentHash({ seed: request.seed, candidateId: id }).slice(0, 8), 16);
    const specification = applyParameters(base, parameters); specification.seed = seed; specification.output = { level: 'summary' };
    specificationBytes += Buffer.byteLength(canonicalJSON(specification));
    assertThat(specificationBytes <= 64 * 1024 * 1024, 'PARAMETER_SPEC_BUDGET', 'Expanded candidate specifications exceed 64 MiB');
    return { id, parameters, seed, specification };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** One read-only-by-contract copy; every candidate worker views these same buffers. */
export function shareDataset(dataset: Dataset, maxBytes: number): { dataset: Dataset; bytes: number } {
  let bytes = Buffer.byteLength(canonicalJSON({ metadata: dataset.metadata, features: dataset.features, actions: dataset.actions, membership: dataset.membership, warnings: dataset.warnings }));
  const arrays = (series: BarSeries) => Object.entries(series).filter((entry): entry is [string, Float64Array | Uint32Array | Uint8Array] => ArrayBuffer.isView(entry[1]));
  for (const series of dataset.series.values()) for (const [, array] of arrays(series)) bytes += array.byteLength;
  assertThat(bytes <= maxBytes, 'RESEARCH_DATASET_BUDGET', 'Shared dataset exceeds the configured research byte budget');
  const { series: _series, ...metadata } = dataset;
  const result: Dataset = { ...structuredClone(metadata), series: new Map() };
  for (const [symbol, series] of dataset.series) {
    const copy = { ...series, instrument: structuredClone(series.instrument) };
    for (const [key, array] of arrays(series)) {
      const buffer = array.buffer instanceof SharedArrayBuffer ? array.buffer : new SharedArrayBuffer(array.byteLength);
      const typed = array instanceof Float64Array ? new Float64Array(buffer, array.buffer instanceof SharedArrayBuffer ? array.byteOffset : 0, array.length) : array instanceof Uint32Array ? new Uint32Array(buffer, array.buffer instanceof SharedArrayBuffer ? array.byteOffset : 0, array.length) : new Uint8Array(buffer, array.buffer instanceof SharedArrayBuffer ? array.byteOffset : 0, array.length);
      if (!(array.buffer instanceof SharedArrayBuffer)) typed.set(array);
      (copy as unknown as Record<string, unknown>)[key] = typed;
    }
    result.series.set(symbol, copy);
  }
  return { dataset: result, bytes };
}

export function objectiveScore(metrics: Metrics, objective: Objective): number | string | null {
  const raw = metrics[objective.metric];
  const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
  return value === null || (typeof value === 'number' && !Number.isFinite(value)) ? null : value;
}
export function winner(candidates: CandidateResult[], objective: Objective): CandidateResult {
  const valid = candidates.filter(candidate => candidate.status === 'succeeded' && candidate.score !== null);
  assertThat(valid.length > 0, 'NO_VALID_CANDIDATE', 'No candidate has a defined objective on the training/evaluation interval', '', { candidates: candidates.length, failed: candidates.filter(candidate => candidate.status === 'failed').length, objective, sampleErrors: candidates.filter(candidate => candidate.error).slice(0, 3).map(candidate => ({ candidateId: candidate.id, error: candidate.error })) });
  return valid.sort((a, b) => {
    const comparison = new Decimal(a.score!).cmp(b.score!);
    return (objective.direction === 'maximize' ? -comparison : comparison) || a.id.localeCompare(b.id);
  })[0]!;
}

export async function runSweep(dataset: Dataset, specification: unknown, input: SweepRequest, hooks: ResearchHooks = {}): Promise<SweepResult> {
  const started = performance.now(), request = parseSweepRequest(input), base = parseSpec(specification);
  const candidates = expandCandidates(base, request);
  assertThat(dataset.rowCount * candidates.length <= request.maxTotalBars, 'RESEARCH_BAR_BUDGET', 'Candidate count multiplied by dataset rows exceeds maxTotalBars');
  assertThat(!hooks.canceled?.(), 'CANCELED', 'Research canceled');
  const shared = shareDataset(dataset, request.maxDatasetBytes), cancel = new Int32Array(new SharedArrayBuffer(4));
  const results: CandidateResult[] = [], workers: Worker[] = [], byId = new Map(candidates.map(candidate => [candidate.id, candidate])), completed = new Set<string>();
  const basePath = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const workerPath = resolve(basePath, existsSync(resolve(basePath, 'research-worker.cjs')) ? 'research-worker.cjs' : 'worker.js');
  let next = 0, finished = false, deadline: ReturnType<typeof setTimeout> | undefined, polling: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolveAll, reject) => {
      const fail = (error: unknown) => { if (!finished) { finished = true; Atomics.store(cancel, 0, 1); reject(error); } };
      const dispatch = (worker: Worker) => { if (!finished && next < candidates.length) worker.postMessage({ candidate: candidates[next++]! }); };
      deadline = setTimeout(() => fail(new BacktestError('RESEARCH_TIMEOUT', 'Research exceeded maxRuntimeMs')), Math.max(1, request.maxRuntimeMs - (performance.now() - started)));
      polling = setInterval(() => { try { if (hooks.canceled?.()) fail(new BacktestError('CANCELED', 'Research canceled')); } catch (error) { fail(error); } }, 25);
      for (let i = 0; i < Math.min(request.concurrency, candidates.length); i++) {
        const worker = new Worker(workerPath, { workerData: { dataset: shared.dataset, cancel: cancel.buffer }, resourceLimits: { maxOldGenerationSizeMb: request.workerMemoryMb } });
        workers.push(worker);
        worker.on('error', fail);
        worker.on('exit', code => { if (!finished) fail(new BacktestError('RESEARCH_WORKER_EXIT', `Research worker exited unexpectedly (${code})`)); });
        worker.on('message', (message: { id: string; metrics?: Metrics; fingerprint?: string; error?: ReturnType<typeof errorJSON> }) => {
          if (finished) return;
          const candidate = byId.get(message.id);
          if (!candidate || completed.has(message.id)) { fail(new BacktestError('RESEARCH_WORKER_PROTOCOL', 'Unexpected or duplicate candidate result')); return; }
          completed.add(message.id);
          results.push({ id: candidate.id, parameters: candidate.parameters, seed: candidate.seed, status: message.error ? 'failed' : 'succeeded', score: message.metrics ? objectiveScore(message.metrics, request.objective) : null, ...(message.metrics ? { metrics: message.metrics, fingerprint: message.fingerprint } : { error: message.error }) });
          try { hooks.progress?.(results.length, candidates.length); } catch (error) { fail(error); return; }
          if (results.length === candidates.length) { finished = true; resolveAll(); } else dispatch(worker);
        });
        dispatch(worker);
      }
    });
  } finally {
    finished = true; clearTimeout(deadline); clearInterval(polling); Atomics.store(cancel, 0, 1);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  results.sort((a, b) => a.id.localeCompare(b.id));
  const selected = winner(results, request.objective);
  const identity = { engineVersion: ENGINE_VERSION, datasetHash: dataset.hash, specification: base, space: request.space, objective: request.objective, seed: request.seed };
  return { schemaVersion: '1', kind: 'sweep', engineVersion: ENGINE_VERSION, datasetHash: dataset.hash, fingerprint: contentHash(identity), objective: request.objective, seed: request.seed, candidateCount: results.length, winnerId: selected.id, candidates: results, sharedDatasetBytes: shared.bytes };
}
