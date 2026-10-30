import { createHash } from 'node:crypto';
import { canonicalJSON } from '../spec/canonical.js';
import { assertThat } from '../spec/errors.js';
import { parseFramePreparation, validateDatasetMetadata } from '../spec/validate.js';
import type { BarSeries, Dataset, FeaturePoint, FramePreparation, FrameRecipe, SessionIntervals } from '../spec/types.js';
import { StrategyEvaluator } from '../strategy/evaluator.js';
import { priceFromTicks } from './normalize.js';

interface Window { segments: SessionIntervals['segments']; sessions: string[]; firstDate: string; lastDate: string }
interface Aggregate { openTime: number; closeTime: number; sessionIndex: number; open: number; high: number; low: number; close: number; volume: number; amount: number }
const DAY = 86_400_000;
const MAX_WINDOWS = 1_000_000;
const MAX_FEATURES = 1_000_000;
const emptyState = () => ({ position: 0, holding_sessions: 0, holding_high: 0, cooldown_sessions: 0 });

function periodDates(session: string, unit: 'week' | 'month'): [string, string] {
  const date = new Date(`${session}T00:00:00Z`);
  if (unit === 'week') {
    const start = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY;
    return [new Date(start).toISOString().slice(0, 10), new Date(start + 6 * DAY).toISOString().slice(0, 10)];
  }
  return [session.slice(0, 7) + '-01', new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)];
}

/** Boundaries come from the calendar, never from the last observed source bar. */
function windows(dataset: Dataset, recipe: FrameRecipe, config: FramePreparation): Window[] {
  const intervals = dataset.metadata.sessionIntervals!;
  const result: Window[] = [];
  const add = (window: Window) => {
    assertThat(result.length < MAX_WINDOWS, 'FRAME_RESOURCE_LIMIT', 'Frame calendar exceeds one million candidate windows');
    result.push(window);
  };
  if (recipe.frame.unit === 'minute') {
    const width = recipe.frame.minutes * 60_000;
    for (const item of intervals) for (const segment of item.segments) {
      if (segment.closeTime <= config.from || segment.openTime >= config.asOf) continue;
      for (let at = segment.openTime; at < segment.closeTime; at += width) {
        const closeTime = Math.min(at + width, segment.closeTime);
        if (closeTime - at < width && recipe.frame.tailPolicy === 'drop') continue;
        add({ segments: [{ openTime: at, closeTime }], sessions: [item.session], firstDate: item.session, lastDate: item.session });
      }
    }
  } else if (recipe.frame.unit === 'day') {
    for (const item of intervals) if (item.segments.at(-1)!.closeTime > config.from && item.segments[0]!.openTime < config.asOf)
      add({ segments: item.segments, sessions: [item.session], firstDate: item.session, lastDate: item.session });
  } else {
    for (const item of intervals) {
      const [firstDate, lastDate] = periodDates(item.session, recipe.frame.unit);
      const previous = result.at(-1);
      if (previous?.firstDate === firstDate) { previous.segments.push(...item.segments); previous.sessions.push(item.session); }
      else add({ segments: [...item.segments], sessions: [item.session], firstDate, lastDate });
    }
  }
  return result;
}

function verifySourceGrid(dataset: Dataset, config: FramePreparation): void {
  const schedule = new Map(dataset.metadata.sessionIntervals!.map(item => [item.session, item]));
  for (const [symbol, series] of dataset.series) for (let i = 0; i < series.openTime.length; i++) {
    const open = series.openTime[i]!, close = series.closeTime[i]!;
    if (close <= config.from || open >= config.asOf) continue;
    const session = dataset.metadata.sessions[series.sessionIndex[i]!]!;
    const item = schedule.get(session);
    assertThat(item, 'FRAME_CALENDAR_MISSING', `Source session ${session} lacks explicit boundaries`, symbol);
    const aligned = dataset.metadata.frequency === 'minute'
      ? item.segments.some(segment => open >= segment.openTime && close <= segment.closeTime && (open - segment.openTime) % 60_000 === 0 && close - open === 60_000)
      : open === item.segments[0]!.openTime && close === item.segments.at(-1)!.closeTime;
    assertThat(aligned, 'FRAME_SOURCE_ALIGNMENT', 'Source bar is not aligned to the explicit session grid', `${symbol}/${i}`);
  }
}

function aggregateSeries(source: BarSeries, bucket: Window[], config: FramePreparation, recipe: FrameRecipe,
  dataset: Dataset, counts: { bars: number; skippedMissing: number; excludedIncomplete: number }): BarSeries {
  const rows: Aggregate[] = [];
  const coverage = dataset.metadata.calendarCoverage!;
  const sessionIndices = new Map(dataset.metadata.sessions.map((session, i) => [session, i]));
  let cursor = 0;
  for (const window of bucket) {
    const open = window.segments[0]!.openTime, close = window.segments.at(-1)!.closeTime;
    if (open < config.from || close > config.asOf || window.firstDate < coverage.from || window.lastDate > coverage.through) {
      counts.excludedIncomplete++;
      continue;
    }
    while (cursor < source.openTime.length && source.openTime[cursor]! < open) cursor++;
    const first = cursor;
    while (cursor < source.openTime.length && source.openTime[cursor]! < close) cursor++;
    const expected = dataset.metadata.frequency === 'minute'
      ? window.segments.reduce((count, segment) => count + (segment.closeTime - segment.openTime) / 60_000, 0)
      : window.sessions.length;
    const complete = cursor - first === expected && source.openTime[first] === open && source.closeTime[cursor - 1] === close;
    if (!complete) {
      assertThat(recipe.missingPolicy === 'skip', 'INCOMPLETE_FRAME', 'A completed calendar frame has missing source bars',
        `/frames/${recipe.id}/${source.instrument.symbol}`, { openTime: open, closeTime: close, expectedBars: expected, observedBars: cursor - first });
      counts.skippedMissing++;
      continue;
    }
    let high = -Infinity, low = Infinity, volume = 0, amount = 0;
    for (let i = first; i < cursor; i++) {
      high = Math.max(high, source.highTicks[i]!); low = Math.min(low, source.lowTicks[i]!);
      volume += source.volume[i]!; amount += source.amount[i]!;
    }
    assertThat(Number.isFinite(volume) && (Number.isNaN(amount) || Number.isFinite(amount)), 'FRAME_AGGREGATE_OVERFLOW', 'Aggregated volume or amount overflows numeric analytics');
    rows.push({ openTime: open, closeTime: close, sessionIndex: sessionIndices.get(window.sessions.at(-1)!)!,
      open: source.openTicks[first]!, high, low, close: source.closeTicks[cursor - 1]!, volume, amount });
    counts.bars++;
    assertThat(counts.bars <= MAX_WINDOWS, 'FRAME_RESOURCE_LIMIT', 'Frame preparation exceeds one million aggregated bars');
  }
  const f64 = (key: keyof Aggregate) => Float64Array.from(rows, row => row[key]);
  return { instrument: source.instrument, openTime: f64('openTime'), closeTime: f64('closeTime'), sessionIndex: Uint32Array.from(rows, row => row.sessionIndex),
    openTicks: f64('open'), highTicks: f64('high'), lowTicks: f64('low'), closeTicks: f64('close'), volume: f64('volume'), amount: f64('amount'),
    tradable: Uint8Array.from(rows, row => Number(row.volume > 0)), limitUpTicks: new Float64Array(rows.length).fill(NaN), limitDownTicks: new Float64Array(rows.length).fill(NaN) };
}

/** Same canonical content identity as normalizeDataset, without rebuilding base columns. */
function reidentify(dataset: Dataset): void {
  const hasher = createHash('sha256');
  hasher.update(canonicalJSON(dataset.metadata));
  for (const [symbol, series] of [...dataset.series].sort(([a], [b]) => a.localeCompare(b))) {
    const tick = series.instrument.tickSize;
    for (let i = 0; i < series.openTime.length; i++) hasher.update(canonicalJSON({ symbol, openTime: series.openTime[i], closeTime: series.closeTime[i],
      session: dataset.metadata.sessions[series.sessionIndex[i]!], open: priceFromTicks(series.openTicks[i]!, tick), high: priceFromTicks(series.highTicks[i]!, tick),
      low: priceFromTicks(series.lowTicks[i]!, tick), close: priceFromTicks(series.closeTicks[i]!, tick), volume: series.volume[i],
      amount: Number.isFinite(series.amount[i]) ? String(series.amount[i]) : undefined, tradable: Boolean(series.tradable[i]),
      limitUp: Number.isFinite(series.limitUpTicks[i]) ? priceFromTicks(series.limitUpTicks[i]!, tick) : undefined,
      limitDown: Number.isFinite(series.limitDownTicks[i]) ? priceFromTicks(series.limitDownTicks[i]!, tick) : undefined,
    }));
  }
  hasher.update(canonicalJSON({ features: dataset.features, membership: dataset.membership, actions: dataset.actions }));
  dataset.hash = hasher.digest('hex'); dataset.id = `ds_${dataset.hash.slice(0, 24)}`;
}

/** Aggregate native frames and publish their completed values as immutable as-of features. */
export function applyFrames(dataset: Dataset, configuration: FramePreparation): Dataset {
  const config = parseFramePreparation(configuration);
  assertThat(!dataset.metadata.frameProvenance, 'FRAME_ALREADY_PREPARED', 'Prepare all requested frames from the original base dataset in one operation');
  const metadata = validateDatasetMetadata(dataset.metadata);
  assertThat(metadata.calendarCoverage && metadata.sessionIntervals, 'FRAME_CALENDAR_REQUIRED', 'Native frames require calendarCoverage and sessionIntervals');
  assertThat(config.recipes.every(recipe => recipe.frame.unit !== 'minute' || metadata.frequency === 'minute'),
    'FRAME_UPSAMPLING', 'Minute frames require one-minute source bars');
  verifySourceGrid(dataset, config);
  const generatedFeatures = config.recipes.flatMap(recipe => Object.keys(recipe.outputs).map(name => `frame:${recipe.id}:${name}`));
  const reserved = new Set(generatedFeatures);
  assertThat(dataset.features.every(point => !reserved.has(point.name)), 'FRAME_FEATURE_COLLISION', 'Generated frame feature names cannot overwrite input features');
  const features: FeaturePoint[] = [...dataset.features];
  const counts: NonNullable<Dataset['metadata']['frameProvenance']>['counts'] = [];
  let generated = 0;
  for (const recipe of config.recipes) {
    const count = { id: recipe.id, bars: 0, skippedMissing: 0, excludedIncomplete: 0 };
    const bucket = windows(dataset, recipe, config);
    const series = new Map([...dataset.series].map(([symbol, source]) => [symbol, aggregateSeries(source, bucket, config, recipe, dataset, count)]));
    const nodes = { ...recipe.nodes };
    for (const [name, expression] of Object.entries(recipe.outputs)) nodes[`$frame_output:${name}`] = expression;
    const evaluator = new StrategyEvaluator({ series, metadata, features: dataset.features, membership: dataset.membership },
      { strategy: { kind: 'rules', nodes, rules: [] }, limits: { maxNodes: 4096 } });
    const batches = new Map<number, Map<string, number>>();
    for (const [symbol, bars] of series) for (let i = 0; i < bars.closeTime.length; i++) {
      const at = bars.closeTime[i]!;
      let batch = batches.get(at); if (!batch) batches.set(at, batch = new Map()); batch.set(symbol, i);
    }
    for (const [at, updates] of [...batches].sort(([a], [b]) => a - b)) {
      evaluator.step(updates, at, emptyState);
      for (const symbol of updates.keys()) for (const [name, expression] of Object.entries(recipe.outputs)) {
        assertThat(++generated <= MAX_FEATURES, 'FRAME_RESOURCE_LIMIT', 'Native frames exceed one million generated feature points');
        const value = evaluator.value(expression, symbol);
        features.push(Object.freeze({ symbol, name: `frame:${recipe.id}:${name}`, availableAt: at, value: Number.isFinite(value) ? value : null }));
      }
    }
    counts.push(count);
  }
  features.sort((a, b) => a.availableAt - b.availableAt || a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name));
  metadata.frameProvenance = { version: '1', sourceHash: dataset.hash, configuration: config, generatedFeatures, counts };
  const result: Dataset = { ...dataset, metadata, features, warnings: [...dataset.warnings] };
  for (const count of counts) if (count.skippedMissing) result.warnings.push({ code: 'SKIPPED_INCOMPLETE_FRAMES', message: `Frame ${count.id} skipped ${count.skippedMissing} incomplete symbol windows`, count: count.skippedMissing });
  reidentify(result);
  return result;
}
