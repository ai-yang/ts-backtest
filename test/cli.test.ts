import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { normalizeDataset } from '../src/data/normalize.js';
import { input, spec } from './helpers.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/adapters/cli.js', import.meta.url));
const engineUrl = new URL('../src/engine/run.js', import.meta.url).href;

async function run(args: string[], cwd = tmpdir()) {
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, output: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, output: JSON.parse(failure.stdout), stderr: failure.stderr };
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, yaml = false) {
  const dir = await mkdtemp(join(tmpdir(), 'backtest-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, '配置 with spaces');
  await mkdir(configDir);
  await writeFile(join(configDir, 'bars.jsonl'), input().bars.map(b => JSON.stringify(b)).join('\n'));
  await writeFile(join(configDir, 'metadata.json'), JSON.stringify(input().metadata));
  const config = { dataset: { path: 'bars.jsonl', format: 'jsonl', metadataPath: 'metadata.json' }, spec: spec() };
  const path = join(configDir, yaml ? 'run.yaml' : 'run.json');
  await writeFile(path, yaml ? stringify(config) : JSON.stringify(config));
  return { dir, configDir, config, path };
}

test('CLI capabilities and usage emit one JSON value without stderr banners', async () => {
  const result = await run(['capabilities']);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(result.output.formats, ['csv', 'jsonl', 'json']);
  assert.equal(result.output.specSchema.type, 'object');
  assert.ok((await run(['--help'])).output.commands.includes('capabilities'));
});

test('CLI prepares portable cache and inspects it from another cwd', async t => {
  const f = await fixture(t), output = join(f.dir, 'artifacts', 'dataset.cache.json');
  const prepared = await run(['prepare', '--config', f.path, '--output', output]);
  assert.equal(prepared.code, 0); assert.equal(prepared.stderr, '');
  assert.equal(prepared.output.datasetId, normalizeDataset(input()).id);
  assert.equal(prepared.output.outputPath, output);
  const inspected = await run(['inspect', '--dataset', output], dirname(f.dir));
  assert.equal(inspected.code, 0); assert.equal(inspected.output.hash, prepared.output.hash);
  assert.equal(inspected.output.rowCount, 5);
});

test('CLI JSON and YAML validation share resolved specification and data identity', async t => {
  const f = await fixture(t), yamlPath = join(f.configDir, 'same.yaml');
  await writeFile(yamlPath, stringify(f.config));
  const json = await run(['validate', '--config', f.path]);
  const yaml = await run(['validate', '--config', yamlPath]);
  assert.equal(json.code, 0); assert.equal(yaml.code, 0);
  assert.deepEqual(json.output, yaml.output);
  assert.equal(json.output.resolvedSpec.account.initialCash, '1000');
  assert.equal(json.output.resolvedSpec.datasetId, normalizeDataset(input()).id);
});

test('CLI loads a cache through config without reparsing source bars', async t => {
  const f = await fixture(t), cache = join(f.configDir, 'prepared.json');
  assert.equal((await run(['prepare', '--config', f.path, '--output', cache])).code, 0);
  await rm(join(f.configDir, 'bars.jsonl'));
  const configPath = join(f.configDir, 'cached.json');
  await writeFile(configPath, JSON.stringify({ dataset: { cachePath: 'prepared.json' }, spec: spec() }));
  const result = await run(['validate', '--config', configPath]);
  assert.equal(result.code, 0); assert.equal(result.output.status, 'valid');
});

test('CLI returns structured validation errors and nonzero exit codes', async t => {
  const f = await fixture(t);
  f.config.spec.costs.periods = [];
  await writeFile(f.path, JSON.stringify(f.config));
  const result = await run(['validate', '--config', f.path]);
  assert.equal(result.code, 2); assert.equal(result.stderr, '');
  assert.equal(result.output.status, 'error'); assert.equal(typeof result.output.error.code, 'string');
  assert.ok(result.output.error.path.startsWith('/costs'));
  const args = await run(['run', '--config', f.path, '--unknown', 'x']);
  assert.equal(args.code, 2); assert.equal(args.output.error.code, 'INVALID_ARGUMENTS');
});

test('CLI rejects YAML duplicate keys and aliases instead of silently overriding values', async t => {
  const f = await fixture(t, true);
  await writeFile(f.path, 'dataset: {}\ndataset: {}\n');
  assert.equal((await run(['validate', '--config', f.path])).output.error.code, 'INVALID_CONFIG');
  await writeFile(f.path, 'dataset: &d {}\nspec: *d\n');
  assert.equal((await run(['validate', '--config', f.path])).output.error.code, 'INVALID_CONFIG');
});

test('CLI checks dataset identity/currency and rejects conflicting source options', async t => {
  const f = await fixture(t);
  f.config.spec.datasetId = 'ds_wrong'; await writeFile(f.path, JSON.stringify(f.config));
  assert.equal((await run(['validate', '--config', f.path])).output.error.code, 'DATASET_MISMATCH');
  delete f.config.spec.datasetId; f.config.spec.account.currency = 'USD'; await writeFile(f.path, JSON.stringify(f.config));
  assert.equal((await run(['validate', '--config', f.path])).output.error.code, 'CURRENCY_MISMATCH');
  await writeFile(f.path, JSON.stringify({ dataset: { cachePath: 'prepared.json', path: 'bars.jsonl' }, spec: spec() }));
  assert.equal((await run(['prepare', '--config', f.path])).output.error.code, 'INVALID_CONFIG');
});

test('CLI run matches SDK and writes an atomic JSON artifact with decimal money', async t => {
  const f = await fixture(t, true), output = join(f.dir, 'result.json');
  // The engine module is owned by the execution implementation; this is a real
  // end-to-end gate, not a stubbed engine test.
  const { runBacktest } = await import(engineUrl);
  const expected = await runBacktest(normalizeDataset(input()), spec());
  const result = await run(['run', '--config', f.path, '--output', output]);
  assert.equal(result.code, 0, JSON.stringify(result.output));
  assert.equal(result.stderr, ''); assert.equal(result.output.status, 'succeeded');
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved.metrics, expected.metrics);
  assert.deepEqual(saved.fills, expected.fills);
  assert.equal(typeof saved.metrics.finalEquity, 'string');
  assert.equal(typeof saved.fills[0].price, 'string');
});
