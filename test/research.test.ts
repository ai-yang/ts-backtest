import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset } from '../src/data/normalize.js';
import { BacktestError } from '../src/spec/errors.js';
import { runSweep, parseSweepRequest, expandCandidates, shareDataset, type SweepRequest } from '../src/research/sweep.js';
import { runWalkForward, type WalkForwardRequest } from '../src/research/walk-forward.js';
import { factorDiagnostics } from '../src/research/factors.js';
import type { BacktestSpec, DatasetInput, RulesStrategy } from '../src/spec/types.js';
import { input, spec, sessions, openAt, closeAt, instrument, bar } from './helpers.js';

const code = (expected: string) => (error: unknown) => error instanceof BacktestError && error.code === expected;
function rulesSpec(prices = ['10', '10', '12', '13', '14', '15', '16', '17']) {
  const dataset = normalizeDataset(input(prices));
  const specification = spec({ end: closeAt(sessions[prices.length - 1]!) + 1, strategy: { kind: 'rules', nodes: {}, rules: [{ when: { value: true }, action: { type: 'target_quantity', value: 2 } }] } });
  return { dataset, specification };
}
const sweep: SweepRequest = { space: { '/strategy/rules/0/action/value': [1, 2, 3] }, objective: { metric: 'netProfit', direction: 'maximize' }, seed: 42, concurrency: 2 };
const wf: WalkForwardRequest = { ...sweep, trainSessions: 3, testSessions: 2, mode: 'rolling', warmup: 'all_prior', positionPolicy: 'carry', pendingOrderPolicy: 'carry' };

test('shared bar arrays are copied once and reused without transferring ownership', () => {
  const { dataset } = rulesSpec();
  const first = shareDataset(dataset, 1_000_000), second = shareDataset(first.dataset, 1_000_000);
  const original = dataset.series.get('AAA')!.closeTicks, shared = first.dataset.series.get('AAA')!.closeTicks;
  assert.ok(shared.buffer instanceof SharedArrayBuffer);
  assert.deepEqual([...shared], [...original]);
  assert.equal(second.dataset.series.get('AAA')!.closeTicks.buffer, shared.buffer);
  assert.notEqual(shared.buffer, original.buffer);
  assert.throws(() => shareDataset(dataset, 1), code('RESEARCH_DATASET_BUDGET'));
});

test('sweep worker concurrency and parameter ordering do not change candidate seeds or results', async () => {
  const { dataset, specification } = rulesSpec();
  specification.execution.slippage = { type: 'uniform_bps', bps: 30 };
  const one = await runSweep(dataset, specification, { ...sweep, concurrency: 1 });
  const three = await runSweep(dataset, specification, { ...sweep, concurrency: 3 });
  const reversed = await runSweep(dataset, specification, { ...sweep, space: { '/strategy/rules/0/action/value': [3, 1, 2] }, concurrency: 2 });
  assert.deepEqual(one.candidates, three.candidates);
  assert.deepEqual(one.candidates, reversed.candidates);
  assert.equal(one.fingerprint, three.fingerprint);
  assert.equal(new Set(one.candidates.map(candidate => candidate.seed)).size, 3);
  assert.equal(one.candidates.find(candidate => candidate.id === one.winnerId)!.parameters['/strategy/rules/0/action/value'], 3);
});

test('strict scalar pointers reject insertion, type changes, prototype paths and duplicated values', () => {
  const { specification } = rulesSpec();
  const invalid: Array<[string, unknown[], string]> = [
    ['/strategy/rules/01/action/value', [1], 'INVALID_PARAMETER_POINTER'],
    ['/strategy/rules/0/action/absent', [1], 'INVALID_PARAMETER_POINTER'],
    ['/strategy/nodes/__proto__/value', [1], 'INVALID_PARAMETER_POINTER'],
    ['/strategy/rules/0/action/value~2', [1], 'INVALID_PARAMETER_POINTER'],
    ['/account/initialCash', ['1000'], 'INVALID_PARAMETER_POINTER'],
    ['/strategy/rules/0/action/value', ['1'], 'PARAMETER_TYPE_MISMATCH'],
    ['/strategy/rules/0/action/value', [1, 1], 'DUPLICATE_PARAMETER_VALUE'],
  ];
  for (const [pointer, values, expected] of invalid) assert.throws(() => expandCandidates(specification, parseSweepRequest({ ...sweep, space: { [pointer]: values } })), code(expected));
  assert.throws(() => parseSweepRequest({ ...sweep, arbitrary: true }), code('INVALID_SWEEP_REQUEST'));
  assert.throws(() => expandCandidates(specification, parseSweepRequest({ ...sweep, maxCandidates: 2 })), code('CANDIDATE_LIMIT'));
});

test('sweep budget and cancellation fail explicitly; undefined objectives never select a winner', async () => {
  const { dataset, specification } = rulesSpec();
  await assert.rejects(runSweep(dataset, specification, { ...sweep, maxTotalBars: 1 }), code('RESEARCH_BAR_BUDGET'));
  await assert.rejects(runSweep(dataset, specification, sweep, { canceled: () => true }), code('CANCELED'));
  await assert.rejects(runSweep(dataset, specification, { ...sweep, maxRuntimeMs: 1 }), code('RESEARCH_TIMEOUT'));
  const empty = structuredClone(specification); (empty.strategy as RulesStrategy).rules[0]!.action.value = 0;
  await assert.rejects(runSweep(dataset, empty, { ...sweep, space: { '/strategy/rules/0/action/value': [0] }, objective: { metric: 'sharpe', direction: 'maximize' } }), code('NO_VALID_CANDIDATE'));
});

test('walk-forward training selection cannot read the next test open or future closes', async () => {
  const original = rulesSpec(), changed = rulesSpec(['10', '10', '12', '1', '30', '2', '25', '17']);
  const a = await runWalkForward(original.dataset, original.specification, wf);
  const b = await runWalkForward(changed.dataset, changed.specification, wf);
  assert.equal(a.windows[0]!.selected.id, b.windows[0]!.selected.id);
  assert.deepEqual(a.windows[0]!.selected.metrics, b.windows[0]!.selected.metrics);
  assert.equal(a.windows[0]!.selected.parameters['/strategy/rules/0/action/value'], 3);
  assert.equal(a.windows[0]!.trainEnd, a.windows[0]!.testStart);
  assert.equal(a.windows[0]!.testEnd, a.windows[1]!.testStart);
  assert.equal(a.unusedTailSessions, 1);
});

test('walk-forward carries a partial order, commission and account across OOS switches', async () => {
  const raw = input(['10', '10', '12', '13', '14', '15', '16', '17']);
  raw.bars.forEach(value => { value.volume = 1; });
  const dataset = normalizeDataset(raw), { specification } = rulesSpec();
  specification.costs.periods[0]!.minimumCommission = '1';
  const result = await runWalkForward(dataset, specification, { ...wf, trainSessions: 2, space: { '/strategy/rules/0/action/value': [2] } });
  assert.equal(result.windows.length, 3);
  assert.equal(result.continuous.orders.length, 1);
  assert.equal(result.continuous.fills.length, 2);
  assert.equal(result.continuous.fills[0]!.at, openAt(sessions[3]!));
  assert.equal(result.continuous.fills[1]!.at, result.windows[1]!.testStart);
  assert.equal(result.continuous.metrics.fees, '1.00');
  assert.equal(result.continuous.metrics.finalEquity, '1006.00');
  assert.equal(result.continuous.events.filter(event => event.type === 'initial').length, 1);
  assert.equal(result.continuous.orders[0]!.source, `rule:${result.windows[0]!.compiledRuleIndexes[0]}`);
});

test('walk-forward rolling/expanding boundaries and parallel execution remain deterministic', async () => {
  const { dataset, specification } = rulesSpec();
  const one = await runWalkForward(dataset, specification, { ...wf, concurrency: 1 });
  const three = await runWalkForward(dataset, specification, { ...wf, concurrency: 3 });
  assert.deepEqual(one.continuous.metrics, three.continuous.metrics);
  assert.equal(one.continuous.fingerprint, three.continuous.fingerprint);
  assert.equal(one.fingerprint, three.fingerprint);
  assert.ok(one.windows[1]!.trainStart > one.windows[0]!.trainStart);
  const expanded = await runWalkForward(dataset, specification, { ...wf, mode: 'expanding', space: { '/strategy/rules/0/action/value': [2] } });
  assert.equal(expanded.windows[1]!.trainStart, expanded.windows[0]!.trainStart);
  await assert.rejects(runWalkForward(dataset, spec(), wf), code('WF_STRATEGY_NOT_SUPPORTED'));
  await assert.rejects(runWalkForward(dataset, specification, { ...wf, space: { '/execution/slippage/bps': [0] } }), code('WF_PARAMETER_SCOPE'));
  await assert.rejects(runWalkForward(dataset, specification, { ...wf, maxWindows: 1 }), code('WF_WINDOW_LIMIT'));
});

function factorInput(): DatasetInput {
  const symbols = ['AAA', 'BBB', 'CCC'];
  const raw = input(); raw.metadata.instruments = symbols.map(symbol => instrument(symbol));
  raw.bars = symbols.flatMap((symbol, index) => [bar(sessions[0]!, '10', { symbol }), bar(sessions[1]!, String(11 + index), { symbol }), bar(sessions[2]!, String(12 + 2 * index), { symbol })]);
  raw.features = symbols.map((symbol, index) => ({ symbol, name: 'score', availableAt: closeAt(sessions[0]!), value: index + 1 }));
  return raw;
}
const factorRequest = { feature: 'score', from: closeAt(sessions[0]!), to: closeAt(sessions[2]!) + 1, horizonBars: 1, groups: 3 };

test('factor IC, average-rank IC and equal-weight groups agree with a hand-computed cross-section', () => {
  const result = factorDiagnostics(normalizeDataset(factorInput()), factorRequest);
  assert.ok(Math.abs(result.periods[0]!.ic! - 1) < 1e-12);
  assert.equal(result.periods[0]!.rankIC, 1);
  assert.ok(Math.abs(result.periods[0]!.groups[0]!.meanReturn! - 0.1) < 1e-12);
  assert.ok(Math.abs(result.periods[0]!.groups[2]!.meanReturn! - 0.3) < 1e-12);
  assert.ok(Math.abs(result.periods[0]!.topMinusBottom! - 0.2) < 1e-12);
  assert.equal(result.excluded.labelOutsideRange, 3);
  assert.equal(result.observations, 6);
});

test('factor as-of timestamps, null revocation and label cutoff prevent leakage', () => {
  const raw = factorInput();
  raw.features![0]!.availableAt = closeAt(sessions[0]!) + 1;
  raw.features!.push({ symbol: 'BBB', name: 'score', availableAt: closeAt(sessions[1]!), value: null });
  const result = factorDiagnostics(normalizeDataset(raw), { ...factorRequest, to: closeAt(sessions[2]!) });
  assert.equal(result.periods[0]!.count, 2);
  assert.equal(result.periods[0]!.ic, null);
  assert.equal(result.periods[1]!.count, 0);
  assert.equal(result.excluded.missingFeature, 2);
  assert.equal(result.excluded.labelOutsideRange, 2);
  assert.equal(result.observations, 2);
});

test('factor labels crossing corporate actions and inactive universe members are excluded', () => {
  const raw = factorInput(); raw.metadata.universeMode = 'point_in_time';
  raw.membership = [{ symbol: 'AAA', availableAt: openAt(sessions[0]!), member: true }, { symbol: 'BBB', availableAt: openAt(sessions[0]!), member: true }];
  raw.actions = [{ symbol: 'AAA', type: 'dividend', at: openAt(sessions[1]!), payAt: openAt(sessions[2]!), amountPerShare: '0.1' }];
  const dataset = normalizeDataset(raw), result = factorDiagnostics(dataset, factorRequest);
  assert.equal(result.excluded.corporateAction, 1);
  assert.equal(result.excluded.notMember, 3);
  assert.equal(result.periods[0]!.count, 1);
  assert.throws(() => factorDiagnostics(dataset, { ...factorRequest, maxRows: 1 }), code('FACTOR_ROW_LIMIT'));
  assert.throws(() => factorDiagnostics(dataset, factorRequest, { canceled: () => true }), code('CANCELED'));
});

test('tied factor values stay together and constant cross-sections have undefined correlation', () => {
  const raw = factorInput(); raw.features!.forEach(point => { point.value = 1; });
  const result = factorDiagnostics(normalizeDataset(raw), factorRequest);
  assert.equal(result.periods[0]!.ic, null); assert.equal(result.periods[0]!.rankIC, null);
  assert.equal(result.periods[0]!.groups.filter(group => group.count > 0).length, 1);
  assert.equal(result.periods[0]!.topMinusBottom, null);
  assert.equal(result.summary.icIR, null);
});
