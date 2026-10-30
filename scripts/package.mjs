import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile, cp, rm, stat, chmod } from 'node:fs/promises';
import { resolve, dirname, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = resolve(root, 'dist/package');
const output = resolve(releaseRoot, 'ts-backtest');
const optionalOutput = resolve(releaseRoot, 'ts-backtest-optional-formats');
const coreOnly = process.argv.includes('--core-only');
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(releaseRoot, { recursive: true });
await rm(output, { recursive: true, force: true }); await mkdir(output);
const entries = { core: 'src/index.ts', cli: 'src/adapters/cli.ts', mcp: 'src/adapters/mcp.ts', worker: 'src/runtime/worker.ts', service: 'src/runtime/manager.ts' };
try { await stat(resolve(root, 'src/research/worker.ts')); entries['research-worker'] = 'src/research/worker.ts'; } catch {}
const manifestInputs = [];
async function bundle(entryPoints, outdir) {
  const result = await build({ absWorkingDir: root, entryPoints, outdir, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outExtension: { '.js': '.cjs' }, minify: true, sourcemap: false, legalComments: 'external', metafile: true, logLevel: 'warning', logOverride: { 'empty-import-meta': 'silent' } });
  manifestInputs.push(...Object.keys(result.metafile.inputs));
  for (const info of Object.values(result.metafile.outputs)) for (const dependency of info.imports) if (dependency.external && !dependency.path.startsWith('node:') && !['fs', 'path', 'os', 'util', 'stream', 'buffer', 'events', 'crypto', 'http', 'https', 'net', 'tls', 'url', 'zlib', 'assert', 'worker_threads', 'process', 'tty', 'child_process', 'module', 'string_decoder', 'perf_hooks', 'timers'].some(name => dependency.path === name || dependency.path.startsWith(`${name}/`))) throw new Error(`Unbundled production dependency: ${dependency.path}`);
  return result.metafile;
}
const coreMeta = await bundle(entries, output);
await chmod(resolve(output, 'cli.cjs'), 0o755); await chmod(resolve(output, 'mcp.cjs'), 0o755);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
// Declarations retain relative module structure. Vendor only type declarations, never runtime node_modules.
for (const source of await files(resolve(root, 'dist/src'))) if (/\.d\.(?:ts|cts|mts)$/.test(source)) {
  const destination = resolve(output, 'types', relative(resolve(root, 'dist/src'), source));
  await mkdir(dirname(destination), { recursive: true }); await cp(source, destination);
}
for (const name of ['zod', 'decimal.js']) {
  const sourceRoot = resolve(root, 'node_modules', name), targetRoot = resolve(output, 'types/vendor', name);
  for (const source of await files(sourceRoot)) if (/\.d\.(?:ts|cts|mts)$/.test(source)) {
    const target = resolve(targetRoot, relative(sourceRoot, source)); await mkdir(dirname(target), { recursive: true }); await cp(source, target);
  }
}
for (const declaration of await files(resolve(output, 'types'))) if (/\.d\.(?:ts|cts|mts)$/.test(declaration) && !declaration.includes(`${sep}vendor${sep}`)) {
  let source = await readFile(declaration, 'utf8');
  for (const [name, target] of [['zod', 'zod/index.js'], ['decimal.js', 'decimal.js/decimal.js']]) {
    let path = relative(dirname(declaration), resolve(output, 'types/vendor', target)).split(sep).join('/'); if (!path.startsWith('.')) path = `./${path}`;
    source = source.replaceAll(`from '${name}'`, `from '${path}'`).replaceAll(`from "${name}"`, `from "${path}"`).replaceAll(`import("${name}")`, `import("${path}")`);
  }
  await writeFile(declaration, source);
}
const schemaModule = await import(new URL('../dist/src/spec/validate.js', import.meta.url));
await mkdir(resolve(output, 'schemas'));
await writeFile(resolve(output, 'schemas/backtest.schema.json'), JSON.stringify(schemaModule.backtestSpecJsonSchema, null, 2));
await writeFile(resolve(output, 'schemas/metadata.schema.json'), JSON.stringify(schemaModule.metadataJsonSchema, null, 2));
await cp(resolve(root, 'examples'), resolve(output, 'examples'), { recursive: true });
await cp(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true, filter: path => { const name = relative(resolve(root, 'docs'), path).split(sep).join('/'); return !name.startsWith('evidence/') || /(?:benchmark(?:-final-hot)?|codex-package-smoke-verified)\.json$/.test(name); } });
await cp(resolve(root, 'optional-formats/README.md'), resolve(output, 'docs/OPTIONAL-FORMATS.md'));
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'));
await writeFile(resolve(output, 'README.md'), (await readFile(resolve(root, 'README.md'), 'utf8')).replace('(optional-formats/README.md)', '(docs/OPTIONAL-FORMATS.md)'));
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: packageInfo.name, version: packageInfo.version, description: packageInfo.description, license: packageInfo.license, author: packageInfo.author, repository: packageInfo.repository, homepage: packageInfo.homepage, bugs: packageInfo.bugs, type: 'commonjs', engines: { node: '>=22' }, main: './core.cjs', types: './types/index.d.ts', exports: { '.': { types: './types/index.d.ts', default: './core.cjs' }, './runtime': { types: './types/runtime/manager.d.ts', default: './service.cjs' }, './schema': './schemas/backtest.schema.json', './metadata-schema': './schemas/metadata.schema.json' }, bin: { 'ts-backtest': './cli.cjs', 'ts-backtest-mcp': './mcp.cjs' }, dependencies: {} }, null, 2));
async function notices(destination, inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue;
    let path = dirname(resolve(root, input));
    while (path !== root && path !== dirname(path)) {
      try { const info = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')); if (info.name) { packages.set(`${info.name}@${info.version}`, { path, info }); break; } } catch {}
      path = dirname(path);
    }
  }
  let text = 'Third-party libraries included in this distribution\n';
  for (const [name, value] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    text += `\n===== ${name} (${value.info.license ?? 'see notices'}) =====\n`;
    const names = (await readdir(value.path)).filter(name => /^(license|licence|notice|copying)(\.|$)/i.test(name));
    for (const file of names) if ((await stat(resolve(value.path, file))).isFile()) text += `${await readFile(resolve(value.path, file), 'utf8')}\n`;
  }
  await writeFile(resolve(destination, 'THIRD_PARTY_NOTICES.txt'), text);
  return [...packages.keys()].sort();
}
const coreDependencies = await notices(output, Object.keys(coreMeta.inputs));
let optionalDependencies;
if (!coreOnly) {
  await rm(optionalOutput, { recursive: true, force: true }); await mkdir(optionalOutput);
  const metadata = await bundle({ formats: 'optional-formats/index.mjs' }, optionalOutput);
  await cp(resolve(root, 'optional-formats/index.d.ts'), resolve(optionalOutput, 'index.d.ts'));
  await cp(resolve(root, 'optional-formats/README.md'), resolve(optionalOutput, 'README.md'));
  await cp(resolve(root, 'LICENSE'), resolve(optionalOutput, 'LICENSE'));
  const optionalInfo = JSON.parse(await readFile(resolve(root, 'optional-formats/package.json'), 'utf8'));
  await writeFile(resolve(optionalOutput, 'package.json'), JSON.stringify({ name: optionalInfo.name, version: packageInfo.version, license: optionalInfo.license, author: optionalInfo.author, repository: optionalInfo.repository, homepage: optionalInfo.homepage, bugs: optionalInfo.bugs, type: 'commonjs', main: './formats.cjs', types: './index.d.ts', engines: { node: '>=22' }, dependencies: {} }, null, 2));
  optionalDependencies = await notices(optionalOutput, Object.keys(metadata.inputs));
}
async function manifest(directory, dependencies) {
  const entries = {};
  for (const path of await files(directory)) { const bytes = await readFile(path); entries[relative(directory, path).split(sep).join('/')] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }; }
  const totalBytes = Object.values(entries).reduce((n, info) => n + info.bytes, 0);
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ version: packageInfo.version, buildNode: process.version, buildPlatform: `${process.platform}-${process.arch}`, sourceLockSha256: createHash('sha256').update(await readFile(resolve(root, directory === optionalOutput ? 'optional-formats/package-lock.json' : 'package-lock.json'))).digest('hex'), dependencies, payloadBytes: totalBytes, files: entries }, null, 2));
  return totalBytes;
}
const reports = [];
for (const [directory, dependencies] of [[output, coreDependencies], ...(!coreOnly ? [[optionalOutput, optionalDependencies]] : [])]) {
  await manifest(directory, dependencies);
  const name = relative(releaseRoot, directory), archive = resolve(releaseRoot, `${name}-${packageInfo.version}.tgz`);
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', releaseRoot, name]);
  const content = await files(directory); const unpackedBytes = (await Promise.all(content.map(path => stat(path)))).reduce((n, info) => n + info.size, 0);
  reports.push({ name, archive: relative(root, archive), archiveBytes: (await stat(archive)).size, unpackedBytes, fileCount: content.length, bundledJavascriptBytes: (await Promise.all(content.filter(path => path.endsWith('.cjs')).map(path => stat(path)))).reduce((n, info) => n + info.size, 0) });
}
const report = { node: process.version, platform: `${process.platform}-${process.arch}`, distributions: reports, note: 'Byte counts include bundled runtime, declarations, schemas, docs, examples, licenses and manifest; exclude Node executable and user data. Gzip archive size is not installed size.' };
await writeFile(resolve(releaseRoot, 'size-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
