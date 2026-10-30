import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { normalizeDataset } from './normalize.js';
import { applyFrames } from './frames.js';
import { canonicalJSON } from '../spec/canonical.js';
import { assertThat, BacktestError } from '../spec/errors.js';
import type { BarInput, Dataset, DatasetInput, DatasetMetadata, FramePreparation } from '../spec/types.js';

export type DatasetFormat = 'csv' | 'jsonl' | 'json' | 'parquet' | 'arrow' | 'xlsx';
/** Deployment configuration only: never accept this module path from a strategy/data request. */
export function setFormatAdapter(path: string): void {
  assertThat(typeof path === 'string' && isAbsolute(path) && !path.includes('\0'), 'INVALID_ADAPTER_PATH', 'Optional format adapter must be a trusted absolute local module path');
  process.env.BACKTEST_FORMAT_ADAPTER = path;
}

export type ColumnMapping = Partial<Record<keyof BarInput, string>>;
export interface ImportDatasetOptions {
  path: string;
  format: DatasetFormat;
  metadata?: DatasetMetadata;
  /** Canonical field name -> source column name. Unmapped fields keep their names. */
  columns?: ColumnMapping;
  maxRows?: number;
  maxFileBytes?: number;
  maxRecordBytes?: number;
  features?: DatasetInput['features'];
  membership?: DatasetInput['membership'];
  actions?: DatasetInput['actions'];
  frames?: FramePreparation;
  formatOptions?: { sheet?: string };
}

const DEFAULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ROWS = 2_000_000;
const DEFAULT_RECORD_BYTES = 1024 * 1024;
const requiredColumns = ['symbol', 'openTime', 'closeTime', 'session', 'open', 'high', 'low', 'close', 'volume'] as const;
const allColumns = [...requiredColumns, 'amount', 'tradable', 'limitUp', 'limitDown'] as const;
const decimalPattern = /^-?\d+(?:\.\d+)?$/;

function boundedInteger(value: number, name: string): number {
  assertThat(Number.isSafeInteger(value) && value > 0, 'INVALID_IMPORT_LIMIT', `${name} must be a positive safe integer`, `/${name}`);
  return value;
}

/** Accept exact epoch milliseconds or a full ISO timestamp with an explicit zone. */
export function parseTimestamp(value: unknown, path: string): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const n = Number(value);
    assertThat(Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000, 'INVALID_TIMESTAMP', 'Timestamp must be exact nonnegative epoch milliseconds', path);
    return n;
  }
  assertThat(typeof value === 'string', 'INVALID_TIMESTAMP', 'Timestamp must be epoch milliseconds or an ISO string with an explicit zone', path);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value as string);
  assertThat(match, 'INVALID_TIMESTAMP', 'Use a full ISO timestamp with Z or an explicit UTC offset; date-only/local timestamps are not inferred', path);
  const [, year, month, day, hour, minute, second] = match!;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  assertThat(m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]! && Number(hour) < 24 && Number(minute) < 60 && Number(second ?? 0) < 60, 'INVALID_TIMESTAMP', 'Invalid calendar timestamp', path);
  const n = Date.parse(value as string);
  assertThat(Number.isSafeInteger(n) && n >= 0, 'INVALID_TIMESTAMP', 'Invalid ISO timestamp or UTC offset', path);
  return n;
}

async function* fileChunks(path: string, maxBytes: number): AsyncGenerator<Buffer> {
  assertThat(typeof path === 'string' && path.length > 0 && !/^[a-z][a-z\d+.-]*:\/\//i.test(path), 'INVALID_DATA_PATH', 'A local file path is required', '/path');
  const info = await stat(path);
  assertThat(info.isFile(), 'INVALID_DATA_PATH', 'Input must be a regular file', '/path');
  assertThat(info.size <= maxBytes, 'DATA_TOO_LARGE', 'Input file exceeds maxFileBytes', '/path', { size: info.size, maxFileBytes: maxBytes });
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      assertThat(bytes <= maxBytes, 'DATA_TOO_LARGE', 'Input grew beyond maxFileBytes while reading', '/path', { maxFileBytes: maxBytes });
      yield buffer;
    }
  } finally { stream.destroy(); }
}

export async function readBoundedText(path: string, maxBytes = DEFAULT_BYTES): Promise<string> {
  boundedInteger(maxBytes, 'maxFileBytes');
  const chunks: Buffer[] = [];
  try { for await (const chunk of fileChunks(path, maxBytes)) chunks.push(chunk); }
  catch (error) {
    if (error instanceof BacktestError) throw error;
    throw new BacktestError('FILE_READ_FAILED', error instanceof Error ? error.message : String(error), '/path');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, ''); }
  catch { throw new BacktestError('INVALID_ENCODING', 'Input must be valid UTF-8', '/path'); }
}

async function* utf8Chunks(path: string, maxBytes: number): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of fileChunks(path, maxBytes)) {
    let text: string;
    try { text = decoder.decode(chunk, { stream: true }); }
    catch { throw new BacktestError('INVALID_ENCODING', 'Input must be valid UTF-8', '/path'); }
    yield text;
  }
  try { const final = decoder.decode(); if (final) yield final; }
  catch { throw new BacktestError('INVALID_ENCODING', 'Input must be valid UTF-8', '/path'); }
}

function object(value: unknown, path: string): Record<string, unknown> {
  assertThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_DATA', 'Expected an object', path);
  return value as Record<string, unknown>;
}

function parseRow(raw: unknown, columns: ColumnMapping, index: number): BarInput {
  const row = object(raw, `/bars/${index}`);
  const get = (key: keyof BarInput) => row[columns[key] ?? key];
  const path = (key: keyof BarInput) => `/bars/${index}/${key}`;
  for (const key of requiredColumns) assertThat(get(key) !== undefined && get(key) !== '', 'MISSING_COLUMN', `Missing required field ${key}`, path(key));
  const text = (key: keyof BarInput): string => {
    const value = get(key);
    assertThat(typeof value === 'string' && value.length > 0, 'INVALID_DATA', `${key} must be a nonempty string`, path(key));
    return value as string;
  };
  const exact = (key: keyof BarInput): string => {
    const value = text(key);
    assertThat(decimalPattern.test(value), 'INVALID_DECIMAL', `${key} must be a plain decimal string, not a binary-float JSON number`, path(key));
    return value;
  };
  const volumeRaw = get('volume');
  assertThat(typeof volumeRaw === 'number' || (typeof volumeRaw === 'string' && /^\d+(?:\.\d+)?$/.test(volumeRaw)), 'INVALID_VOLUME', 'Volume must be a nonnegative number', path('volume'));
  const volume = Number(volumeRaw);
  assertThat(Number.isFinite(volume) && volume >= 0, 'INVALID_VOLUME', 'Volume must be finite and nonnegative', path('volume'));
  const result: BarInput = { symbol: text('symbol'), openTime: parseTimestamp(get('openTime'), path('openTime')), closeTime: parseTimestamp(get('closeTime'), path('closeTime')), session: text('session'), open: exact('open'), high: exact('high'), low: exact('low'), close: exact('close'), volume };
  for (const key of ['amount', 'limitUp', 'limitDown'] as const) if (get(key) !== undefined && get(key) !== '') result[key] = exact(key);
  const tradable = get('tradable');
  if (tradable !== undefined && tradable !== '') {
    assertThat([true, false, 'true', 'false', '1', '0'].includes(tradable as boolean | string), 'INVALID_BOOLEAN', 'tradable must be true/false or CSV 1/0', path('tradable'));
    result.tradable = tradable === true || tradable === 'true' || tradable === '1';
  }
  return result;
}

function events(value: unknown, keys: string[], path: string): unknown[] {
  if (value === undefined) return [];
  assertThat(Array.isArray(value), 'INVALID_DATA', 'Expected an event array', path);
  return (value as unknown[]).map((entry, i) => {
    const result = { ...object(entry, `${path}/${i}`) };
    for (const key of keys) if (result[key] !== undefined) result[key] = parseTimestamp(result[key], `${path}/${i}/${key}`);
    return result;
  });
}

/** File decoding is bounded; normalization does not silently sort or clean bars. */
export async function importDataset(options: ImportDatasetOptions): Promise<Dataset> {
  assertThat(options && typeof options === 'object' && !Array.isArray(options), 'INVALID_IMPORT_OPTIONS', 'Import options must be an object');
  const maxBytes = boundedInteger(options.maxFileBytes ?? DEFAULT_BYTES, 'maxFileBytes');
  const maxRows = boundedInteger(options.maxRows ?? DEFAULT_ROWS, 'maxRows');
  const maxRecord = boundedInteger(options.maxRecordBytes ?? DEFAULT_RECORD_BYTES, 'maxRecordBytes');
  assertThat(['csv', 'jsonl', 'json', 'parquet', 'arrow', 'xlsx'].includes(options.format), 'UNSUPPORTED_FORMAT', 'Unsupported input format', '/format');
  if (options.formatOptions !== undefined) assertThat(options.formatOptions !== null && typeof options.formatOptions === 'object' && !Array.isArray(options.formatOptions) && Object.keys(options.formatOptions).every(key => key === 'sheet') && (options.formatOptions.sheet === undefined || (typeof options.formatOptions.sheet === 'string' && options.formatOptions.sheet.length > 0)), 'INVALID_IMPORT_OPTIONS', 'formatOptions only supports a nonempty sheet name');
  const columns = options.columns ?? {};
  assertThat(typeof columns === 'object' && !Array.isArray(columns), 'INVALID_COLUMN_MAPPING', 'columns must be an object', '/columns');
  const mapped = new Set<string>();
  for (const [key, value] of Object.entries(columns)) {
    assertThat((allColumns as readonly string[]).includes(key) && typeof value === 'string' && value.length > 0, 'INVALID_COLUMN_MAPPING', 'Column mappings use canonical field names and nonempty source names', `/columns/${key}`);
  }
  for (const key of allColumns) {
    const value = columns[key] ?? key;
    assertThat(!mapped.has(value), 'INVALID_COLUMN_MAPPING', `Source column ${value} maps to multiple fields`, '/columns');
    mapped.add(value);
  }
  const bars: BarInput[] = [];
  const append = (raw: unknown) => {
    assertThat(bars.length < maxRows, 'ROW_LIMIT_EXCEEDED', 'Dataset exceeds maxRows', '/bars', { maxRows });
    bars.push(parseRow(raw, columns, bars.length));
  };
  let metadata: unknown = options.metadata;
  let features: unknown = options.features, membership: unknown = options.membership, actions: unknown = options.actions;
  try {
    if (['parquet', 'arrow', 'xlsx'].includes(options.format)) {
      assertThat(metadata, 'MISSING_METADATA', 'Optional binary formats require explicit metadata', '/metadata');
      const adapterPath = process.env.BACKTEST_FORMAT_ADAPTER;
      assertThat(adapterPath && isAbsolute(adapterPath), 'OPTIONAL_FORMAT_ADAPTER_REQUIRED', 'Host must explicitly configure the optional format adapter', '/format');
      const module = await import(pathToFileURL(adapterPath!).href);
      const adapter = module.adapterVersion ? module : module.default;
      assertThat(adapter?.adapterVersion === '1' && typeof adapter.readRows === 'function', 'INVALID_FORMAT_ADAPTER', 'Expected optional format adapter interface version 1');
      let rows: unknown;
      try { rows = await adapter.readRows({ path: options.path, format: options.format, maxRows, maxFileBytes: maxBytes, columns: [...mapped], formatOptions: options.formatOptions }); }
      catch (error) { const failure = error as { code?: string; message?: string }; throw new BacktestError(typeof failure.code === 'string' && /^[A-Z_]{1,80}$/.test(failure.code) ? failure.code : 'DATA_IMPORT_FAILED', failure.message ?? 'Optional format decoding failed', '/path'); }
      assertThat(Array.isArray(rows), 'INVALID_FORMAT_ADAPTER', 'Adapter must return an array of source rows');
      for (const row of rows as unknown[]) {
        assertThat(Buffer.byteLength(JSON.stringify(row)) <= maxRecord, 'RECORD_TOO_LARGE', 'Decoded record exceeds maxRecordBytes', `/bars/${bars.length}`);
        append(row);
      }
    } else if (options.format === 'csv') {
      assertThat(metadata, 'MISSING_METADATA', 'CSV input requires explicit metadata', '/metadata');
      const parser = parse({ bom: true, trim: true, skip_empty_lines: true, raw: true, max_record_size: maxRecord, columns: (headers: string[]) => {
        assertThat(new Set(headers).size === headers.length, 'DUPLICATE_COLUMN', 'CSV headers must be unique');
        for (const key of requiredColumns) assertThat(headers.includes(columns[key] ?? key), 'MISSING_COLUMN', `CSV is missing ${columns[key] ?? key}`, `/columns/${key}`);
        return headers;
      } });
      const source = Readable.from(utf8Chunks(options.path, maxBytes));
      const pumping = pipeline(source, parser).then(() => undefined, error => error as Error);
      try {
        for await (const parsed of parser) {
          assertThat(Buffer.byteLength(parsed.raw) <= maxRecord, 'RECORD_TOO_LARGE', 'CSV record exceeds maxRecordBytes', `/bars/${bars.length}`);
          append(parsed.record);
        }
      }
      finally { source.destroy(); parser.destroy(); await pumping; }
      const failure = await pumping;
      if (failure) throw failure;
    } else if (options.format === 'jsonl') {
      assertThat(metadata, 'MISSING_METADATA', 'JSONL input requires explicit metadata', '/metadata');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '', first = true, line = 0;
      const consume = (text: string) => {
        line++;
        assertThat(Buffer.byteLength(text) <= maxRecord, 'RECORD_TOO_LARGE', 'JSONL record exceeds maxRecordBytes', `/lines/${line}`);
        if (!text.trim()) return;
        try { append(JSON.parse(text)); }
        catch (error) { if (error instanceof BacktestError) throw error; throw new BacktestError('INVALID_JSONL', `Invalid JSON on line ${line}`, `/lines/${line}`); }
      };
      for await (const chunk of fileChunks(options.path, maxBytes)) {
        let decoded = decoder.decode(chunk, { stream: true });
        if (first) { decoded = decoded.replace(/^\uFEFF/, ''); first = false; }
        pending += decoded;
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, at)); pending = pending.slice(at + 1); }
        assertThat(Buffer.byteLength(pending) <= maxRecord, 'RECORD_TOO_LARGE', 'JSONL record exceeds maxRecordBytes', `/lines/${line + 1}`);
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
    } else {
      const text = await readBoundedText(options.path, maxBytes);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new BacktestError('INVALID_JSON', 'Input is not valid JSON', '/path'); }
      if (Array.isArray(raw)) raw.forEach(append);
      else {
        const input = object(raw, '/');
        for (const key of Object.keys(input)) assertThat(['metadata', 'bars', 'features', 'membership', 'actions'].includes(key), 'INVALID_DATA', `Unknown dataset field ${key}`, `/${key}`);
        if (metadata && input.metadata) assertThat(canonicalJSON(metadata) === canonicalJSON(input.metadata), 'CONFLICTING_METADATA', 'Embedded and supplied metadata differ', '/metadata');
        metadata ??= input.metadata;
        for (const [key, provided] of [['features', features], ['membership', membership], ['actions', actions]] as const) assertThat(provided === undefined || input[key] === undefined, 'CONFLICTING_EVENTS', `Supply ${key} either in the file or options, not both`, `/${key}`);
        features ??= input.features; membership ??= input.membership; actions ??= input.actions;
        assertThat(Array.isArray(input.bars), 'INVALID_DATA', 'JSON dataset requires a bars array', '/bars');
        (input.bars as unknown[]).forEach(append);
      }
      assertThat(metadata, 'MISSING_METADATA', 'Dataset requires explicit metadata', '/metadata');
    }
    const dataset = normalizeDataset({ metadata, bars, features: events(features, ['availableAt'], '/features'), membership: events(membership, ['availableAt'], '/membership'), actions: events(actions, ['at', 'payAt'], '/actions') } as DatasetInput);
    return options.frames ? applyFrames(dataset, options.frames) : dataset;
  } catch (error) {
    if (error instanceof BacktestError) throw error;
    throw new BacktestError('DATA_IMPORT_FAILED', error instanceof Error ? error.message : String(error), '/path');
  }
}
