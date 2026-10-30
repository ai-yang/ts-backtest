import { Decimal } from '../spec/decimal.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../spec/canonical.js';
import { assertThat, BacktestError } from '../spec/errors.js';
import { validateDatasetMetadata } from '../spec/validate.js';
import type { BarInput, BarSeries, CorporateAction, Dataset, DatasetInput, FeaturePoint, MembershipPoint } from '../spec/types.js';

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(80);
const barSchema = z.strictObject({
  symbol: z.string().min(1), openTime: timestamp, closeTime: timestamp, session: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: decimal, high: decimal, low: decimal, close: decimal,
  volume: z.number().nonnegative().finite(), amount: decimal.optional(), tradable: z.boolean().optional(),
  limitUp: decimal.optional(), limitDown: decimal.optional(),
});
const featureSchema = z.strictObject({ symbol: z.string(), name: z.string().min(1), availableAt: timestamp, value: z.number().finite().nullable() });
const membershipSchema = z.strictObject({ symbol: z.string(), availableAt: timestamp, member: z.boolean() });
const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('split'), symbol: z.string(), at: timestamp, ratio: decimal, cashInLieuPrice: decimal.optional(), sequence: z.number().int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('dividend'), symbol: z.string(), at: timestamp, payAt: timestamp, amountPerShare: decimal, sequence: z.number().int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('delist'), symbol: z.string(), at: timestamp, cashPrice: decimal, sequence: z.number().int().nonnegative().optional() }),
]);

function checked<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BacktestError('INVALID_DATA', parsed.error.issues.map(x => x.message).join('; '), path, { issues: parsed.error.issues });
  return parsed.data;
}

export function ticksFromPrice(price: string, tick: string, path = ''): number {
  const value = new Decimal(price);
  const ticks = value.div(tick);
  assertThat(value.isFinite() && value.gt(0) && ticks.isInteger() && ticks.lte(Number.MAX_SAFE_INTEGER), 'INVALID_PRICE', 'Price must be positive, tick aligned, and within the exact integer range', path);
  return ticks.toNumber();
}

export function priceFromTicks(ticks: number, tick: string): string {
  assertThat(Number.isSafeInteger(ticks) && ticks >= 0, 'INVALID_PRICE', 'Tick count must be an exact nonnegative integer');
  return new Decimal(tick).mul(ticks).toFixed();
}

export function normalizeDataset(input: DatasetInput): Dataset {
  assertThat(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_DATA', 'Dataset must be an object');
  for (const key of Object.keys(input)) assertThat(['metadata', 'bars', 'features', 'membership', 'actions'].includes(key), 'INVALID_DATA', `Unknown dataset field ${key}`);
  const metadata = validateDatasetMetadata(input.metadata);
  metadata.instruments.sort((a, b) => a.symbol.localeCompare(b.symbol));
  assertThat(Array.isArray(input.bars) && input.bars.length > 0, 'EMPTY_DATASET', 'At least one bar is required', '/bars');
  const instruments = new Map(metadata.instruments.map(i => [i.symbol, i]));
  const sessions = new Map(metadata.sessions.map((s, i) => [s, i]));
  const grouped = new Map<string, BarInput[]>();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: metadata.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (t: number) => {
    const parts = formatter.formatToParts(t);
    return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-');
  };
  for (let i = 0; i < input.bars.length; i++) {
    const b = checked(barSchema, input.bars[i], `/bars/${i}`);
    assertThat(instruments.has(b.symbol), 'UNKNOWN_INSTRUMENT', `Missing metadata for ${b.symbol}`, `/bars/${i}/symbol`);
    assertThat(sessions.has(b.session), 'UNKNOWN_SESSION', `Session ${b.session} absent from calendar`, `/bars/${i}/session`);
    assertThat(b.openTime < b.closeTime, 'INVALID_BAR_TIME', 'Bar open must precede close', `/bars/${i}`);
    assertThat(localDate(b.openTime) === b.session && localDate(b.closeTime) === b.session, 'SESSION_MISMATCH', 'Bar timestamps do not fall in the declared local session', `/bars/${i}`);
    assertThat(metadata.frequency !== 'minute' || b.closeTime - b.openTime === 60_000, 'FREQUENCY_MISMATCH', 'Minute bars must span exactly one minute', `/bars/${i}`);
    const list = grouped.get(b.symbol) ?? [];
    const last = list.at(-1);
    assertThat(!last || last.closeTime <= b.openTime, 'UNSORTED_OR_OVERLAPPING_BARS', 'Bars for each symbol must be increasing and non-overlapping', `/bars/${i}`);
    assertThat(metadata.frequency !== 'day' || !last || last.session !== b.session, 'DUPLICATE_SESSION', 'Daily data allows one bar per instrument per session', `/bars/${i}`);
    list.push(b); grouped.set(b.symbol, list);
  }
  const series = new Map<string, BarSeries>();
  const hasher = createHash('sha256');
  hasher.update(canonicalJSON(metadata));
  for (const [symbol, instrument] of [...instruments].sort(([a], [b]) => a.localeCompare(b))) {
    const bars = grouped.get(symbol);
    assertThat(bars?.length, 'EMPTY_INSTRUMENT', `No bars for ${symbol}`);
    const n = bars.length;
    const s: BarSeries = { instrument, openTime: new Float64Array(n), closeTime: new Float64Array(n), sessionIndex: new Uint32Array(n), openTicks: new Float64Array(n), highTicks: new Float64Array(n), lowTicks: new Float64Array(n), closeTicks: new Float64Array(n), volume: new Float64Array(n), amount: new Float64Array(n), tradable: new Uint8Array(n), limitUpTicks: new Float64Array(n).fill(NaN), limitDownTicks: new Float64Array(n).fill(NaN) };
    for (let i = 0; i < n; i++) {
      const b = bars[i]!;
      s.openTime[i] = b.openTime; s.closeTime[i] = b.closeTime; s.sessionIndex[i] = sessions.get(b.session)!;
      s.openTicks[i] = ticksFromPrice(b.open, instrument.tickSize, `${symbol}/${i}/open`);
      s.highTicks[i] = ticksFromPrice(b.high, instrument.tickSize, `${symbol}/${i}/high`);
      s.lowTicks[i] = ticksFromPrice(b.low, instrument.tickSize, `${symbol}/${i}/low`);
      s.closeTicks[i] = ticksFromPrice(b.close, instrument.tickSize, `${symbol}/${i}/close`);
      assertThat(s.lowTicks[i]! <= Math.min(s.openTicks[i]!, s.closeTicks[i]!) && s.highTicks[i]! >= Math.max(s.openTicks[i]!, s.closeTicks[i]!) && s.lowTicks[i]! <= s.highTicks[i]!, 'INVALID_OHLC', 'OHLC range is inconsistent', `${symbol}/${i}`);
      s.volume[i] = b.volume; s.amount[i] = b.amount === undefined ? NaN : Number(b.amount);
      assertThat(b.amount === undefined || (Number.isFinite(s.amount[i]) && s.amount[i]! >= 0), 'INVALID_AMOUNT', 'Amount must be nonnegative and finite', `${symbol}/${i}/amount`);
      s.tradable[i] = b.tradable === false || b.volume === 0 ? 0 : 1;
      if (b.limitUp !== undefined) s.limitUpTicks[i] = ticksFromPrice(b.limitUp, instrument.tickSize);
      if (b.limitDown !== undefined) s.limitDownTicks[i] = ticksFromPrice(b.limitDown, instrument.tickSize);
      assertThat(!instrument.requirePriceLimits || (b.limitUp !== undefined && b.limitDown !== undefined), 'MISSING_PRICE_LIMITS', 'Instrument requires explicit daily price bands', `${symbol}/${i}`);
      if (b.limitUp !== undefined && b.limitDown !== undefined) assertThat(s.limitDownTicks[i]! <= s.limitUpTicks[i]!, 'INVALID_PRICE_LIMITS', 'Lower price band exceeds upper band');
      assertThat((b.limitUp === undefined || s.highTicks[i]! <= s.limitUpTicks[i]!) && (b.limitDown === undefined || s.lowTicks[i]! >= s.limitDownTicks[i]!), 'INVALID_PRICE_LIMITS', 'Observed OHLC exceeds the supplied price bands', `${symbol}/${i}`);
      hasher.update(canonicalJSON({ symbol, openTime: b.openTime, closeTime: b.closeTime, session: b.session,
        open: priceFromTicks(s.openTicks[i]!, instrument.tickSize), high: priceFromTicks(s.highTicks[i]!, instrument.tickSize),
        low: priceFromTicks(s.lowTicks[i]!, instrument.tickSize), close: priceFromTicks(s.closeTicks[i]!, instrument.tickSize),
        volume: b.volume, amount: Number.isFinite(s.amount[i]) ? String(s.amount[i]) : undefined, tradable: Boolean(s.tradable[i]),
        limitUp: Number.isFinite(s.limitUpTicks[i]) ? priceFromTicks(s.limitUpTicks[i]!, instrument.tickSize) : undefined,
        limitDown: Number.isFinite(s.limitDownTicks[i]) ? priceFromTicks(s.limitDownTicks[i]!, instrument.tickSize) : undefined,
      }));
    }
    series.set(symbol, s);
  }
  for (const name of ['features', 'membership', 'actions'] as const) assertThat(input[name] === undefined || Array.isArray(input[name]), 'INVALID_DATA', `${name} must be an array`, `/${name}`);
  const features = (input.features ?? []).map((v, i) => checked(featureSchema, v, `/features/${i}`)) as FeaturePoint[];
  const membership = (input.membership ?? []).map((v, i) => checked(membershipSchema, v, `/membership/${i}`)) as MembershipPoint[];
  const actions = (input.actions ?? []).map((v, i) => checked(actionSchema, v, `/actions/${i}`)) as CorporateAction[];
  const keys = new Set<string>();
  for (const [kind, records] of [['feature', features], ['membership', membership], ['action', actions]] as const) {
    for (const record of records) {
      assertThat(instruments.has(record.symbol), 'UNKNOWN_INSTRUMENT', `Unknown ${kind} symbol ${record.symbol}`);
      const at = 'at' in record ? record.at : record.availableAt;
      const key = `${kind}/${record.symbol}/${'name' in record ? record.name : 'type' in record ? record.type : ''}/${at}`;
      assertThat(!keys.has(key), 'DUPLICATE_EVENT', `Duplicate ${kind} event`, key); keys.add(key);
    }
  }
  for (const action of actions) {
    if (action.type === 'split') assertThat(new Decimal(action.ratio).gt(0) && (action.cashInLieuPrice === undefined || new Decimal(action.cashInLieuPrice).gte(0)), 'INVALID_SPLIT', 'Split ratio must be positive and fractional settlement nonnegative');
    if (action.type === 'dividend') assertThat(action.payAt >= action.at && new Decimal(action.amountPerShare).gte(0), 'INVALID_DIVIDEND', 'Dividend requires nonnegative amount and payment not before entitlement');
    if (action.type === 'delist') assertThat(new Decimal(action.cashPrice).gte(0), 'INVALID_DELIST', 'Delisting settlement cannot be negative');
  }
  features.sort((a, b) => a.availableAt - b.availableAt || a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name));
  membership.sort((a, b) => a.availableAt - b.availableAt || a.symbol.localeCompare(b.symbol));
  actions.sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.type.localeCompare(b.type));
  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1]!, b = actions[i]!;
    if (a.at === b.at && a.symbol === b.symbol) assertThat(a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence,
      'AMBIGUOUS_ACTION_SEQUENCE', 'Simultaneous corporate actions for one symbol require distinct explicit sequence numbers');
  }
  hasher.update(canonicalJSON({ features, membership, actions }));
  const hash = hasher.digest('hex');
  return { id: `ds_${hash.slice(0, 24)}`, hash, metadata, series, features, membership, actions, rowCount: input.bars.length,
    warnings: [
      ...(metadata.universeMode === 'static' ? [{ code: 'STATIC_UNIVERSE', message: 'Static universe may contain survivorship bias' }] : []),
      ...(metadata.corporateActionsCoverage !== 'complete' ? [{ code: 'INCOMPLETE_CORPORATE_ACTIONS', message: 'Corporate action coverage is not complete' }] : []),
      ...(metadata.frameProvenance?.counts.filter(count => count.skippedMissing > 0).map(count => ({
        code: 'SKIPPED_INCOMPLETE_FRAMES', message: `Frame ${count.id} skipped ${count.skippedMissing} incomplete symbol windows`, count: count.skippedMissing,
      })) ?? []),
    ],
  };
}
