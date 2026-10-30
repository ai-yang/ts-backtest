// Run after the final test, optional-format, package and actual Codex gates.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
const root = resolve(import.meta.dirname, '..'), evidence = resolve(root, 'docs/evidence');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
async function files(path) {
  const result = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const name = resolve(path, item.name);
    if (item.isDirectory()) result.push(...await files(name));
    else if (item.isFile()) result.push(name);
  }
  return result.sort();
}
const source = {};
for (const file of await files(resolve(root, 'src'))) source[relative(root, file)] = hash(await readFile(file));
const tests = await readFile(resolve(evidence, 'stage4-tests.log'), 'utf8');
const optional = await readFile(resolve(evidence, 'optional-tests.log'), 'utf8');
const checked = await readFile(resolve(evidence, 'typecheck.log'), 'utf8');
const stats = text => {
  const count = Number(text.match(/\btests (\d+)/)?.[1]), passed = Number(text.match(/\bpass (\d+)/)?.[1]);
  assert.ok(count > 0); assert.equal(passed, count); assert.match(text, /\bfail 0\b/);
  return { count, passed };
};
const coreTests = stats(tests), optionalTests = stats(optional);
assert.match(checked, /TYPECHECK_PASSED/);
const size = await json('dist/package/size-report.json'), smoke = await json('dist/package/smoke-report.json');
const benchmark = await json('docs/evidence/benchmark.json'), finalHot = await json('docs/evidence/benchmark-final-hot.json');
assert.equal(benchmark.complete, true); assert.equal(benchmark.quick, false); assert.equal(finalHot.complete, true);
for (const measurement of [benchmark, finalHot]) for (const item of measurement.cases)
  for (const stage of Object.values(item.stages)) assert.ok(stage.count >= 5, `Insufficient normal samples in ${item.id}`);
const codex = await json('docs/evidence/codex-package-smoke-verified.json');
assert.equal(codex.passed, true); assert.equal(codex.toolNames.length, 12);
assert.equal(codex.serverSha256, hash(await readFile(resolve(root, 'dist/package/ts-backtest/mcp.cjs'))));
assert.ok(smoke.results.some(r => r.node.startsWith('v22.'))); assert.ok(smoke.results.some(r => r.node.startsWith('v24.')));
const packages = [];
for (const item of size.distributions) packages.push({ ...item, sha256: hash(await readFile(resolve(root, item.archive))) });
const report = { schemaVersion: '1', createdAt: new Date().toISOString(), sourceTreeSha256: hash(JSON.stringify(source)), sourceFiles: source,
  sourceLockSha256: hash(await readFile(resolve(root, 'package-lock.json'))), optionalLockSha256: hash(await readFile(resolve(root, 'optional-formats/package-lock.json'))),
  environment: { node: process.version, os: release(), platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  gates: { coreTests, optionalTests, typecheck: 'passed', productionPackage: smoke, codex,
    benchmarks: { completeWorkloadCases: benchmark.cases.length, finalRevisionHotCases: finalHot.cases.length, samplesPerNormalStage: 5 } }, packages,
  evidence: { testLogSha256: hash(tests), optionalTestLogSha256: hash(optional), benchmarkSha256: hash(await readFile(resolve(evidence, 'benchmark.json'))), finalHotBenchmarkSha256: hash(await readFile(resolve(evidence, 'benchmark-final-hot.json'))) },
  commands: ['npm test', 'npm run check', 'npm run test:optional', 'node scripts/benchmark.mjs --samples=5', 'npm run package', 'npm run test:package', 'node scripts/codex-package-smoke.mjs', 'node scripts/verify-codex-package-smoke.mjs', 'node scripts/release-evidence.mjs'],
  limitations: ['Synthetic engineering fixtures; no real-user strategy coverage claim', 'Linux x64 Node 22/24 verified; Windows/macOS/Bun unverified', 'zwork host source unavailable and outside this acceptance; actual Codex MCP used as requested', 'Performance measurements use stated fixture, output mode, phase and revision; see PERFORMANCE.md'] };
await writeFile(resolve(evidence, 'release.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify({ coreTests, optionalTests, packages, codexCalls: codex.completedCalls, sourceTreeSha256: report.sourceTreeSha256 }, null, 2) + '\n');
