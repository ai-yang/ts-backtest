import { createHash } from 'node:crypto';
import { Decimal } from '../spec/decimal.js';
import { canonicalJSON } from '../spec/canonical.js';
import { assertThat, BacktestError } from '../spec/errors.js';
import { validateDatasetMetadata } from '../spec/validate.js';
import { normalizeDataset, priceFromTicks } from './normalize.js';
import type { BarInput, Dataset, DatasetInput } from '../spec/types.js';

type DType = 'f64le' | 'u32le' | 'u8';
interface ArrayBlock { dtype: DType; length: number; base64: string }
const columnTypes = {
  openTime: 'f64le', closeTime: 'f64le', sessionIndex: 'u32le',
  openTicks: 'f64le', highTicks: 'f64le', lowTicks: 'f64le', closeTicks: 'f64le',
  volume: 'f64le', amount: 'f64le', tradable: 'u8', limitUpTicks: 'f64le', limitDownTicks: 'f64le',
} as const;
type ColumnName = keyof typeof columnTypes;
interface SerializedSeries { symbol: string; columns: Record<ColumnName, ArrayBlock> }
interface Payload {
  id: string; hash: string; rowCount: number;
  metadata: Dataset['metadata']; features: Dataset['features']; membership: Dataset['membership']; actions: Dataset['actions'];
  series: SerializedSeries[];
}
export interface DecodeDatasetOptions { maxBytes?: number; maxRows?: number }

function checksum(value: unknown): string { return createHash('sha256').update(canonicalJSON(value)).digest('hex'); }

function encodeArray(array: Float64Array | Uint32Array | Uint8Array, dtype: DType): ArrayBlock {
  const width = dtype === 'f64le' ? 8 : dtype === 'u32le' ? 4 : 1;
  const bytes = Buffer.allocUnsafe(array.length * width);
  for (let i = 0; i < array.length; i++) {
    if (dtype === 'f64le') bytes.writeDoubleLE(array[i]!, i * width);
    else if (dtype === 'u32le') bytes.writeUInt32LE(array[i]!, i * width);
    else bytes[i] = array[i]!;
  }
  return { dtype, length: array.length, base64: bytes.toString('base64') };
}

/** Portable cache encoding: explicit little-endian arrays plus a payload checksum. */
export function encodeDataset(dataset: Dataset): string {
  const payload: Payload = {
    id: dataset.id, hash: dataset.hash, rowCount: dataset.rowCount,
    metadata: dataset.metadata, features: dataset.features, membership: dataset.membership, actions: dataset.actions,
    series: [...dataset.series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, series]) => ({
      symbol, columns: Object.fromEntries(Object.entries(columnTypes).map(([key, dtype]) => [key, encodeArray(series[key as ColumnName], dtype)])) as Record<ColumnName, ArrayBlock>,
    })),
  };
  return canonicalJSON({ format: 'ts-backtest-dataset', version: 1, checksum: checksum(payload), payload });
}

function record(value: unknown, path: string): Record<string, unknown> {
  assertThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_DATASET_CACHE', 'Expected an object', path);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  assertThat(Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k)), 'INVALID_DATASET_CACHE', 'Unexpected or missing cache fields', path);
}

function checkStructure(value: unknown, depth = 0, budget = { count: 0 }): void {
  assertThat(depth <= 64 && ++budget.count <= 5_000_000, 'INVALID_DATASET_CACHE', 'Cache structure exceeds depth/value limits');
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) checkStructure(child, depth + 1, budget);
  }
}

function decodeArray(value: unknown, expected: DType, maxRows: number, path: string): Float64Array | Uint32Array | Uint8Array {
  const block = record(value, path);
  exactKeys(block, ['dtype', 'length', 'base64'], path);
  assertThat(block.dtype === expected, 'INVALID_DATASET_CACHE', 'Array dtype does not match column contract', path);
  assertThat(Number.isSafeInteger(block.length) && (block.length as number) > 0 && (block.length as number) <= maxRows, 'INVALID_DATASET_CACHE', 'Invalid array length', path);
  const length = block.length as number;
  const width = expected === 'f64le' ? 8 : expected === 'u32le' ? 4 : 1;
  // Repeated-group validation regexes can overflow V8's stack on ordinary
  // multi-megabyte arrays. The exact decode/re-encode check below is canonical.
  assertThat(typeof block.base64 === 'string' && block.base64.length === Math.ceil(length * width / 3) * 4, 'INVALID_DATASET_CACHE', 'Invalid base64 array payload', path);
  const bytes = Buffer.from(block.base64 as string, 'base64');
  assertThat(bytes.length === length * width && bytes.toString('base64') === block.base64, 'INVALID_DATASET_CACHE', 'Array payload length or canonical encoding mismatch', path);
  const result = expected === 'f64le' ? new Float64Array(length) : expected === 'u32le' ? new Uint32Array(length) : new Uint8Array(length);
  for (let i = 0; i < length; i++) result[i] = expected === 'f64le' ? bytes.readDoubleLE(i * width) : expected === 'u32le' ? bytes.readUInt32LE(i * width) : bytes[i]!;
  return result;
}

/** Verify envelope integrity and recompute the normalized content hash before use. */
export function decodeDataset(encoded: string | Uint8Array, options: DecodeDatasetOptions = {}): Dataset {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const maxRows = options.maxRows ?? 2_000_000;
  assertThat(Number.isSafeInteger(maxBytes) && maxBytes > 0 && Number.isSafeInteger(maxRows) && maxRows > 0, 'INVALID_IMPORT_LIMIT', 'Cache limits must be positive safe integers');
  assertThat((typeof encoded === 'string' ? Buffer.byteLength(encoded) : encoded.byteLength) <= maxBytes, 'DATA_TOO_LARGE', 'Serialized dataset exceeds maxBytes');
  let decoded: unknown;
  try { decoded = JSON.parse(typeof encoded === 'string' ? encoded : new TextDecoder('utf-8', { fatal: true }).decode(encoded)); }
  catch { throw new BacktestError('INVALID_DATASET_CACHE', 'Serialized dataset must be UTF-8 JSON'); }
  checkStructure(decoded);
  const envelope = record(decoded, '/');
  exactKeys(envelope, ['format', 'version', 'checksum', 'payload'], '/');
  // Caches created before the project rename remain readable.
  assertThat((envelope.format === 'ts-backtest-dataset' || envelope.format === 'zwork-backtest-dataset') && envelope.version === 1, 'UNSUPPORTED_DATASET_VERSION', 'Unsupported serialized dataset format/version');
  assertThat(typeof envelope.checksum === 'string' && /^[a-f0-9]{64}$/.test(envelope.checksum) && checksum(envelope.payload) === envelope.checksum, 'DATASET_INTEGRITY_ERROR', 'Serialized dataset payload checksum mismatch');
  const payload = record(envelope.payload, '/payload');
  exactKeys(payload, ['id', 'hash', 'rowCount', 'metadata', 'features', 'membership', 'actions', 'series'], '/payload');
  assertThat(typeof payload.hash === 'string' && /^[a-f0-9]{64}$/.test(payload.hash) && payload.id === `ds_${payload.hash.slice(0, 24)}`, 'DATASET_INTEGRITY_ERROR', 'Dataset ID and hash disagree');
  assertThat(Number.isSafeInteger(payload.rowCount) && (payload.rowCount as number) > 0 && (payload.rowCount as number) <= maxRows, 'INVALID_DATASET_CACHE', 'Invalid dataset row count');
  const metadata = validateDatasetMetadata(payload.metadata);
  assertThat(Array.isArray(payload.series) && payload.series.length === metadata.instruments.length, 'INVALID_DATASET_CACHE', 'Series count must match instrument count');
  const instruments = new Map(metadata.instruments.map(i => [i.symbol, i]));
  const seen = new Set<string>();
  const bars: BarInput[] = [];
  const decodedColumns = new Map<string, Record<ColumnName, Float64Array | Uint32Array | Uint8Array>>();
  for (const raw of payload.series as unknown[]) {
    const entry = record(raw, '/payload/series');
    exactKeys(entry, ['symbol', 'columns'], '/payload/series');
    assertThat(typeof entry.symbol === 'string' && instruments.has(entry.symbol) && !seen.has(entry.symbol), 'INVALID_DATASET_CACHE', 'Unknown or duplicate series symbol');
    const symbol = entry.symbol as string, instrument = instruments.get(symbol)!;
    seen.add(symbol);
    const columns = record(entry.columns, `/payload/series/${symbol}/columns`);
    exactKeys(columns, Object.keys(columnTypes), `/payload/series/${symbol}/columns`);
    const arrays = Object.fromEntries(Object.entries(columnTypes).map(([key, dtype]) => [key, decodeArray(columns[key], dtype, maxRows, `/payload/series/${symbol}/${key}`)])) as Record<ColumnName, Float64Array | Uint32Array | Uint8Array>;
    const length = arrays.openTime.length;
    assertThat(Object.values(arrays).every(a => a.length === length) && bars.length + length <= (payload.rowCount as number), 'INVALID_DATASET_CACHE', 'Series column lengths or total row count disagree');
    decodedColumns.set(symbol, arrays);
    for (let i = 0; i < length; i++) {
      const session = metadata.sessions[arrays.sessionIndex[i]!];
      assertThat(session !== undefined && (arrays.tradable[i] === 0 || arrays.tradable[i] === 1), 'INVALID_DATASET_CACHE', 'Invalid session index or tradable flag');
      const bar: BarInput = { symbol, openTime: arrays.openTime[i]!, closeTime: arrays.closeTime[i]!, session: session!, open: priceFromTicks(arrays.openTicks[i]!, instrument.tickSize), high: priceFromTicks(arrays.highTicks[i]!, instrument.tickSize), low: priceFromTicks(arrays.lowTicks[i]!, instrument.tickSize), close: priceFromTicks(arrays.closeTicks[i]!, instrument.tickSize), volume: arrays.volume[i]!, tradable: arrays.tradable[i] === 1 };
      for (const [key, value] of [['amount', arrays.amount[i]!], ['limitUp', arrays.limitUpTicks[i]!], ['limitDown', arrays.limitDownTicks[i]!]] as const) {
        assertThat(Number.isNaN(value) || (Number.isFinite(value) && value >= 0), 'INVALID_DATASET_CACHE', 'Optional numeric columns must be nonnegative finite values or NaN');
        if (!Number.isNaN(value)) bar[key] = key === 'amount' ? new Decimal(value).toFixed() : priceFromTicks(value, instrument.tickSize);
      }
      bars.push(bar);
    }
  }
  assertThat(bars.length === payload.rowCount, 'INVALID_DATASET_CACHE', 'Dataset row count mismatch');
  const dataset = normalizeDataset({ metadata, bars, features: payload.features, membership: payload.membership, actions: payload.actions } as DatasetInput);
  assertThat(dataset.hash === payload.hash && dataset.id === payload.id, 'DATASET_INTEGRITY_ERROR', 'Normalized dataset content does not match its declared identity');
  for (const [symbol, columns] of decodedColumns) {
    const normalized = dataset.series.get(symbol)!;
    for (const key of Object.keys(columnTypes) as ColumnName[]) assertThat(columns[key].every((v, i) => Object.is(v, normalized[key][i])), 'DATASET_INTEGRITY_ERROR', 'Serialized columns disagree with normalized data', `${symbol}/${key}`);
  }
  return dataset;
}
