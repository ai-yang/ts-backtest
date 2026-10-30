import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'backtest-packaged-'));
const release = resolve(temporary, 'ts-backtest');
const optional = resolve(temporary, 'ts-backtest-optional-formats');
const results = [];
const binaries = [process.execPath];
try { await stat(resolve(root, '.cache/node22/node')); binaries.push(resolve(root, '.cache/node22/node')); } catch {}
async function walk(path) {
  const all = [];
  for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) all.push(...await walk(child)); else all.push(child); }
  return all;
}
async function verifyManifest(path) {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  for (const [file, expected] of Object.entries(manifest.files)) { const content = await readFile(join(path, file)); assert.equal(content.length, expected.bytes); assert.equal(createHash('sha256').update(content).digest('hex'), expected.sha256); }
  if (path === release) assert.ok(!manifest.dependencies.some(name => /^(apache-arrow|hyparquet|hyparquet-compressors|xlsx|typescript|esbuild)@/.test(name)), 'core must exclude optional codecs and build tools');
  if (path === optional) assert.ok(!manifest.dependencies.some(name => /^hyparquet-writer@/.test(name)), 'fixture writer is development-only');
  const files = await walk(path); assert.ok(!files.some(file => file.includes('/node_modules/'))); assert.ok(!files.some(file => /\.(py|ts)$/.test(file) && !/\.d\.(?:c|m)?ts$/.test(file)));
  const info = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  assert.deepEqual(info.dependencies, {});
  assert.equal(info.name, path === release ? 'ts-backtest' : 'ts-backtest-optional-formats');
  assert.equal(info.license, 'MIT');
  assert.equal(await readFile(join(path, 'LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
  return (await Promise.all(files.map(file => stat(file)))).reduce((n, value) => n + value.size, 0);
}
async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args }); const envelope = response.structuredContent;
  assert.equal(envelope?.ok, true, JSON.stringify(envelope?.error)); return envelope.data;
}
async function complete(client, id) {
  const deadline = Date.now() + 20_000;
  for (;;) { const job = await call(client, 'backtest_job', { jobId: id }); if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(job.state)) { assert.equal(job.state, 'succeeded', JSON.stringify(job.error)); return job; } assert.ok(Date.now() < deadline, 'packaged job timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
try {
  execFileSync('tar', ['-xzf', resolve(root, `dist/package/ts-backtest-${build.version}.tgz`), '-C', temporary]);
  execFileSync('tar', ['-xzf', resolve(root, `dist/package/ts-backtest-optional-formats-${build.version}.tgz`), '-C', temporary]);
  const bytes = { core: await verifyManifest(release), optional: await verifyManifest(optional) };
  const config = JSON.parse(await readFile(join(release, 'examples/basic.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(join(release, 'examples/metadata.json'), 'utf8'));
  const deny = join(temporary, 'deny-network.cjs');
  await writeFile(deny, `const deny=()=>{throw new Error('NETWORK_FORBIDDEN_IN_PACKAGE_SMOKE')};globalThis.fetch=deny;require('node:net').Socket.prototype.connect=deny;for(const n of ['node:http','node:https']){const m=require(n);m.request=deny;m.get=deny;}require('node:dgram').Socket.prototype.send=deny;`);
  const emptyPath = join(temporary, 'empty-path'); await mkdir(emptyPath);
  const env = { ...process.env, NODE_PATH: '', PATH: emptyPath, NODE_TLS_REJECT_UNAUTHORIZED: '1' }; delete env.BACKTEST_FORMAT_ADAPTER;
  // The generated fixture producer is development-only. Production readers receive only bytes.
  const fixtures = join(temporary, 'binary-fixtures'); await mkdir(fixtures);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {tableFromArrays,tableToIPC} from ${JSON.stringify(fileURLToPath(new URL('../optional-formats/node_modules/apache-arrow/Arrow.node.mjs', import.meta.url)))};
    import {parquetWriteBuffer} from ${JSON.stringify(fileURLToPath(new URL('../optional-formats/node_modules/hyparquet-writer/src/node.js', import.meta.url)))};
    import xlsx from ${JSON.stringify(fileURLToPath(new URL('../optional-formats/node_modules/xlsx/xlsx.js', import.meta.url)))};
    import {writeFile} from 'node:fs/promises';
    import {input} from ${JSON.stringify(new URL('../dist/test/helpers.js', import.meta.url).href)};
    const rows=input().bars;const destination=${JSON.stringify(fixtures)};
    await writeFile(destination+'/bars.arrow',tableToIPC(tableFromArrays(Object.fromEntries(Object.keys(rows[0]).map(k=>[k,rows.map(r=>r[k])]))),'file'));
    await writeFile(destination+'/bars.parquet',Buffer.from(parquetWriteBuffer({columnData:Object.keys(rows[0]).map(name=>({name,data:rows.map(r=>r[name]),type:typeof rows[0][name]==='string'?'STRING':typeof rows[0][name]==='boolean'?'BOOLEAN':'DOUBLE'}))})));
    const book=xlsx.utils.book_new();xlsx.utils.book_append_sheet(book,xlsx.utils.json_to_sheet(rows),'Bars');await writeFile(destination+'/bars.xlsx',xlsx.write(book,{type:'buffer',bookType:'xlsx'}));
  `], { cwd: root, encoding: 'utf8', timeout: 20_000 });
  for (const executable of [...new Set(binaries)]) {
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
    const run = args => JSON.parse(execFileSync(executable, ['--require', deny, ...args], { cwd: temporary, env, encoding: 'utf8', timeout: 30_000 }));
    const cli = run([join(release, 'cli.cjs'), 'run', '--config', join(release, 'examples/basic.yaml')]); assert.equal(cli.metrics.finalEquity, '1100.00');
    const esm = run(['--input-type=module', '-e', `import { runBacktest } from ${JSON.stringify(join(release, 'core.cjs'))}; process.stdout.write(JSON.stringify({ callable: typeof runBacktest === 'function' }));`]); assert.equal(esm.callable, true);
    const sdk = run(['-e', `const e=require(${JSON.stringify(join(release, 'core.cjs'))});(async()=>{const dataset=await e.importDataset({path:${JSON.stringify(join(release, 'examples/prices.csv'))},format:'csv',metadata:${JSON.stringify(metadata)}});const result=e.runBacktest(dataset,${JSON.stringify(config.spec)});const sweep=await e.runSweep(dataset,${JSON.stringify(config.spec)},{space:{'/execution/slippage/bps':[0,5]},objective:{metric:'finalEquity',direction:'maximize'},concurrency:2});process.stdout.write(JSON.stringify({equity:result.metrics.finalEquity,candidates:sweep.candidateCount}));})().catch(e=>{console.error(e);process.exitCode=1});`]);
    assert.equal(sdk.equity, '1100.00'); assert.equal(sdk.candidates, 2);
    for (const [command, request, kind] of [['sweep','research-sweep.json','sweep'],['walk-forward','research-walk-forward.json','walk_forward'],['factors','research-factors.json','factors']]) {
      const research = run([join(release,'cli.cjs'),command,'--config',join(release,'examples/research-config.json'),'--request',join(release,'examples',request)]); assert.equal(research.kind,kind);
    }
    const resultFile=join(temporary,`result-${version}.json`),htmlFile=join(temporary,`report-${version}.html`);
    run([join(release,'cli.cjs'),'run','--config',join(release,'examples/basic.json'),'--output',resultFile]);
    const html=run([join(release,'cli.cjs'),'report','--input',resultFile,'--output',htmlFile]);assert.equal(html.mimeType,'text/html');assert.match(await readFile(htmlFile,'utf8'),/<svg/);
    const demo=execFileSync(executable,['--require',deny,join(release,'examples/research-demo.mjs'),join(temporary,`demo-${version}`)],{cwd:temporary,env,encoding:'utf8',timeout:30000}).trim().split('\n').map(value=>JSON.parse(value));assert.equal(demo.filter(value=>value.studyId).length,3);

    for (const format of ['parquet', 'arrow', 'xlsx']) {
      const configPath = join(temporary, `optional-${format}.json`); await writeFile(configPath, JSON.stringify({ dataset: { path: join(fixtures, `bars.${format}`), format, metadata }, spec: config.spec }));
      const converted = run([join(release, 'cli.cjs'), 'run', '--config', configPath, '--formats', join(optional, 'formats.cjs')]); assert.equal(converted.metrics.finalEquity, '1100.00');
    }
    const transport = new StdioClientTransport({ command: executable, args: ['--require', deny, join(release, 'mcp.cjs'), '--workspace', join(release, 'examples'), '--store', join(temporary, `store-${version}`), '--workers', '1'], env, cwd: temporary, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'packaged-offline-smoke', version: '1' });
    try {
      await client.connect(transport); const listed = await client.listTools(); assert.deepEqual(listed.tools.map(tool=>tool.name).sort(),['backtest_capabilities','backtest_prepare_data','backtest_validate','backtest_run','backtest_job','backtest_result','backtest_explain','backtest_sweep','backtest_walk_forward','backtest_factors','backtest_study','backtest_report'].sort());
      const data = await complete(client, (await call(client, 'backtest_prepare_data', { path: 'prices.csv', format: 'csv', metadata })).id);
      const validation = await call(client, 'backtest_validate', { datasetId: data.result.datasetId, spec: config.spec, background: true });
      const plan = (await complete(client, validation.id)).result;
      const job = await complete(client, (await call(client, 'backtest_run', { planId: plan.planId })).id);
      const result = await call(client, 'backtest_result', { runId: job.result.runId }); assert.equal(result.rows[0].metrics.finalEquity, '1100.00');
      const reportHandle = await call(client,'backtest_report',{runId:job.result.runId});assert.equal(reportHandle.mimeType,'text/html');assert.match(await readFile(reportHandle.path,'utf8'),/<svg/);
      const replay = await complete(client, (await call(client, 'backtest_explain', { runId: job.result.runId, at: config.spec.strategy.schedule[0].at, symbol: 'AAA' })).id); assert.equal(replay.result.sourceRunId, job.result.runId);
    } finally { await client.close(); }
    assert.equal(stderr, '', 'production MCP server must not emit module warnings or banners');
    results.push({ researchCliAndDemo: 'passed', reportCliAndMcp: 'passed', mcpToolCount: 12, asynchronousValidation: 'passed', node: version, platform: `${process.platform}-${process.arch}`, cli: 'passed', sdkAndResearchWorker: 'passed', optionalFormats: ['parquet', 'arrow', 'xlsx'], mcpAndRuntimeWorker: 'passed', network: 'blocked', path: 'empty', installedRuntimeDependencies: 0 });
  }
  // The consuming development project supplies Node ambient types; zod/decimal declarations are bundled.
  await writeFile(join(temporary, 'consumer.ts'), `import {importDataset,runBacktest,parseSpec,type ImportDatasetOptions} from './ts-backtest'; async function example(){ const opts:ImportDatasetOptions={path:'bars.csv',format:'csv'}; const data=await importDataset(opts); return runBacktest(data,parseSpec({})).metrics.finalEquity; } void example;`);
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2023', '--skipLibCheck', 'false', '--typeRoots', resolve(root, 'node_modules/@types'), '--types', 'node', join(temporary, 'consumer.ts')], { cwd: temporary, env, encoding: 'utf8', timeout: 30_000 });
  const report = { testedAt: new Date().toISOString(), results, declarations: 'passed without installed Zod/Decimal runtime dependency types; Node types supplied by consumer development environment', verifiedUnpackedBytes: bytes, untested: ['Windows', 'macOS', 'Bun'], note: 'Production files were extracted outside the repository and ran with empty PATH, empty NODE_PATH and network calls blocked. Node executables are supplied separately.' };
  await writeFile(resolve(root, 'dist/package/smoke-report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
