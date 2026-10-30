import { z } from 'zod';
import { assertThat } from '../spec/errors.js';
import { contentHash } from '../spec/canonical.js';
import { parseSpec } from '../spec/validate.js';
import { ENGINE_VERSION, runBacktest } from '../engine/run.js';
import type { BacktestResult, BacktestSpec, Dataset, Expression, RulesStrategy } from '../spec/types.js';
import { applyParameters, expandCandidates, objectiveSchema, parseSweepRequest, researchBudgetShape, runSweep, shareDataset, spaceSchema, type CandidateResult, type ResearchHooks, type SweepRequest } from './sweep.js';

export interface WalkForwardRequest extends SweepRequest {
  trainSessions: number; testSessions: number; mode: 'rolling' | 'expanding';
  warmup: 'all_prior'; positionPolicy: 'carry'; pendingOrderPolicy: 'carry'; maxWindows?: number;
}
export interface WalkForwardWindow {
  index: number; trainStart: number; trainEnd: number; testStart: number; testEnd: number;
  selectedAt: number; selected: CandidateResult; sweepFingerprint: string; candidateCount: number;
  compiledRuleIndexes: number[];
}
export interface WalkForwardResult {
  schemaVersion: '1'; kind: 'walk_forward'; engineVersion: string; datasetHash: string; fingerprint: string;
  policies: { warmup: 'all_prior'; positionPolicy: 'carry'; pendingOrderPolicy: 'carry'; trainingAccount: 'fresh_initial_cash_each_window' };
  windows: WalkForwardWindow[]; continuous: BacktestResult; unusedTailSessions: number;
  orderWindows: Array<{ orderId: string; windowIndex: number; candidateId: string; selectedAt: number }>;
  limitations: string[];
}
export const walkForwardRequestSchema = z.strictObject({
  space: spaceSchema, objective: objectiveSchema, ...researchBudgetShape,
  trainSessions: z.number().int().min(1).max(1_000_000), testSessions: z.number().int().min(1).max(1_000_000),
  mode: z.enum(['rolling', 'expanding']), warmup: z.literal('all_prior'), positionPolicy: z.literal('carry'), pendingOrderPolicy: z.literal('carry'),
  maxWindows: z.number().int().min(1).max(128).default(32),
});
export function parseWalkForwardRequest(input: unknown): z.infer<typeof walkForwardRequestSchema> {
  const parsed = walkForwardRequestSchema.safeParse(input);
  assertThat(parsed.success, 'INVALID_WALK_FORWARD_REQUEST', 'Invalid walk-forward request', '', { issues: parsed.error?.issues.slice(0, 10) });
  assertThat(Object.keys(parsed.data.space).every(pointer => pointer.startsWith('/strategy/')), 'WF_PARAMETER_SCOPE', 'Continuous walk-forward may vary strategy scalars only; account, execution and costs remain fixed');
  return parsed.data;
}

interface SessionBoundary { sessionIndex: number; open: number }
function sessionsInRange(dataset: Dataset, spec: BacktestSpec): SessionBoundary[] {
  const sessions = new Map<number, number>();
  for (const series of dataset.series.values()) for (let i = 0; i < series.closeTime.length; i++) {
    if (series.closeTime[i]! < spec.start || series.closeTime[i]! >= spec.end) continue;
    const index = series.sessionIndex[i]!, open = series.openTime[i]!;
    sessions.set(index, Math.min(sessions.get(index) ?? Infinity, open));
  }
  const result = [...sessions].sort(([a], [b]) => a - b).map(([sessionIndex, open]) => ({ sessionIndex, open }));
  assertThat(result.every((value, index) => index === 0 || value.sessionIndex === result[index - 1]!.sessionIndex + 1), 'WF_MISSING_SESSION', 'Walk-forward requires bars for every calendar session between its first and last observed sessions');
  return result;
}
function renameExpression(expression: Expression, names: Map<string, string>): Expression {
  if ('ref' in expression) return { ref: names.get(expression.ref)! };
  if ('op' in expression) return { ...expression, args: expression.args.map(argument => renameExpression(argument, names)) };
  return { ...expression };
}
function gateStrategy(strategy: RulesStrategy, window: WalkForwardWindow, combined: RulesStrategy): void {
  const names = new Map(Object.keys(strategy.nodes).map((name, index) => [name, `wf${window.index}_n${index}`]));
  for (const [name, expression] of Object.entries(strategy.nodes)) combined.nodes[names.get(name)!] = renameExpression(expression, names);
  for (const rule of strategy.rules) {
    window.compiledRuleIndexes.push(combined.rules.length);
    combined.rules.push({ ...structuredClone(rule), when: { op: 'and', args: [
      { op: 'gte', args: [{ time: 'at' }, { value: window.testStart }] },
      { op: 'lt', args: [{ time: 'at' }, { value: window.testEnd }] },
      renameExpression(rule.when, names),
    ] } });
  }
}

/** Select on past intervals, then run all selected gates in one continuous ledger. */
export async function runWalkForward(dataset: Dataset, specification: unknown, input: WalkForwardRequest, hooks: ResearchHooks = {}): Promise<WalkForwardResult> {
  const started = performance.now(), request = parseWalkForwardRequest(input), base = parseSpec(specification);
  assertThat(base.strategy.kind === 'rules', 'WF_STRATEGY_NOT_SUPPORTED', 'Continuous carry walk-forward currently supports rules strategies');
  const { trainSessions, testSessions, mode, warmup, positionPolicy, pendingOrderPolicy, maxWindows, ...sweepInput } = request;
  const sweepRequest = parseSweepRequest(sweepInput), candidates = expandCandidates(base, sweepRequest), sessions = sessionsInRange(dataset, base);
  const windowCount = Math.floor((sessions.length - trainSessions) / testSessions);
  assertThat(windowCount > 0, 'WF_INSUFFICIENT_SESSIONS', 'At least one complete training and test window is required');
  assertThat(windowCount <= maxWindows, 'WF_WINDOW_LIMIT', 'Requested windows exceed maxWindows');
  assertThat(dataset.rowCount * (candidates.length * windowCount + 1) <= request.maxTotalBars, 'RESEARCH_BAR_BUDGET', 'Training windows plus continuous OOS execution exceed maxTotalBars');
  const shared = shareDataset(dataset, request.maxDatasetBytes).dataset;
  const windows: WalkForwardWindow[] = [], combined: RulesStrategy = { kind: 'rules', nodes: {}, rules: [] };
  for (let index = 0; index < windowCount; index++) {
    assertThat(!hooks.canceled?.(), 'CANCELED', 'Walk-forward canceled');
    const remaining = Math.floor(request.maxRuntimeMs - (performance.now() - started));
    assertThat(remaining > 0, 'RESEARCH_TIMEOUT', 'Walk-forward exceeded maxRuntimeMs');
    const testIndex = trainSessions + index * testSessions, endIndex = testIndex + testSessions;
    const trainIndex = mode === 'rolling' ? testIndex - trainSessions : 0;
    const trainStart = Math.max(base.start, sessions[trainIndex]!.open), trainEnd = sessions[testIndex]!.open;
    const testStart = trainEnd, testEnd = endIndex < sessions.length ? sessions[endIndex]!.open : base.end;
    assertThat(trainStart < trainEnd && trainEnd === testStart && (index === 0 || windows[index - 1]!.testEnd === testStart), 'WF_INVALID_WINDOWS', 'Training must precede contiguous, non-overlapping OOS windows');
    const training = { ...base, start: trainStart, end: trainEnd, account: { ...base.account, cashFlows: base.account.cashFlows.filter(flow => flow.at >= trainStart && flow.at < trainEnd) } };
    const sweep = await runSweep(shared, training, { ...sweepInput, maxRuntimeMs: remaining }, { canceled: hooks.canceled, progress: done => hooks.progress?.(index * candidates.length + done, windowCount * candidates.length + 1) });
    const selected = sweep.candidates.find(candidate => candidate.id === sweep.winnerId)!;
    const window: WalkForwardWindow = { index, trainStart, trainEnd, testStart, testEnd, selectedAt: trainEnd, selected, sweepFingerprint: sweep.fingerprint, candidateCount: sweep.candidateCount, compiledRuleIndexes: [] };
    const strategy = applyParameters(base, selected.parameters).strategy as RulesStrategy;
    gateStrategy(strategy, window, combined); windows.push(window);
  }
  const remaining = Math.floor(request.maxRuntimeMs - (performance.now() - started));
  assertThat(remaining > 0, 'RESEARCH_TIMEOUT', 'Walk-forward exceeded maxRuntimeMs');
  const start = windows[0]!.testStart, end = windows.at(-1)!.testEnd;
  const continuousSpec: BacktestSpec = { ...base, start, end, strategy: combined,
    account: { ...base.account, cashFlows: base.account.cashFlows.filter(flow => flow.at >= start && flow.at < end) },
    seed: Number.parseInt(contentHash({ seed: request.seed, stream: 'continuous-oos' }).slice(0, 8), 16),
  };
  const continuous = runBacktest(shared, continuousSpec, { canceled: () => {
    assertThat(performance.now() - started <= request.maxRuntimeMs, 'RESEARCH_TIMEOUT', 'Walk-forward exceeded maxRuntimeMs');
    return hooks.canceled?.() ?? false;
  } });
  hooks.progress?.(windowCount * candidates.length + 1, windowCount * candidates.length + 1);
  const identity = { engineVersion: ENGINE_VERSION, datasetHash: dataset.hash, specification: base, request: { ...request, concurrency: undefined, maxRuntimeMs: undefined }, selections: windows.map(window => ({ start: window.testStart, end: window.testEnd, id: window.selected.id })) };
  return { schemaVersion: '1', kind: 'walk_forward', engineVersion: ENGINE_VERSION, datasetHash: dataset.hash, fingerprint: contentHash(identity),
    policies: { warmup, positionPolicy, pendingOrderPolicy, trainingAccount: 'fresh_initial_cash_each_window' }, windows, continuous,
    orderWindows: continuous.orders.map(order => {
      const window = windows.find(candidate => candidate.testStart <= order.submittedAt && order.submittedAt < candidate.testEnd)!;
      return { orderId: order.id, windowIndex: window.index, candidateId: window.selected.id, selectedAt: window.selectedAt };
    }),
    unusedTailSessions: sessions.length - trainSessions - windowCount * testSessions,
    limitations: [
      'OOS metrics come from one continuous account. Training accounts restart at the configured initial cash and never contain test-period events.',
      'Only rules strategies and scalar strategy parameters are supported. Costs, protective execution settings and account policies remain fixed.',
      'All prior available bars warm indicators; account-dependent indicator history before each training start observes an empty account.',
      'Positions, settlement lots, fees, pending orders and cash carry across OOS switches. orderWindows attributes retained order records to the window active at submission; protective orders still follow the fixed execution policy. compiledRuleIndexes map combined rules to their selections.',
      'Selection becomes available at testStart. Its first decision is an eligible bar close, with execution at the next bar open. Incomplete final test windows are omitted.',
    ] };
}
