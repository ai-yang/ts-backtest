import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { inflateRawSync, gunzipSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { tableFromIPC } from 'apache-arrow';
import { read as readWorkbook, utils } from 'xlsx';

export const adapterVersion = '1';
export const formats = ['parquet', 'arrow', 'xlsx'];
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function check(condition, code, message) { if (!condition) fail(code, message); }
async function boundedBytes(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    check(info.isFile() && info.size <= maxBytes, 'DATA_TOO_LARGE', 'Optional format source exceeds its byte budget or is not a regular file');
    const chunks = []; let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.byteLength; check(bytes <= maxBytes, 'DATA_TOO_LARGE', 'Source grew beyond its byte budget'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}
function scalar(value) {
  if (typeof value === 'bigint') { const n = Number(value); check(Number.isSafeInteger(n), 'UNSAFE_INTEGER', 'Integer field exceeds the exact JavaScript integer range; use text for decimal prices'); return n; }
  check(value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value), 'UNSUPPORTED_CELL_TYPE', 'Only scalar text, numeric, and boolean columns are supported; prices must use text');
  return value;
}
// Inspect the ZIP directory before a workbook parser can expand compressed XML.
function inspectZip(bytes, maxExpandedBytes) {
  check(bytes.readUInt32LE(0) === 0x04034b50, 'INVALID_XLSX', 'XLSX input must be a ZIP-based workbook');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  check(end >= 0, 'INVALID_XLSX', 'Workbook ZIP directory is missing');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  check(count !== 65535 && offset !== 0xffffffff && count <= 4096, 'UNSUPPORTED_XLSX_ARCHIVE', 'ZIP64 and workbooks with more than 4096 members are unsupported');
  let at = offset, total = 0;
  for (let i = 0; i < count; i++) {
    check(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50, 'INVALID_XLSX', 'Invalid workbook ZIP directory');
    check((bytes.readUInt16LE(at + 8) & 1) === 0, 'UNSUPPORTED_XLSX_ARCHIVE', 'Encrypted workbooks are unsupported');
    const size = bytes.readUInt32LE(at + 24); check(size !== 0xffffffff, 'UNSUPPORTED_XLSX_ARCHIVE', 'ZIP64 members are unsupported');
    total += size; check(total <= maxExpandedBytes, 'EXPANDED_DATA_LIMIT', 'Workbook XML exceeds the expanded-byte budget');
    const compressed = bytes.readUInt32LE(at + 20), local = bytes.readUInt32LE(at + 42), method = bytes.readUInt16LE(at + 10);
    check(local + 30 <= offset && bytes.readUInt32LE(local) === 0x04034b50, 'INVALID_XLSX', 'Invalid ZIP local header');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    check(start + compressed <= offset, 'INVALID_XLSX', 'ZIP member is outside the input boundary');
    check(method === 0 || method === 8, 'UNSUPPORTED_XLSX_ARCHIVE', 'Only stored and deflate ZIP members are supported');
    let decoded;
    try { decoded = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size) }); }
    catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE') fail('EXPANDED_DATA_LIMIT', 'ZIP payload exceeds its declared expanded-byte budget'); throw error; }
    check(decoded.byteLength === size, 'INVALID_XLSX', 'ZIP member length does not match its directory');
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
}
/** The host calls this trusted adapter; strategy and data files cannot select code. */
export async function readRows(options) {
  const { path, format, maxRows, maxFileBytes, columns = [], formatOptions = {} } = options;
  check(formats.includes(format), 'UNSUPPORTED_FORMAT', 'Optional adapter supports parquet, arrow and xlsx');
  check(Number.isSafeInteger(maxRows) && maxRows > 0 && Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0, 'INVALID_IMPORT_LIMIT', 'Explicit positive row and byte limits are required');
  const maxExpandedBytes = Math.min(maxFileBytes * 8, 256 * 1024 * 1024);
  const bytes = await boundedBytes(path, maxFileBytes);
  let rows;
  if (format === 'parquet') {
    const metadata = parquetMetadata(bytes);
    check(metadata.num_rows <= BigInt(maxRows), 'ROW_LIMIT_EXCEEDED', 'Parquet row count exceeds maxRows');
    let expanded = 0n;
    for (const group of metadata.row_groups) for (const column of group.columns) expanded += BigInt(column.meta_data?.total_uncompressed_size ?? 0);
    check(expanded <= BigInt(maxExpandedBytes), 'EXPANDED_DATA_LIMIT', 'Parquet expanded column bytes exceed the budget');
    const names = metadata.schema.filter(item => item.num_children === undefined).map(item => item.name);
    check(new Set(names).size === names.length, 'DUPLICATE_COLUMN', 'Parquet column names must be unique');
    const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let decodedBytes = 0;
    const boundedCompressors = Object.fromEntries(Object.entries(compressors).map(([name, decode]) => [name, (input, length) => {
      check(Number.isSafeInteger(length) && length >= 0 && (decodedBytes += length) <= maxExpandedBytes, 'EXPANDED_DATA_LIMIT', 'Parquet decoded pages exceed the expanded-byte budget');
      const options = { maxOutputLength: Math.max(1, length) };
      const output = name === 'GZIP' ? gunzipSync(input, options) : name === 'BROTLI' ? brotliDecompressSync(input, options) : name === 'ZSTD' ? zstdDecompressSync(input, options) : decode(input, length);
      check(output.byteLength === length, 'INVALID_PARQUET', 'Decoded page length differs from its header'); return output;
    }]));
    rows = await parquetReadObjects({ file, metadata, compressors: boundedCompressors, columns: columns.filter(name => names.includes(name)) });
  } else if (format === 'arrow') {
    const table = tableFromIPC(bytes);
    check(table.numRows <= maxRows, 'ROW_LIMIT_EXCEEDED', 'Arrow IPC row count exceeds maxRows');
    check(new Set(table.schema.fields.map(field => field.name)).size === table.schema.fields.length, 'DUPLICATE_COLUMN', 'Arrow columns must be unique');
    rows = Array.from(table, row => Object.fromEntries(Object.entries(row.toJSON()).filter(([name]) => columns.includes(name))));
  } else {
    check(bytes.length >= 22, 'INVALID_XLSX', 'Workbook file is truncated'); inspectZip(bytes, maxExpandedBytes);
    const header = readWorkbook(bytes, { type: 'buffer', bookSheets: true });
    const sheetName = formatOptions.sheet ?? (header.SheetNames.length === 1 ? header.SheetNames[0] : undefined);
    check(typeof sheetName === 'string', 'AMBIGUOUS_SHEET', 'Select formatOptions.sheet when a workbook has multiple sheets');
    check(header.SheetNames.includes(sheetName), 'SHEET_NOT_FOUND', 'Requested worksheet does not exist');
    const book = readWorkbook(bytes, { type: 'buffer', sheets: sheetName, cellDates: true, cellFormula: true, sheetRows: maxRows + 2, dense: false });
    const sheet = book.Sheets[sheetName]; const range = utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1');
    check(range.e.r - range.s.r <= maxRows, 'ROW_LIMIT_EXCEEDED', 'Worksheet row count exceeds maxRows');
    check(range.e.c - range.s.c < 1024, 'COLUMN_LIMIT_EXCEEDED', 'Worksheet has more than 1024 columns');
    for (const [address, cell] of Object.entries(sheet)) if (!address.startsWith('!')) {
      check(!cell.f, 'FORMULA_CELL_UNSUPPORTED', 'Formula cells are not executed or accepted from cached results');
      check(cell.t !== 'e' && cell.t !== 'd', 'UNSUPPORTED_CELL_TYPE', 'Error and Excel date cells are unsupported; use explicit epoch milliseconds or zoned ISO text');
    }
    const matrix = utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false });
    const names = matrix.shift() ?? [];
    check(names.every(name => typeof name === 'string' && name.length > 0) && new Set(names).size === names.length, 'INVALID_COLUMN_MAPPING', 'Worksheet headers must be unique nonempty strings');
    rows = matrix.map(values => Object.fromEntries(names.map((name, i) => [name, values[i]]).filter(([name]) => columns.includes(name))));
  }
  check(rows.length <= maxRows, 'ROW_LIMIT_EXCEEDED', 'Decoded rows exceed maxRows');
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, scalar(value)])));
}
