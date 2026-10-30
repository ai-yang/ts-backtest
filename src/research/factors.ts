import { z } from 'zod';
import { EventClock } from '../engine/clock.js';
import { ENGINE_VERSION } from '../engine/run.js';
import { contentHash } from '../spec/canonical.js';
import { assertThat } from '../spec/errors.js';
import type { Dataset, FeaturePoint } from '../spec/types.js';
import type { ResearchHooks } from './sweep.js';

export interface FactorRequest {
  feature: string; from: number; to: number; horizonBars: number; groups?: number;
  minSamples?: number; maxFeatureAgeMs?: number; maxRows?: number; maxPeriods?: number; maxRuntimeMs?: number;
}
export interface FactorPeriod {
  at: number; count: number; ic: number | null; rankIC: number | null;
  groups: Array<{ group: number; count: number; meanReturn: number | null }>;
  topMinusBottom: number | null;
}
export interface FactorResult {
  schemaVersion: '1'; kind: 'factors'; engineVersion: string; datasetHash: string; fingerprint: string;
  feature: string; horizonBars: number; from: number; to: number;
  periods: FactorPeriod[]; observations: number;
  summary: { meanIC: number | null; meanRankIC: number | null; icIR: number | null; validICPeriods: number; validRankICPeriods: number; meanTopMinusBottom: number | null };
  excluded: Record<'missingFeature' | 'staleFeature' | 'notMember' | 'labelOutsideRange' | 'corporateAction', number>;
  limitations: string[];
}
export const factorRequestSchema = z.strictObject({
  feature: z.string().min(1).max(128), from: z.number().int().min(0).max(8_640_000_000_000_000), to: z.number().int().min(0).max(8_640_000_000_000_000),
  horizonBars: z.number().int().min(1).max(1_000_000), groups: z.number().int().min(2).max(20).default(5), minSamples: z.number().int().min(2).max(100_000).default(3),
  maxFeatureAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxRows: z.number().int().min(1).max(10_000_000).default(100_000), maxPeriods: z.number().int().min(1).max(100_000).default(10_000), maxRuntimeMs: z.number().int().min(1).max(3_600_000).default(120_000),
});
export function parseFactorRequest(request: unknown): z.infer<typeof factorRequestSchema> {
  const parsed = factorRequestSchema.safeParse(request);
  assertThat(parsed.success, 'INVALID_FACTOR_REQUEST', 'Invalid factor evaluation request', '', { issues: parsed.error?.issues.slice(0, 10) });
  assertThat(parsed.data.from < parsed.data.to, 'INVALID_FACTOR_RANGE', 'Factor evaluation uses a nonempty [from,to) range');
  return parsed.data;
}
function correlation(x: number[], y: number[]): number | null {
  if (x.length < 2 || x.length !== y.length) return null;
  let xs = 0, ys = 0;
  for (const value of x) xs = Math.max(xs, Math.abs(value));
  for (const value of y) ys = Math.max(ys, Math.abs(value));
  if (xs === 0 || ys === 0) return null;
  const a = x.map(value => value / xs), b = y.map(value => value / ys);
  const am = a.reduce((sum, value) => sum + value, 0) / a.length, bm = b.reduce((sum, value) => sum + value, 0) / b.length;
  let covariance = 0, av = 0, bv = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i]! - am, db = b[i]! - bm; covariance += da * db; av += da * da; bv += db * db; }
  return av > 0 && bv > 0 ? Math.max(-1, Math.min(1, covariance / Math.sqrt(av * bv))) : null;
}
function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index), result = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let end = i + 1; while (end < order.length && order[end]!.value === order[i]!.value) end++;
    for (let j = i; j < end; j++) result[order[j]!.index] = (i + 1 + end) / 2;
    i = end;
  }
  return result;
}
function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function lowerBound(values: ArrayLike<number>, value: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle]! < value) low = middle + 1; else high = middle; }
  return low;
}

/** Future closes are evaluation labels only, never injected into strategy features. */
export function factorDiagnostics(dataset: Dataset, input: FactorRequest, hooks: ResearchHooks = {}): FactorResult {
  const started = performance.now(), request = parseFactorRequest(input), clock = new EventClock();
  const features = new Map<string, { points: FeaturePoint[]; next: number; current?: FeaturePoint }>();
  for (const point of dataset.features) if (point.name === request.feature) {
    let cursor = features.get(point.symbol); if (!cursor) features.set(point.symbol, cursor = { points: [], next: 0 }); cursor.points.push(point);
  }
  assertThat(features.size > 0, 'MISSING_FEATURE', `No feature data supplied for ${request.feature}`);
  const membership = new Map<string, boolean>(); let membershipIndex = 0;
  const actionTimes = new Map<string, number[]>();
  for (const action of dataset.actions) { let values = actionTimes.get(action.symbol); if (!values) actionTimes.set(action.symbol, values = []); values.push(action.at); }
  for (const [symbol, series] of dataset.series) {
    const index = lowerBound(series.closeTime, request.from);
    if (index < series.closeTime.length && series.closeTime[index]! < request.to) clock.push({ at: series.closeTime[index]!, kind: 'close', symbol, index });
  }
  const periods: FactorPeriod[] = [], excluded = { missingFeature: 0, staleFeature: 0, notMember: 0, labelOutsideRange: 0, corporateAction: 0 };
  let observations = 0, processed = 0;
  while (clock.size) {
    const at = clock.peek()!.at, batch = [];
    while (clock.size && clock.peek()!.at === at) batch.push(clock.pop());
    assertThat(!hooks.canceled?.(), 'CANCELED', 'Factor evaluation canceled');
    assertThat(performance.now() - started <= request.maxRuntimeMs, 'RESEARCH_TIMEOUT', 'Factor evaluation exceeded maxRuntimeMs');
    while (membershipIndex < dataset.membership.length && dataset.membership[membershipIndex]!.availableAt <= at) { const point = dataset.membership[membershipIndex++]!; membership.set(point.symbol, point.member); }
    const values: number[] = [], returns: number[] = [];
    for (const event of batch) {
      const symbol = event.symbol!, series = dataset.series.get(symbol)!, index = event.index;
      assertThat(++processed <= request.maxRows, 'FACTOR_ROW_LIMIT', 'Factor observations exceed maxRows');
      if (index + 1 < series.closeTime.length && series.closeTime[index + 1]! < request.to) clock.push({ ...event, at: series.closeTime[index + 1]!, index: index + 1 });
      if (dataset.metadata.universeMode === 'point_in_time' && membership.get(symbol) !== true) { excluded.notMember++; continue; }
      const cursor = features.get(symbol);
      if (cursor) while (cursor.next < cursor.points.length && cursor.points[cursor.next]!.availableAt <= at) cursor.current = cursor.points[cursor.next++];
      const feature = cursor?.current;
      if (!feature || feature.value === null || !Number.isFinite(feature.value)) { excluded.missingFeature++; continue; }
      if (request.maxFeatureAgeMs !== undefined && at - feature.availableAt > request.maxFeatureAgeMs) { excluded.staleFeature++; continue; }
      const labelIndex = index + request.horizonBars, labelAt = series.closeTime[labelIndex];
      if (labelAt === undefined || labelAt >= request.to) { excluded.labelOutsideRange++; continue; }
      const actions = actionTimes.get(symbol) ?? [], nextAction = actions[lowerBound(actions, at + 1)];
      if (nextAction !== undefined && nextAction <= labelAt) { excluded.corporateAction++; continue; }
      values.push(feature.value); returns.push(series.closeTicks[labelIndex]! / series.closeTicks[index]! - 1); observations++;
    }
    const featureRanks = ranks(values), labelRanks = ranks(returns);
    const buckets = Array.from({ length: request.groups }, (_, index) => ({ group: index + 1, count: 0, total: 0 }));
    for (let i = 0; i < values.length; i++) {
      const bucket = buckets[Math.min(request.groups - 1, Math.floor((featureRanks[i]! - 1) * request.groups / values.length))]!;
      bucket.count++; bucket.total += returns[i]!;
    }
    const groups = buckets.map(bucket => ({ group: bucket.group, count: bucket.count, meanReturn: bucket.count ? bucket.total / bucket.count : null }));
    const bottom = groups[0]!.meanReturn, top = groups.at(-1)!.meanReturn;
    assertThat(periods.length < request.maxPeriods, 'FACTOR_PERIOD_LIMIT', 'Factor output periods exceed maxPeriods');
    periods.push({ at, count: values.length, ic: values.length >= request.minSamples ? correlation(values, returns) : null, rankIC: values.length >= request.minSamples ? correlation(featureRanks, labelRanks) : null, groups, topMinusBottom: bottom !== null && top !== null ? top - bottom : null });
    hooks.progress?.(processed, dataset.rowCount);
  }
  const ic = periods.flatMap(period => period.ic === null ? [] : [period.ic]), rankIC = periods.flatMap(period => period.rankIC === null ? [] : [period.rankIC]);
  const meanIC = mean(ic), variance = meanIC !== null && ic.length >= 2 ? ic.reduce((sum, value) => sum + (value - meanIC) ** 2, 0) / ic.length : null;
  return { schemaVersion: '1', kind: 'factors', engineVersion: ENGINE_VERSION, datasetHash: dataset.hash, fingerprint: contentHash({ engineVersion: ENGINE_VERSION, datasetHash: dataset.hash, request }), feature: request.feature, horizonBars: request.horizonBars, from: request.from, to: request.to, periods, observations,
    summary: { meanIC, meanRankIC: mean(rankIC), icIR: variance !== null && variance > 0 ? meanIC! / Math.sqrt(variance) : null, validICPeriods: ic.length, validRankICPeriods: rankIC.length, meanTopMinusBottom: mean(periods.flatMap(period => period.topMinusBottom === null ? [] : [period.topMinusBottom])) }, excluded,
    limitations: [
      'Features use the last value whose availableAt is no later than the observation close; null explicitly revokes availability. Labels use future observed close prices only within [from,to).',
      'Labels are horizonBars observed bars per instrument, not a fixed calendar horizon. Missing future observations are excluded; no delisting or missing-price return is imputed.',
      'Any supplied split, dividend or delisting inside a label interval excludes that label. Incomplete corporate-action coverage can still distort raw-price labels.',
      'Groups use average ranks for feature ties, keeping tied values in one bucket; empty groups are possible. Returns are equal-weight cross-sectional means, before execution costs.',
      'ICIR is mean IC divided by population standard deviation across valid periods; it is not annualized or adjusted for overlapping labels. Group means are diagnostic observations, not a tradable compounded portfolio curve.',
      ...(dataset.metadata.universeMode === 'static' ? ['The static universe may contain survivorship bias.'] : []),
    ] };
}
