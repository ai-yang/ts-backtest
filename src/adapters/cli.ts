#!/usr/bin/env node
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { importDataset, readBoundedText, setFormatAdapter, type ImportDatasetOptions } from '../data/import.js';
import { encodeDataset, decodeDataset } from '../data/serialize.js';
import { runBacktest, validateBacktest } from '../engine/run.js';
import { backtestSpecJsonSchema } from '../spec/validate.js';
import { assertThat, BacktestError, errorJSON } from '../spec/errors.js';
import { contentHash } from '../spec/canonical.js';
import { runSweep } from '../research/sweep.js';
import { runWalkForward } from '../research/walk-forward.js';
import { factorDiagnostics } from '../research/factors.js';
import { renderReport } from '../reports/html.js';
import type { BacktestSpec, BacktestResult, Dataset } from '../spec/types.js';

const COMMANDS = ['capabilities', 'prepare', 'inspect', 'validate', 'run', 'sweep', 'walk-forward', 'factors', 'report'] as const;
const usage = {
  commands: ['capabilities', 'prepare --config config.json [--output dataset.cache.json]', 'inspect --config config.yaml', 'inspect --dataset dataset.cache.json', 'validate --config config.yaml', 'run --config config.yaml [--output result.json]', 'sweep --config config.yaml --request sweep.yaml [--output study.json]', 'walk-forward --config config.yaml --request walk-forward.yaml [--output study.json]', 'factors --config config.yaml --request factors.yaml [--output study.json]', 'report --input result.json --output report.html'],
  config: '{ dataset: { path, format, metadata | metadataPath, columns?, maxRows?, maxFileBytes? } | { cachePath }, spec?: BacktestSpec }',
  optionalFormats: 'Trusted deployment option: --formats /absolute/path/formats.cjs; data config cannot choose executable modules.',
  paths: 'Dataset and metadata paths are relative to the config file; --output is relative to the current directory.',
};

function asObject(value: unknown, path: string): Record<string, unknown> {
  assertThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_CONFIG', 'Expected an object', path);
  return value as Record<string, unknown>;
}

export async function readConfig(path: string): Promise<unknown> {
  const text = await readBoundedText(path, 1024 * 1024);
  try {
    if (['.yaml', '.yml'].includes(extname(path).toLowerCase())) {
      const document = parseDocument(text, { uniqueKeys: true, schema: 'core', strict: true });
      assertThat(document.errors.length === 0 && document.warnings.length === 0, 'INVALID_CONFIG', [...document.errors, ...document.warnings].map(e => e.message).join('; '), '/config');
      return document.toJS({ maxAliasCount: 0 });
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof BacktestError) throw error;
    throw new BacktestError('INVALID_CONFIG', error instanceof Error ? error.message : String(error), '/config');
  }
}

export async function loadRunConfig(configPath: string): Promise<{ dataset: Dataset; specInput: unknown }> {
  const config = asObject(await readConfig(configPath), '/');
  for (const key of Object.keys(config)) assertThat(['dataset', 'spec'].includes(key), 'INVALID_CONFIG', `Unknown config field ${key}`, `/${key}`);
  const source = asObject(config.dataset, '/dataset');
  const base = dirname(resolve(configPath));
  let dataset: Dataset;
  if (source.cachePath !== undefined) {
    assertThat(Object.keys(source).length === 1 && typeof source.cachePath === 'string', 'INVALID_CONFIG', 'cachePath cannot be combined with file import options', '/dataset');
    dataset = decodeDataset(await readBoundedText(resolve(base, source.cachePath as string), 256 * 1024 * 1024));
  } else {
    const keys = ['path', 'format', 'metadata', 'metadataPath', 'columns', 'maxRows', 'maxFileBytes', 'maxRecordBytes', 'features', 'membership', 'actions', 'frames', 'formatOptions'];
    for (const key of Object.keys(source)) assertThat(keys.includes(key), 'INVALID_CONFIG', `Unknown dataset option ${key}`, `/dataset/${key}`);
    assertThat(typeof source.path === 'string' && typeof source.format === 'string', 'INVALID_CONFIG', 'dataset.path and dataset.format are required', '/dataset');
    assertThat(!(source.metadata !== undefined && source.metadataPath !== undefined), 'INVALID_CONFIG', 'Use metadata or metadataPath, not both', '/dataset');
    let metadata = source.metadata;
    if (source.metadataPath !== undefined) {
      assertThat(typeof source.metadataPath === 'string', 'INVALID_CONFIG', 'metadataPath must be a string', '/dataset/metadataPath');
      metadata = await readConfig(resolve(base, source.metadataPath as string));
    }
    const options = { ...source, path: resolve(base, source.path as string), metadata };
    delete (options as Record<string, unknown>).metadataPath;
    dataset = await importDataset(options as unknown as ImportDatasetOptions);
  }
  return { dataset, specInput: config.spec };
}

function manifest(dataset: Dataset) {
  return { datasetId: dataset.id, hash: dataset.hash, rowCount: dataset.rowCount, metadata: dataset.metadata, symbols: [...dataset.series.keys()], warnings: dataset.warnings };
}

function validatedSpec(dataset: Dataset, value: unknown): BacktestSpec {
  const spec = validateBacktest(dataset, value);
  return { ...spec, datasetId: dataset.id };
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function cliMain(argv = process.argv.slice(2)): Promise<unknown> {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === 'help') return usage;
  assertThat((COMMANDS as readonly string[]).includes(command), 'INVALID_COMMAND', `Unknown command ${command}`, '/command', { usage });
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    assertThat(key !== undefined && ['--config', '--output', '--dataset', '--formats', '--request', '--input'].includes(key) && value !== undefined && !value.startsWith('--') && !flags.has(key), 'INVALID_ARGUMENTS', 'Expected unique known path flags (see --help)', '/arguments');
    flags.set(key!, value!);
  }
  if (flags.has('--formats')) { setFormatAdapter(resolve(flags.get('--formats')!)); flags.delete('--formats'); }
  if (command === 'report') {
    assertThat(flags.size===2&&flags.has('--input')&&flags.has('--output'),'INVALID_ARGUMENTS','report requires exactly --input result.json --output report.html');
    let value:unknown;try{value=JSON.parse(await readBoundedText(resolve(flags.get('--input')!),256*1024*1024));}catch(error){throw new BacktestError('INVALID_RESULT_INPUT',error instanceof Error?error.message:String(error));}
    const html=renderReport(value as BacktestResult),outputPath=resolve(flags.get('--output')!);await atomicWrite(outputPath,html);
    return {status:'succeeded',outputPath,bytes:Buffer.byteLength(html),mimeType:'text/html'};
  }
  assertThat(!flags.has('--input'),'INVALID_ARGUMENTS','--input is only valid for report');
  const research=['sweep','walk-forward','factors'].includes(command);
  assertThat(!flags.has('--request')||research,'INVALID_ARGUMENTS','--request is only valid for research commands');
  assertThat(!research||flags.has('--request'),'INVALID_ARGUMENTS','Research commands require --request');
  if (command === 'capabilities') {
    assertThat(flags.size === 0, 'INVALID_ARGUMENTS', 'capabilities takes no flags');
    return { schemaVersion: '1', adapter: 'cli', formats: ['csv', 'jsonl', 'json'], optionalFormats: { formats: ['parquet', 'arrow', 'xlsx'], configured: Boolean(process.env.BACKTEST_FORMAT_ADAPTER), enable: '--formats /absolute/path/formats.cjs' }, configFormats: ['json', 'yaml'], cacheFormat: 'ts-backtest-dataset/1', commands: [...COMMANDS], limits: { defaultImportBytes: 64 * 1024 * 1024, defaultImportRows: 2_000_000 }, specSchema: backtestSpecJsonSchema };
  }
  if (command === 'inspect' && flags.has('--dataset')) {
    assertThat(flags.size === 1, 'INVALID_ARGUMENTS', 'inspect --dataset cannot be combined with other flags');
    return { status: 'ready', ...manifest(decodeDataset(await readBoundedText(resolve(flags.get('--dataset')!), 256 * 1024 * 1024))) };
  }
  assertThat(flags.has('--config') && !flags.has('--dataset'), 'INVALID_ARGUMENTS', `${command} requires --config`);
  assertThat(!flags.has('--output') || command === 'prepare' || command === 'run' || research, 'INVALID_ARGUMENTS', '--output is only valid for prepare, run and research commands');
  const { dataset, specInput } = await loadRunConfig(flags.get('--config')!);
  const output = flags.has('--output') ? resolve(flags.get('--output')!) : undefined;
  if (command === 'prepare' || command === 'inspect') {
    if (output) await atomicWrite(output, encodeDataset(dataset));
    return { status: 'ready', ...manifest(dataset), ...(output ? { outputPath: output } : {}) };
  }
  if(research){
    const request=await readConfig(flags.get('--request')!);
    const result=command==='factors'?factorDiagnostics(dataset,request as Parameters<typeof factorDiagnostics>[1]):
      command==='sweep'?await runSweep(dataset,validatedSpec(dataset,specInput),request as Parameters<typeof runSweep>[2]):
      await runWalkForward(dataset,validatedSpec(dataset,specInput),request as Parameters<typeof runWalkForward>[2]);
    if(output){await atomicWrite(output,JSON.stringify(result));return {status:'succeeded',kind:result.kind,datasetId:dataset.id,fingerprint:result.fingerprint,outputPath:output};}
    return {status:'succeeded',...result};
  }
  const spec = validatedSpec(dataset, specInput);
  if (command === 'validate') return { status: 'valid', ...manifest(dataset), resolvedSpec: spec, configHash: contentHash(spec) };
  const result = await runBacktest(dataset, spec);
  if (output) {
    await atomicWrite(output, JSON.stringify(result));
    return { status: 'succeeded', datasetId: dataset.id, fingerprint: result.fingerprint, metrics: result.metrics, warnings: result.warnings, outputPath: output };
  }
  return { status: 'succeeded', ...result };
}

// __filename is supplied by the production CJS bundle; ESM uses import.meta.url.
const moduleUrl = typeof __filename === 'string' ? pathToFileURL(__filename).href : import.meta.url;
if (process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href) {
  cliMain().then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); }, error => {
    process.stdout.write(`${JSON.stringify({ status: 'error', error: errorJSON(error) })}\n`);
    process.exitCode = error instanceof BacktestError ? 2 : 1;
  });
}
