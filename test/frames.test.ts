import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFrames } from '../src/data/frames.js';
import { importDataset } from '../src/data/import.js';
import { normalizeDataset } from '../src/data/normalize.js';
import { decodeDataset, encodeDataset } from '../src/data/serialize.js';
import { parseFramePreparation, parseSpec } from '../src/spec/validate.js';
import { StrategyEvaluator } from '../src/strategy/evaluator.js';
import { runBacktest } from '../src/engine/run.js';
import type { DatasetInput, FramePreparation, FrameRecipe, Expression, Dataset } from '../src/spec/types.js';
import { bar, instrument, input, spec, openAt } from './helpers.js';

const MIN = 60_000;
const emptyState = () => ({ position: 0, holding_sessions: 0, holding_high: 0, cooldown_sessions: 0 });
function minuteData(dates = ['2024-01-02', '2024-01-03']): DatasetInput {
  const data = input();
  data.metadata.frequency = 'minute'; data.metadata.sessions = dates;
  data.metadata.calendarCoverage = { from: dates[0]!, through: dates.at(-1)! };
  data.metadata.sessionIntervals = dates.map(session => ({ session, segments: [
    { openTime: openAt(session), closeTime: openAt(session) + 4 * MIN },
    { openTime: openAt(session) + 10 * MIN, closeTime: openAt(session) + 14 * MIN },
  ] }));
  data.bars = [];
  let price = 10;
  for (const item of data.metadata.sessionIntervals) for (const segment of item.segments) {
    for (let at = segment.openTime; at < segment.closeTime; at += MIN) {
      data.bars.push(bar(item.session, String(price++), { openTime: at, closeTime: at + MIN, volume: 100, amount: '1000' }));
    }
  }
  return data;
}
function config(data: DatasetInput, recipe: Partial<FrameRecipe> = {}): FramePreparation {
  return { from: data.bars[0]!.openTime, asOf: data.bars.at(-1)!.closeTime, recipes: [{
    id: 'higher', frame: { unit: 'day' }, missingPolicy: 'error', nodes: {}, outputs: { close: { field: 'close' } }, ...recipe,
  }] };
}
const values = (data: Dataset, name = 'close', symbol = 'AAA') => data.features.filter(point => point.name === `frame:higher:${name}` && point.symbol === symbol).map(point => point.value);
const code = (callback: () => unknown, value: string) => assert.throws(callback, { code: value });

test('native N-minute bars anchor independently in each trading segment with explicit tail policy', () => {
  const raw = minuteData(['2024-01-02']);
  const outputs = Object.fromEntries(['open', 'high', 'low', 'close', 'volume', 'amount'].map(field => [field, { field }])) as Record<string, Expression>;
  const drop = applyFrames(normalizeDataset(raw), config(raw, { frame: { unit: 'minute', minutes: 3, tailPolicy: 'drop' }, outputs }));
  assert.deepEqual(values(drop), [12, 16]);
  assert.deepEqual(values(drop, 'open'), [10, 14]);
  assert.deepEqual(values(drop, 'high'), [12, 16]);
  assert.deepEqual(values(drop, 'low'), [10, 14]);
  assert.deepEqual(values(drop, 'volume'), [300, 300]);
  assert.deepEqual(values(drop, 'amount'), [3000, 3000]);
  const short = applyFrames(normalizeDataset(raw), config(raw, { frame: { unit: 'minute', minutes: 3, tailPolicy: 'short' } }));
  assert.deepEqual(values(short), [12, 13, 16, 17]);
  assert.deepEqual(short.features.map(point => point.availableAt), [3, 4, 13, 14].map(offset => openAt('2024-01-02') + offset * MIN));
});

test('higher-frame SMA advances once per completed frame and publishes warmup as explicit null', () => {
  const raw = minuteData();
  const result = applyFrames(normalizeDataset(raw), config(raw, { outputs: {
    close: { field: 'close' }, average: { op: 'sma', args: [{ field: 'close' }], period: 2 },
  } }));
  assert.deepEqual(values(result), [17, 25]);
  assert.deepEqual(values(result, 'average'), [null, 21]);
  assert.equal(result.metadata.frameProvenance!.counts[0]!.bars, 2);
  assert.equal(result.metadata.frequency, 'minute');
});

test('week and month completion follows the entire declared calendar, including unseen future bars', () => {
  const dates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-31', '2024-02-01'];
  const raw = minuteData(dates);
  raw.metadata.calendarCoverage = { from: '2024-01-01', through: '2024-02-29' };
  const weekly = config(raw, { frame: { unit: 'week' } });
  weekly.asOf = raw.metadata.sessionIntervals![3]!.segments.at(-1)!.closeTime;
  assert.deepEqual(values(applyFrames(normalizeDataset(raw), weekly)), [], 'Thursday cannot publish a Friday-complete week');
  weekly.asOf = raw.metadata.sessionIntervals![4]!.segments.at(-1)!.closeTime;
  assert.deepEqual(values(applyFrames(normalizeDataset(raw), weekly)), [49]);
  const monthly = config(raw, { frame: { unit: 'month' } });
  monthly.asOf = weekly.asOf;
  assert.deepEqual(values(applyFrames(normalizeDataset(raw), monthly)), []);
  monthly.asOf = raw.metadata.sessionIntervals![5]!.segments.at(-1)!.closeTime;
  assert.deepEqual(values(applyFrames(normalizeDataset(raw), monthly)), [57]);
  // An incomplete calendar itself cannot prove the last session of a month.
  const partialCalendar = structuredClone(raw);
  partialCalendar.metadata.calendarCoverage!.through = '2024-02-01';
  assert.deepEqual(values(applyFrames(normalizeDataset(partialCalendar), config(partialCalendar, { frame: { unit: 'month' } }))), [57]);
});

test('daily base bars aggregate to weekly frames without minute or execution-frequency fiction', () => {
  const raw = minuteData(['2024-01-01', '2024-01-02', '2024-01-05']);
  raw.metadata.frequency = 'day'; raw.metadata.calendarCoverage = { from: '2024-01-01', through: '2024-01-07' };
  raw.bars = raw.metadata.sessionIntervals!.map((item, i) => bar(item.session, String(10 + i), {
    openTime: item.segments[0]!.openTime, closeTime: item.segments.at(-1)!.closeTime,
  }));
  const result = applyFrames(normalizeDataset(raw), config(raw, { frame: { unit: 'week' } }));
  assert.deepEqual(values(result), [12]);
  assert.equal(result.metadata.frequency, 'day');
  code(() => applyFrames(normalizeDataset(raw), config(raw, { frame: { unit: 'minute', minutes: 5, tailPolicy: 'drop' } })), 'FRAME_UPSAMPLING');
});

test('partial first and final source windows never publish and extending future data preserves earlier values', () => {
  const raw = minuteData();
  const full = config(raw, { frame: { unit: 'minute', minutes: 3, tailPolicy: 'short' } });
  const partial = { ...full, from: full.from + MIN, asOf: full.from + 12 * MIN };
  const before = applyFrames(normalizeDataset(raw), partial);
  assert.deepEqual(values(before), [13]);
  const later = applyFrames(normalizeDataset(raw), { ...full, from: partial.from });
  assert.deepEqual(later.features.filter(point => point.availableAt <= partial.asOf), before.features);
  assert.ok(before.metadata.frameProvenance!.counts[0]!.excludedIncomplete > 0);
});

test('missing minutes and entire sessions obey explicit error/skip policy without advancing indicators', () => {
  const raw = minuteData(['2024-01-02', '2024-01-03', '2024-01-04']);
  raw.bars.splice(10, 1);
  const preparation = config(raw, { outputs: { average: { op: 'sma', args: [{ field: 'close' }], period: 2 } } });
  code(() => applyFrames(normalizeDataset(raw), preparation), 'INCOMPLETE_FRAME');
  preparation.recipes[0]!.missingPolicy = 'skip';
  const result = applyFrames(normalizeDataset(raw), preparation);
  assert.deepEqual(values(result, 'average'), [null, 25]); // (17 + 33) / 2, skipped day never updates SMA
  assert.equal(result.metadata.frameProvenance!.counts[0]!.skippedMissing, 1);
  assert.ok(result.warnings.some(warning => warning.code === 'SKIPPED_INCOMPLETE_FRAMES'));
  raw.bars = raw.bars.filter(row => row.session !== '2024-01-03');
  assert.equal(applyFrames(normalizeDataset(raw), preparation).metadata.frameProvenance!.counts[0]!.skippedMissing, 1);
});

test('misaligned minute bars, missing boundaries and invalid session calendars are rejected', () => {
  const raw = minuteData();
  raw.bars[0]!.openTime += 30_000; raw.bars[0]!.closeTime += 30_000;
  raw.bars.splice(1, 1);
  code(() => applyFrames(normalizeDataset(raw), config(raw)), 'FRAME_SOURCE_ALIGNMENT');
  const noCalendar = input();
  code(() => applyFrames(normalizeDataset(noCalendar), config(noCalendar)), 'FRAME_CALENDAR_REQUIRED');
  const bad = minuteData(); bad.metadata.sessionIntervals!.splice(0, 1);
  code(() => normalizeDataset(bad), 'INVALID_SESSION_BOUNDARIES');
  const overlap = minuteData(); overlap.metadata.sessionIntervals![0]!.segments[1]!.openTime = overlap.bars[0]!.openTime;
  code(() => normalizeDataset(overlap), 'INVALID_SESSION_BOUNDARIES');
});

test('frame expressions reject state, cycles, unknown parameters, duplicate identities and feature collisions', () => {
  const raw = minuteData();
  code(() => parseFramePreparation(config(raw, { outputs: { position: { state: 'position' } } })), 'FRAME_ACCOUNT_STATE');
  code(() => parseFramePreparation(config(raw, { nodes: { loop: { ref: 'loop' } } })), 'CYCLIC_EXPRESSION');
  code(() => parseFramePreparation({ ...config(raw), typo: true }), 'INVALID_SPEC');
  const duplicate = config(raw); duplicate.recipes.push(duplicate.recipes[0]!);
  code(() => parseFramePreparation(duplicate), 'DUPLICATE_FRAME');
  raw.features = [{ symbol: 'AAA', name: 'frame:higher:close', availableAt: raw.bars[0]!.closeTime, value: 1 }];
  code(() => applyFrames(normalizeDataset(raw), config(raw)), 'FRAME_FEATURE_COLLISION');
});

test('frame provenance and frozen features survive cache integrity checks and determine identity', () => {
  const raw = minuteData();
  const source = normalizeDataset(raw);
  const result = applyFrames(source, config(raw));
  assert.equal(source.metadata.frameProvenance, undefined, 'preparing frames must not mutate source identity');
  assert.equal(result.metadata.frameProvenance!.sourceHash, source.hash);
  assert.notEqual(result.hash, source.hash);
  assert.deepEqual(decodeDataset(encodeDataset(result)), result);
  const changed = config(raw); changed.recipes[0]!.missingPolicy = 'skip';
  assert.notEqual(applyFrames(source, changed).hash, result.hash, 'even nontriggered policy choices are provenance');
  code(() => applyFrames(result, config(raw)), 'FRAME_ALREADY_PREPARED');
});

test('deep frame configurations reserve cache-envelope depth before any preparation is published', () => {
  const raw = minuteData();
  let expression: Expression = { field: 'close' };
  for (let i = 0; i < 24; i++) expression = { op: 'ema', args: [expression], period: 1 };
  const result = applyFrames(normalizeDataset(raw), config(raw, { outputs: { deep: expression } }));
  assert.equal(decodeDataset(encodeDataset(result)).hash, result.hash);
  for (let i = 0; i < 6; i++) expression = { op: 'ema', args: [expression], period: 1 };
  code(() => applyFrames(normalizeDataset(raw), config(raw, { outputs: { deep: expression } })), 'INPUT_TOO_DEEP');
});

test('higher-frame features respect prediction publication and explicit missing-value withdrawal', () => {
  const raw = minuteData(['2024-01-02', '2024-01-03', '2024-01-04']);
  const firstClose = raw.metadata.sessionIntervals![0]!.segments.at(-1)!.closeTime;
  const secondClose = raw.metadata.sessionIntervals![1]!.segments.at(-1)!.closeTime;
  raw.features = [
    { symbol: 'AAA', name: 'prediction', availableAt: firstClose + 1, value: 2 },
    { symbol: 'AAA', name: 'prediction', availableAt: secondClose + 1, value: null },
  ];
  const result = applyFrames(normalizeDataset(raw), config(raw, { outputs: { prediction: { feature: 'prediction' } } }));
  assert.deepEqual(values(result, 'prediction'), [null, 2, null]);
  const expression: Expression = { feature: 'frame:higher:prediction' };
  const evaluator = new StrategyEvaluator(result, { strategy: { kind: 'rules', nodes: { expression }, rules: [] }, limits: { maxNodes: 10 } });
  const bars = result.series.get('AAA')!;
  for (let i = 0; i < bars.closeTime.length; i++) evaluator.step(new Map([['AAA', i]]), bars.closeTime[i]!, emptyState);
  assert.ok(Number.isNaN(evaluator.value(expression, 'AAA')), 'latest null must erase the former value');
});

test('native frame cross sections use synchronized completed bars and PIT membership', () => {
  const raw = minuteData();
  raw.metadata.instruments.push(instrument('BBB'));
  raw.bars.push(...raw.bars.map(row => ({ ...row, symbol: 'BBB', open: '1', high: '1', low: '1', close: '1' })));
  raw.metadata.universeMode = 'point_in_time';
  raw.membership = [
    { symbol: 'AAA', availableAt: raw.bars[0]!.openTime, member: true },
    { symbol: 'BBB', availableAt: raw.metadata.sessionIntervals![1]!.segments.at(-1)!.closeTime, member: true },
  ];
  const result = applyFrames(normalizeDataset(raw), config(raw, { outputs: { rank: { op: 'rank', args: [{ field: 'close' }] } } }));
  assert.deepEqual(values(result, 'rank'), [1, 2]);
  assert.deepEqual(values(result, 'rank', 'BBB'), [null, 1]);
});

test('prepared frame becomes visible exactly at close and can fill the adjacent base open', () => {
  const raw = minuteData(['2024-01-02']);
  const result = applyFrames(normalizeDataset(raw), config(raw, { frame: { unit: 'minute', minutes: 2, tailPolicy: 'drop' } }));
  const configuration = parseSpec(spec({ start: raw.bars[0]!.openTime, end: raw.bars.at(-1)!.closeTime + 1,
    strategy: { kind: 'rules', nodes: {}, rules: [{ when: { op: 'gte', args: [{ feature: 'frame:higher:close' }, { value: 11 }] },
      action: { type: 'target_quantity', value: 1 } }] },
  }));
  const run = runBacktest(result, configuration);
  assert.equal(run.orders[0]!.submittedAt, raw.bars[1]!.closeTime);
  assert.equal(run.fills[0]!.at, raw.bars[2]!.openTime);
  assert.equal(run.fills[0]!.price, '12');
});

test('JSONL import performs native frame preparation through the public importer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backtest-frames-'));
  try {
    const raw = minuteData();
    const path = join(dir, 'bars.jsonl');
    await writeFile(path, raw.bars.map(row => JSON.stringify(row)).join('\n'));
    const result = await importDataset({ path, format: 'jsonl', metadata: raw.metadata, frames: config(raw) });
    assert.deepEqual(values(result), [17, 25]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
