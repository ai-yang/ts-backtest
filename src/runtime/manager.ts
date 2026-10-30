import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../spec/canonical.js';
import { assertThat, BacktestError, errorJSON } from '../spec/errors.js';
import { parseSpec } from '../spec/validate.js';
import { ENGINE_VERSION } from '../engine/run.js';
import { readBoundedText, type ImportDatasetOptions } from '../data/import.js';
import { atomicJSON, directory, handlePath, ownedDirectory, storeFile, workspaceFile } from './paths.js';
import { persistResult, explainResult, readManifest, readResolvedSpec, cleanupStagingRuns } from './results.js';
import { persistStudy, queryStudy, cleanupStagingStudies, type StudyQuery, type StudyPage, type StudyResult } from './research-results.js';
import { parseSweepRequest, type SweepRequest } from '../research/sweep.js';
import { parseWalkForwardRequest, type WalkForwardRequest, type WalkForwardResult } from '../research/walk-forward.js';
import { parseFactorRequest, type FactorRequest } from '../research/factors.js';
import type { BacktestResult, BacktestSpec, Diagnostic, DatasetMetadata } from '../spec/types.js';
import type { WorkerTask } from './worker.js';

export type JobState = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type JobKind = 'prepare' | 'validate' | 'run' | 'explain' | 'sweep' | 'walk_forward' | 'factors';
export interface JobStatus {
  id: string; kind: JobKind; state: JobState; createdAt: string; updatedAt: string;
  progress?: { stage: string; done?: number; total?: number };
  result?: { datasetId?: string; planId?: string; runId?: string; sourceRunId?: string; explanation?: unknown; [key: string]: unknown };
  error?: ReturnType<typeof errorJSON>;
  cancellation?: { accepted: boolean; reason?: string };
}
export interface ExplainQuery { orderId?: string; fillId?: string; at?: number; symbol?: string }
export interface ServiceOptions {
  workspace: string; storeDir: string; concurrency?: number;
  maxQueuedJobs?: number; maxImportBytes?: number; maxImportRows?: number;
  maxCacheBytes?: number; maxJobRuntimeMs?: number; maxOutputBytes?: number; maxStoreBytes?: number;
  workerMemoryMb?: number; cancelGraceMs?: number;
  /** Global child-worker allowance shared by all concurrent studies, in addition to the parent pool. */
  maxResearchWorkers?: number; maxResearchCandidates?: number; maxResearchBars?: number;
}
interface Plan { schemaVersion: '1'; planId: string; engineVersion: string; datasetId: string; datasetHash: string; resolvedSpec: BacktestSpec; warnings: Diagnostic[] }
type Task =
  | { kind: 'prepare'; options: ImportDatasetOptions }
  | { kind: 'validate'; datasetId: string; spec: BacktestSpec }
  | { kind: 'run'; plan: Plan }
  | { kind: 'explain'; plan: Plan; sourceRunId: string; sourceFingerprint: string; query: ExplainQuery }
  | { kind: 'sweep'; plan: Plan; request: SweepRequest }
  | { kind: 'walk_forward'; plan: Plan; request: WalkForwardRequest }
  | { kind: 'factors'; datasetId: string; request: FactorRequest };
interface RecordFile { schemaVersion: '1'; status: JobStatus; task: Task }
interface Slot { worker?: Worker; id?: string; cancel?: Int32Array; timeout?: ReturnType<typeof setTimeout>; fallback?: ReturnType<typeof setTimeout>; committing: boolean; finalizing?: boolean; timedOut: boolean; completion?: Promise<void>; researchWorkers?: number }
const terminal = (state: JobState) => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(state);
const now = () => new Date().toISOString();

/** A single store owner, durable handles, and a bounded persistent worker pool. */
export class BacktestService {
  workspace: string;
  storeDir: string;
  private readonly options: Required<ServiceOptions>;
  private readonly active = new Map<string, RecordFile>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Array<(status: JobStatus) => void>>();
  private readonly slots: Slot[];
  private readonly queue: string[] = [];
  private initialized = false;
  private initializing?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private lockToken?: string;
  private backgroundError?: unknown;
  private commitQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.workspace = resolve(options.workspace); this.storeDir = resolve(options.storeDir);
    this.options = { workspace: this.workspace, storeDir: this.storeDir,
      concurrency: options.concurrency ?? 2, maxQueuedJobs: options.maxQueuedJobs ?? 32,
      maxImportBytes: options.maxImportBytes ?? 64 * 1024 * 1024, maxImportRows: options.maxImportRows ?? 2_000_000,
      maxCacheBytes: options.maxCacheBytes ?? 256 * 1024 * 1024, maxJobRuntimeMs: options.maxJobRuntimeMs ?? 120_000,
      maxOutputBytes: options.maxOutputBytes ?? 128 * 1024 * 1024, maxStoreBytes: options.maxStoreBytes ?? 1024 * 1024 * 1024, workerMemoryMb: options.workerMemoryMb ?? 512,
      cancelGraceMs: options.cancelGraceMs ?? 500, maxResearchWorkers: options.maxResearchWorkers ?? options.concurrency ?? 2,
      maxResearchCandidates: options.maxResearchCandidates ?? 1000, maxResearchBars: options.maxResearchBars ?? 100_000_000 };
    for (const [key, value] of Object.entries(this.options)) if (typeof value === 'number') assertThat(Number.isSafeInteger(value) && value > 0, 'INVALID_SERVICE_OPTIONS', `${key} must be a positive safe integer`);
    assertThat(this.options.concurrency <= 8, 'INVALID_SERVICE_OPTIONS', 'Worker concurrency cannot exceed 8');
    assertThat(this.options.maxResearchWorkers <= 8 && this.options.maxResearchCandidates <= 10_000 && this.options.maxResearchBars <= 1_000_000_000, 'INVALID_SERVICE_OPTIONS', 'Research service limits exceed supported hard bounds');
    this.slots = Array.from({ length: this.options.concurrency }, () => ({ committing: false, timedOut: false }));
  }

  init(): Promise<void> {
    if (this.closed) return Promise.reject(new BacktestError('SERVICE_CLOSED', 'Service is closed'));
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize();
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    assertThat(!this.closed, 'SERVICE_CLOSED', 'Service is closed');
    if (this.initialized) return;
    this.workspace = await realpath(this.workspace);
    assertThat((await stat(this.workspace)).isDirectory(), 'INVALID_WORKSPACE', 'Workspace must be a directory');
    this.storeDir = await directory(this.storeDir);
    await this.acquireLock();
    try {
      for (const name of ['datasets', 'plans', 'jobs', 'staging', 'studies']) await ownedDirectory(this.storeDir, resolve(this.storeDir, name));
      for (const name of await readdir(resolve(this.storeDir, 'jobs'))) {
        if (!/^job_[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
        const record = await this.readRecord(name.slice(0, -5));
        if (!terminal(record.status.state)) {
          record.status.state = 'interrupted'; record.status.updatedAt = now();
          record.status.error = new BacktestError('INTERRUPTED', 'Previous service ended before this job committed').toJSON();
          await this.persist(record);
        }
      }
      for (const name of await readdir(resolve(this.storeDir, 'staging'))) if (/^job_[a-zA-Z0-9_-]+$/.test(name)) await rm(resolve(this.storeDir, 'staging', name), { recursive: true, force: true });
      await cleanupStagingRuns(this.storeDir);
      await cleanupStagingStudies(this.storeDir);
      await atomicJSON(resolve(this.storeDir, 'store-policy.json'), { schemaVersion: '1', retention: 'until-explicit-cleanup', maxStoreBytes: this.options.maxStoreBytes, quotaIncludes: ['datasets', 'plans', 'runs', 'studies'], quotaExcludes: ['job bookkeeping', 'temporary import snapshots and staging'], temporaryLimits: { workers: this.options.concurrency, researchWorkersGlobal: this.options.maxResearchWorkers, totalWorkers: this.options.concurrency + this.options.maxResearchWorkers, sourceBytesPerJob: this.options.maxImportBytes, cacheBytesPerJob: this.options.maxCacheBytes, resultBytesPerJob: this.options.maxOutputBytes }, automaticEviction: false });
      this.initialized = true;
    } catch (error) { await this.releaseLock(); throw error; }
  }

  private async acquireLock(): Promise<void> {
    const path = resolve(this.storeDir, 'service.lock');
    const token = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: now() })); }
        finally { await file.close(); }
        this.lockToken = token;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid?: unknown; token?: unknown };
        try { owner = JSON.parse(await readBoundedText(await storeFile(this.storeDir, path), 4096)); }
        catch { throw new BacktestError('STORE_IN_USE', 'Store lock is being initialized or requires inspection'); }
        assertThat(Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.token === 'string', 'STORE_IN_USE', 'Invalid store lock requires inspection');
        let alive = true;
        try { process.kill(owner.pid as number, 0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        assertThat(!alive, 'STORE_IN_USE', 'Another service owns this store', '', { pid: owner.pid });
        // Serial recovery prevents two contenders unlinking a newly acquired live lock.
        const recoveryPath = resolve(this.storeDir, 'service.recovery.lock');
        let guard;
        try { guard = await open(recoveryPath, 'wx', 0o600); }
        catch { throw new BacktestError('STORE_IN_USE', 'Store recovery is in progress or its recovery guard requires inspection'); }
        try {
          await guard.writeFile(JSON.stringify({ pid: process.pid, token }));
          let current: { pid: number; token: string } | undefined;
          try { current = JSON.parse(await readBoundedText(await storeFile(this.storeDir, path), 4096)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (current?.token === owner.token) {
            let stillDead = false;
            try { process.kill(current.pid, 0); } catch (error) { stillDead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
            if (stillDead) await rm(path);
          }
        } finally { await guard.close(); await rm(recoveryPath, { force: true }); }
      }
    }
    throw new BacktestError('STORE_IN_USE', 'Could not acquire the store lock');
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockToken) return;
    const path = resolve(this.storeDir, 'service.lock');
    try { const owner = JSON.parse(await readFile(path, 'utf8')); if (owner.token === this.lockToken) await rm(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.lockToken = undefined;
  }

  private ready(): void {
    assertThat(this.initialized && !this.closed, 'SERVICE_NOT_READY', 'Initialize an open service before use');
    if (this.backgroundError) throw new BacktestError('STORAGE_FAILURE', 'Background persistence failed; restart after repairing the store', '', { reason: String(this.backgroundError) });
  }
  private snapshot(status: JobStatus): JobStatus { return structuredClone(status); }
  private jobPath(id: string) { return handlePath(this.storeDir, 'jobs', id, 'job'); }
  private dataPath(id: string) { return handlePath(this.storeDir, 'datasets', id, 'ds'); }
  private planPath(id: string) { return handlePath(this.storeDir, 'plans', id, 'plan'); }
  private stagePath(id: string) { this.jobPath(id); return resolve(this.storeDir, 'staging', id, 'dataset.json'); }
  private background(promise: Promise<unknown>): void { void promise.catch(error => { this.backgroundError = error; }); }

  private persist(record: RecordFile): Promise<void> {
    const id = record.status.id;
    const value = structuredClone(record);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(() => atomicJSON(this.jobPath(id), value));
    this.writes.set(id, next);
    void next.then(() => { if (this.writes.get(id) === next) this.writes.delete(id); }, () => {});
    return next;
  }

  private async readRecord(id: string): Promise<RecordFile> {
    const path = this.jobPath(id);
    try {
      const value = JSON.parse(await readBoundedText(await storeFile(this.storeDir, path), 8 * 1024 * 1024)) as RecordFile;
      assertThat(value.schemaVersion === '1' && value.status?.id === id && ['prepare', 'validate', 'run', 'explain', 'sweep', 'walk_forward', 'factors'].includes(value.status.kind), 'CORRUPT_JOB', 'Invalid persisted job');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BacktestError('JOB_NOT_FOUND', 'Job handle does not exist');
      throw error;
    }
  }

  private async enqueue(task: Task): Promise<JobStatus> {
    this.ready();
    assertThat(this.active.size < this.options.maxQueuedJobs, 'QUEUE_LIMIT', 'Job queue/active-work budget exceeded');
    assertThat(Buffer.byteLength(JSON.stringify(task)) <= 4 * 1024 * 1024, 'REQUEST_TOO_LARGE', 'Job request exceeds 4 MiB');
    const id = `job_${randomUUID()}`, at = now();
    const record: RecordFile = { schemaVersion: '1', status: { id, kind: task.kind, state: 'queued', createdAt: at, updatedAt: at }, task: structuredClone(task) };
    this.active.set(id, record);
    try { await this.persist(record); this.ready(); this.queue.push(id); this.schedule(); return this.snapshot(record.status); }
    catch (error) { this.active.delete(id); throw error; }
  }

  async prepare(options: ImportDatasetOptions): Promise<JobStatus> {
    this.ready();
    const path = await workspaceFile(this.workspace, options.path);
    const maxFileBytes = options.maxFileBytes ?? this.options.maxImportBytes;
    const maxRows = options.maxRows ?? this.options.maxImportRows;
    assertThat(maxFileBytes <= this.options.maxImportBytes && maxRows <= this.options.maxImportRows, 'RESOURCE_LIMIT', 'Import limits exceed the service budget');
    return this.enqueue({ kind: 'prepare', options: { ...options, path, maxFileBytes, maxRows } });
  }

  /** Enqueue decoding and linked preflight without waiting behind existing jobs. */
  async validateJob(datasetId: string, specification: unknown): Promise<JobStatus> {
    this.ready();
    await storeFile(this.storeDir, this.dataPath(datasetId));
    const spec = parseSpec(specification);
    assertThat(spec.limits.maxRuntimeMs <= this.options.maxJobRuntimeMs, 'RESOURCE_LIMIT', 'Runtime limit exceeds the service budget');
    return this.enqueue({ kind: 'validate', datasetId, spec });
  }

  async validate(datasetId: string, specification: unknown): Promise<{ planId: string; resolvedSpec: BacktestSpec; datasetId: string; warnings: Diagnostic[]; estimates: Record<string, unknown> }> {
    const pending = await this.validateJob(datasetId, specification);
    const status = await this.waitFor(pending.id);
    if (status.state !== 'succeeded') throw new BacktestError(status.error?.code ?? 'VALIDATION_FAILED', status.error?.message ?? 'Validation did not complete', status.error?.path ?? '', { ...status.error?.details, jobId: status.id });
    return status.result as unknown as { planId: string; resolvedSpec: BacktestSpec; datasetId: string; warnings: Diagnostic[]; estimates: Record<string, unknown> };
  }

  private async readPlan(id: string): Promise<Plan> {
    let plan: Plan;
    try { plan = JSON.parse(await readBoundedText(await storeFile(this.storeDir, this.planPath(id)), 4 * 1024 * 1024)) as Plan; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BacktestError('PLAN_NOT_FOUND', 'Plan does not exist'); throw error; }
    assertThat(plan.schemaVersion === '1' && plan.planId === id && plan.engineVersion === ENGINE_VERSION, 'PLAN_VERSION_MISMATCH', 'Plan was made for an unavailable engine version');
    const expected = this.makePlan(plan.datasetId, plan.datasetHash, parseSpec(plan.resolvedSpec), plan.warnings);
    assertThat(expected.planId === id, 'PLAN_INTEGRITY_ERROR', 'Stored plan content no longer matches its identity');
    return plan;
  }

  private makePlan(datasetId: string, datasetHash: string, resolvedSpec: BacktestSpec, warnings: Diagnostic[]): Plan {
    const base = { schemaVersion: '1' as const, engineVersion: ENGINE_VERSION, datasetId, datasetHash, resolvedSpec, warnings };
    return { ...base, planId: `plan_${contentHash(base).slice(0, 32)}` };
  }

  async run(planId: string): Promise<JobStatus> { this.ready(); return this.enqueue({ kind: 'run', plan: await this.readPlan(planId) }); }

  private boundResearch<T extends { concurrency: number; maxCandidates: number; maxTotalBars: number; maxRuntimeMs: number; maxDatasetBytes: number; workerMemoryMb: number }>(request: T): T {
    assertThat(request.concurrency <= this.options.maxResearchWorkers && request.maxCandidates <= this.options.maxResearchCandidates && request.maxTotalBars <= this.options.maxResearchBars && request.maxRuntimeMs <= this.options.maxJobRuntimeMs && request.maxDatasetBytes <= this.options.maxCacheBytes && request.workerMemoryMb <= this.options.workerMemoryMb, 'RESOURCE_LIMIT', 'Research request exceeds service worker, candidate, data or runtime limits');
    return request;
  }
  private researchDefaults<T extends SweepRequest>(input: T): T {
    assertThat(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_SWEEP_REQUEST', 'Research request must be an object');
    return { ...input, concurrency: input.concurrency ?? Math.min(2, this.options.maxResearchWorkers), maxCandidates: input.maxCandidates ?? Math.min(1000, this.options.maxResearchCandidates), maxTotalBars: input.maxTotalBars ?? Math.min(100_000_000, this.options.maxResearchBars), maxRuntimeMs: input.maxRuntimeMs ?? Math.min(120_000, this.options.maxJobRuntimeMs), maxDatasetBytes: input.maxDatasetBytes ?? Math.min(256 * 1024 * 1024, this.options.maxCacheBytes), workerMemoryMb: input.workerMemoryMb ?? Math.min(512, this.options.workerMemoryMb) };
  }
  async sweep(planId: string, input: SweepRequest): Promise<JobStatus> {
    this.ready(); const request = this.boundResearch(parseSweepRequest(this.researchDefaults(input)));
    return this.enqueue({ kind: 'sweep', plan: await this.readPlan(planId), request });
  }
  async walkForward(planId: string, input: WalkForwardRequest): Promise<JobStatus> {
    this.ready(); const request = this.boundResearch(parseWalkForwardRequest(this.researchDefaults(input)));
    return this.enqueue({ kind: 'walk_forward', plan: await this.readPlan(planId), request });
  }
  async factors(datasetId: string, input: FactorRequest): Promise<JobStatus> {
    this.ready(); assertThat(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_FACTOR_REQUEST', 'Factor request must be an object');
    const request = parseFactorRequest({ ...input, maxRows: input.maxRows ?? Math.min(100_000, this.options.maxImportRows), maxRuntimeMs: input.maxRuntimeMs ?? Math.min(120_000, this.options.maxJobRuntimeMs) });
    assertThat(request.maxRuntimeMs <= this.options.maxJobRuntimeMs && request.maxRows <= this.options.maxImportRows, 'RESOURCE_LIMIT', 'Factor request exceeds service row or runtime limits');
    await storeFile(this.storeDir, this.dataPath(datasetId));
    return this.enqueue({ kind: 'factors', datasetId, request });
  }
  async study(studyId: string, query: StudyQuery): Promise<StudyPage> { this.ready(); return queryStudy(this.storeDir, studyId, query); }

  async explain(runId: string, query: ExplainQuery): Promise<JobStatus> {
    this.ready();
    assertThat([query.orderId, query.fillId, query.at].filter(v => v !== undefined).length === 1 && (query.symbol === undefined || query.at !== undefined), 'INVALID_EXPLANATION_QUERY', 'Select exactly one orderId, fillId, or at; symbol is only valid with at');
    const manifest = await readManifest(this.storeDir, runId);
    assertThat(manifest.engineVersion === ENGINE_VERSION, 'REPLAY_VERSION_UNAVAILABLE', 'Original engine version is unavailable');
    const original = await readResolvedSpec(this.storeDir, runId);
    assertThat(original.datasetId, 'REPLAY_DATA_UNAVAILABLE', 'Original run did not retain a dataset handle');
    const resolvedSpec = parseSpec({ ...original, output: { level: 'fullTrace' } });
    assertThat(resolvedSpec.limits.maxRuntimeMs <= this.options.maxJobRuntimeMs, 'RESOURCE_LIMIT', 'Runtime limit exceeds the service budget');
    await storeFile(this.storeDir, this.dataPath(original.datasetId!));
    // Linked-data validation and decoding happen inside this queued worker job.
    const plan = this.makePlan(original.datasetId!, manifest.datasetHash, resolvedSpec, []);
    return this.enqueue({ kind: 'explain', plan, sourceRunId: runId, sourceFingerprint: manifest.fingerprint, query });
  }

  async job(id: string, action: 'status' | 'cancel' = 'status'): Promise<JobStatus> {
    this.ready();
    assertThat(action === 'status' || action === 'cancel', 'INVALID_JOB_ACTION', 'Use status or cancel');
    const record = this.active.get(id) ?? await this.readRecord(id);
    if (action === 'status' || terminal(record.status.state)) return this.snapshot(record.status);
    const slot = this.slots.find(s => s.id === id);
    if (slot?.finalizing) {
      // A rejected cancellation must not overwrite a terminal status being
      // committed while cleanup still keeps the active job nonterminal.
      return { ...this.snapshot(record.status), cancellation: { accepted: false, reason: 'COMMIT_ALREADY_STARTED' } };
    }
    record.status.cancellation = { accepted: true };
    if (record.status.state === 'queued') {
      const index = this.queue.indexOf(id); if (index >= 0) this.queue.splice(index, 1);
      await this.finish(record, 'canceled');
    } else {
      record.status.state = 'cancel_requested'; record.status.updatedAt = now();
      if (slot?.cancel) Atomics.store(slot.cancel, 0, 1);
      await this.persist(record);
      if (slot && !slot.fallback) slot.fallback = setTimeout(() => this.background(this.stopSlot(slot, id, 'canceled')), this.options.cancelGraceMs);
    }
    return this.snapshot(record.status);
  }

  private async waitFor(id: string): Promise<JobStatus> {
    const record = this.active.get(id) ?? await this.readRecord(id);
    if (terminal(record.status.state)) return this.snapshot(record.status);
    return new Promise(resolve => { const list = this.waiters.get(id) ?? []; list.push(resolve); this.waiters.set(id, list); });
  }

  private schedule(): void {
    if (this.closed || this.backgroundError) return;
    for (const slot of this.slots) {
      if (slot.id) continue;
      const used = this.slots.reduce((sum, current) => sum + (current.researchWorkers ?? 0), 0);
      const cost = (task: Task) => task.kind === 'sweep' || task.kind === 'walk_forward' ? task.request.concurrency ?? 2 : 0;
      const index = this.queue.findIndex(id => cost(this.active.get(id)!.task) + used <= this.options.maxResearchWorkers);
      if (index < 0) break;
      const [id] = this.queue.splice(index, 1); if (!id) break;
      slot.researchWorkers = cost(this.active.get(id)!.task);
      slot.id = id; slot.committing = false; slot.timedOut = false;
      this.background(this.start(slot, this.active.get(id)!));
    }
  }

  private worker(slot: Slot): Worker {
    if (slot.worker) return slot.worker;
    const base = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
    const path = resolve(base, existsSync(resolve(base, 'worker.cjs')) ? 'worker.cjs' : 'worker.js');
    const worker = new Worker(path, { workerData: { workspace: this.workspace, storeDir: this.storeDir, maxCacheBytes: this.options.maxCacheBytes }, resourceLimits: { maxOldGenerationSizeMb: this.options.workerMemoryMb } });
    slot.worker = worker;
    worker.on('message', message => {
      if (slot.worker !== worker || slot.id !== message.id || slot.finalizing || this.closed) return;
      const pending = this.message(slot, message);
      this.background(pending);
    });
    worker.on('error', error => { if (slot.worker === worker && slot.id && !this.closed) this.background(this.failSlot(slot, error)); });
    worker.on('exit', code => { if (slot.worker === worker) { slot.worker = undefined; if (slot.id && !this.closed) this.background(this.failSlot(slot, new BacktestError('WORKER_EXIT', `Worker exited before committing (code ${code})`))); } });
    return worker;
  }

  private async start(slot: Slot, record: RecordFile): Promise<void> {
    record.status.state = 'running'; record.status.updatedAt = now(); record.status.progress = { stage: 'starting' };
    slot.cancel = new Int32Array(new SharedArrayBuffer(4));
    await this.persist(record);
    if (this.closed || slot.id !== record.status.id || slot.finalizing || terminal(record.status.state)) return;
    let task: WorkerTask;
    if (record.task.kind === 'prepare') task = { kind: 'prepare', id: record.status.id, cancel: slot.cancel.buffer as SharedArrayBuffer, options: record.task.options, stagedPath: this.stagePath(record.status.id) };
    else if (record.task.kind === 'factors') task = { kind: 'factors', id: record.status.id, cancel: slot.cancel.buffer as SharedArrayBuffer, datasetPath: this.dataPath(record.task.datasetId), expectedDatasetId: record.task.datasetId, request: record.task.request };
    else {
      const datasetId = record.task.kind === 'validate' ? record.task.datasetId : record.task.plan.datasetId;
      const spec = record.task.kind === 'validate' ? record.task.spec : record.task.plan.resolvedSpec;
      const common = { id: record.status.id, cancel: slot.cancel.buffer as SharedArrayBuffer, datasetPath: this.dataPath(datasetId), expectedDatasetId: datasetId, ...(record.task.kind === 'validate' ? {} : { expectedHash: record.task.plan.datasetHash }), spec };
      if (record.task.kind === 'sweep') task = { ...common, kind: 'sweep', request: record.task.request };
      else if (record.task.kind === 'walk_forward') task = { ...common, kind: 'walk_forward', request: record.task.request };
      else task = { ...common, kind: record.task.kind === 'validate' ? 'validate' : 'run' };
    }
    this.worker(slot).postMessage(task);
    slot.timeout = setTimeout(() => {
      if (slot.id !== record.status.id || slot.committing) return;
      slot.timedOut = true; if (slot.cancel) Atomics.store(slot.cancel, 0, 1);
      clearTimeout(slot.fallback);
      slot.fallback = setTimeout(() => this.background(this.stopSlot(slot, record.status.id, 'failed')), this.options.cancelGraceMs);
    }, this.options.maxJobRuntimeMs);
  }

  private async message(slot: Slot, message: { type: string; id: string; stage?: string; done?: number; total?: number; result?: any; error?: ReturnType<typeof errorJSON> }): Promise<void> {
    const record = this.active.get(message.id); if (!record || terminal(record.status.state)) return;
    if (message.type === 'progress') {
      record.status.progress = { stage: message.stage ?? 'running', done: message.done, total: message.total }; record.status.updatedAt = now();
      await this.persist(record); return;
    }
    if (message.type !== 'done' && message.type !== 'error') return;
    return this.completeSlot(slot, message.id, async () => {
    if (slot.timedOut) { await this.finish(record, 'failed', new BacktestError('JOB_TIMEOUT', 'Job exceeded the service wall-time budget')); return; }
    if (record.status.state === 'cancel_requested') { await this.finish(record, 'canceled'); return; }
    if (message.type === 'error') { await this.finish(record, 'failed', new BacktestError(message.error?.code ?? 'WORKER_ERROR', message.error?.message ?? 'Worker failed', message.error?.path ?? '', message.error?.details)); return; }
    slot.committing = true; clearTimeout(slot.timeout); clearTimeout(slot.fallback);
    record.status.progress = { stage: 'committing' }; await this.persist(record);
    try {
      if (record.task.kind === 'prepare') {
        const result = message.result as { datasetId: string; hash: string; rowCount: number; [key: string]: unknown };
        const destination = this.dataPath(result.datasetId);
        assertThat(result.datasetId === `ds_${result.hash.slice(0, 24)}`, 'DATASET_INTEGRITY_ERROR', 'Worker dataset identity mismatch');
        const manifestPath = resolve(this.storeDir, 'datasets', `${result.datasetId}.manifest.json`);
        const manifest = { schemaVersion: '1', ...result, source: record.task.options.path, retention: 'until-explicit-cleanup' };
        await this.withStoreCommit(async remaining => {
          const prior = await stat(destination).then(s => s.size, () => 0);
          const priorManifest = await stat(manifestPath).then(s => s.size, () => 0);
          assertThat((await stat(this.stagePath(record.status.id))).size + Buffer.byteLength(JSON.stringify(manifest)) <= remaining + prior + priorManifest, 'STORE_QUOTA_EXCEEDED', 'Retained artifact storage budget exceeded');
          await rename(this.stagePath(record.status.id), destination);
          await atomicJSON(manifestPath, manifest);
        });
        const metadata = result.metadata as DatasetMetadata;
        const warnings = result.warnings as Diagnostic[];
        record.status.result = { datasetId: result.datasetId, hash: result.hash, rowCount: result.rowCount, sourceHash: result.sourceHash,
          warnings: warnings.slice(0, 50), warningCount: warnings.length,
          coverage: { firstSession: metadata.sessions[0], lastSession: metadata.sessions.at(-1), sessionCount: metadata.sessions.length },
          instrumentCount: metadata.instruments.length, frequency: metadata.frequency, timezone: metadata.timezone, currency: metadata.currency };

      } else if (record.task.kind === 'validate') {
        const result = message.result as { datasetId: string; datasetHash: string; resolvedSpec: BacktestSpec; warnings: Diagnostic[]; estimates: Record<string, unknown> };
        const plan = this.makePlan(result.datasetId, result.datasetHash, result.resolvedSpec, result.warnings);
        await this.withStoreCommit(async remaining => {
          const prior = await stat(this.planPath(plan.planId)).then(s => s.size, () => 0);
          assertThat(Buffer.byteLength(JSON.stringify(plan)) <= remaining + prior, 'STORE_QUOTA_EXCEEDED', 'Retained artifact storage budget exceeded');
          await atomicJSON(this.planPath(plan.planId), plan);
        });
        record.status.result = { planId: plan.planId, resolvedSpec: plan.resolvedSpec, datasetId: plan.datasetId, warnings: plan.warnings, estimates: result.estimates };
      } else if (record.task.kind === 'sweep' || record.task.kind === 'walk_forward' || record.task.kind === 'factors') {
        const result = message.result as StudyResult, task = record.task;
        assertThat(result.kind === task.kind, 'INVALID_STUDY', 'Worker study kind differs from job');
        if (task.kind !== 'factors') assertThat(result.datasetHash === task.plan.datasetHash, 'DATASET_INTEGRITY_ERROR', 'Research dataset differs from plan');
        const studyId = `study_${randomUUID()}`, runId = result.kind === 'walk_forward' ? `run_${randomUUID()}` : undefined;
        await this.withStoreCommit(async remaining => {
          assertThat(remaining > 64 * 1024, 'STORE_QUOTA_EXCEEDED', 'Retained artifact storage budget exceeded');
          let budget = Math.min(this.options.maxOutputBytes, remaining - 64 * 1024), publishedRun = false;
          try {
            if (result.kind === 'walk_forward') {
              const manifest = await persistResult(this.storeDir, runId!, result.continuous, { maxBytes: budget }); publishedRun = true;
              budget -= Object.values(manifest.artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0) + (await stat(resolve(this.storeDir, 'runs', runId!, 'manifest.json'))).size;
            }
            assertThat(budget > 0, 'OUTPUT_BYTE_LIMIT', 'Research output exceeds its combined run/study byte budget');
            const input = { datasetId: task.kind === 'factors' ? task.datasetId : task.plan.datasetId, ...(task.kind === 'factors' ? {} : { planId: task.plan.planId, specification: task.plan.resolvedSpec }), request: task.request };
            await persistStudy(this.storeDir, studyId, result, input, { maxBytes: budget, ...(runId ? { runId } : {}) });
          } catch (error) { if (publishedRun) await rm(resolve(this.storeDir, 'runs', runId!), { recursive: true, force: true }); throw error; }
        });
        record.status.result = { studyId, kind: result.kind, ...(runId ? { runId } : {}) };
      } else {
        const result = message.result as BacktestResult;
        assertThat(result.datasetHash === record.task.plan.datasetHash, 'DATASET_INTEGRITY_ERROR', 'Execution dataset differs from the validated plan');
        const runId = `run_${randomUUID()}`;
        const derived = record.task.kind === 'explain' ? { sourceRunId: record.task.sourceRunId, sourceFingerprint: record.task.sourceFingerprint } : {};
        await this.withStoreCommit(async remaining => {
          assertThat(remaining > 64 * 1024, 'STORE_QUOTA_EXCEEDED', 'Retained artifact storage budget exceeded');
          await persistResult(this.storeDir, runId, result, { maxBytes: Math.min(this.options.maxOutputBytes, remaining - 64 * 1024), ...derived });
        });
        record.status.result = { runId };
        if (record.task.kind === 'explain') record.status.result = { runId, sourceRunId: record.task.sourceRunId, replayRange: { start: result.spec.start, end: result.spec.end }, explanation: await explainResult(this.storeDir, runId, record.task.query) };
      }
      await this.finish(record, 'succeeded');
    } catch (error) { await this.finish(record, 'failed', error); }
    });
  }

  private async retainedBytes(): Promise<number> {
    const visit = async (path: string): Promise<number> => {
      let info;
      try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
      assertThat(!info.isSymbolicLink(), 'PATH_NOT_AUTHORIZED', 'Retained artifacts cannot contain symlinks');
      if (info.isFile()) return info.size;
      let bytes = 0;
      if (info.isDirectory()) for (const name of await readdir(path)) bytes += await visit(resolve(path, name));
      return bytes;
    };
    let bytes = 0;
    for (const group of ['datasets', 'plans', 'runs', 'studies']) bytes += await visit(resolve(this.storeDir, group));
    return bytes;
  }

  private withStoreCommit<T>(operation: (remaining: number) => Promise<T>): Promise<T> {
    const next = this.commitQueue.then(async () => operation(this.options.maxStoreBytes - await this.retainedBytes()));
    this.commitQueue = next.catch(() => {});
    return next;
  }

  private async finish(record: RecordFile, state: JobState, error?: unknown): Promise<void> {
    const committed = { ...record, status: { ...record.status, state, updatedAt: now(), ...(error ? { error: errorJSON(error) } : {}) } };
    await this.persist(committed);
    await this.cleanupStage(record.status.id);
    Object.assign(record.status, committed.status);
    this.active.delete(record.status.id);
    for (const resolve of this.waiters.get(record.status.id) ?? []) resolve(this.snapshot(record.status));
    this.waiters.delete(record.status.id);
  }

  private async cleanupStage(id: string): Promise<void> {
    await rm(dirname(this.stagePath(id)), { recursive: true, force: true });
  }

  private completeSlot(slot: Slot, expectedId: string, operation: () => Promise<void>): Promise<void> {
    if (slot.id !== expectedId) return Promise.resolve();
    if (slot.finalizing) return slot.completion ?? Promise.resolve();
    slot.finalizing = true;
    clearTimeout(slot.timeout); clearTimeout(slot.fallback);
    const pending = operation().finally(() => this.releaseSlot(slot, expectedId));
    slot.completion = pending;
    return pending;
  }

  private releaseSlot(slot: Slot, expectedId: string): void {
    if (slot.id !== expectedId) return;
    clearTimeout(slot.timeout); clearTimeout(slot.fallback);
    slot.id = undefined; slot.cancel = undefined; slot.timeout = undefined; slot.fallback = undefined; slot.committing = false; slot.finalizing = false; slot.researchWorkers = 0;
    this.schedule();
  }

  private failSlot(slot: Slot, error: unknown): Promise<void> {
    const id = slot.id; if (!id) return Promise.resolve();
    const record = this.active.get(id); if (!record || slot.committing) return Promise.resolve();
    return this.completeSlot(slot, id, async () => {
      const worker = slot.worker; slot.worker = undefined;
      if (worker) await worker.terminate();
      await this.finish(record, record.status.state === 'cancel_requested' ? 'canceled' : 'failed', error);
    });
  }

  private stopSlot(slot: Slot, expectedId: string, state: 'canceled' | 'failed'): Promise<void> {
    const id = slot.id; if (!id || id !== expectedId || slot.committing) return Promise.resolve();
    const record = this.active.get(id); if (!record) return Promise.resolve();
    return this.completeSlot(slot, id, async () => {
      const worker = slot.worker; slot.worker = undefined;
      if (worker) await worker.terminate();
      if (state === 'canceled') record.status.cancellation = { accepted: true, reason: 'WORKER_TERMINATED' };
      await this.finish(record, state, state === 'failed' ? new BacktestError('JOB_TIMEOUT', 'Job exceeded the service wall-time budget') : undefined);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    if (this.initializing) await this.initializing.catch(() => {});
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { errors.push(error); } };
    try {
      for (const slot of this.slots) {
        clearTimeout(slot.timeout); clearTimeout(slot.fallback);
        if (slot.finalizing && slot.completion) await attempt(() => slot.completion!);
        if (slot.cancel) Atomics.store(slot.cancel, 0, 1);
        const worker = slot.worker; slot.worker = undefined;
        if (worker) await attempt(() => worker.terminate());
      }
      for (const record of [...this.active.values()]) if (!terminal(record.status.state)) await attempt(() => this.finish(record, 'interrupted', new BacktestError('INTERRUPTED', 'Service closed before job commit')));
      for (const write of this.writes.values()) await attempt(() => write);
      this.queue.length = 0;
    } finally { await attempt(() => this.releaseLock()); }
    if (errors.length) throw errors[0];
  }
}
