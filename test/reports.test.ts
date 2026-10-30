import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderReport } from '../src/reports/html.js';
import { persistResult, reportArtifact, readManifest } from '../src/runtime/results.js';
import { runBacktest } from '../src/engine/run.js';
import { normalizeDataset } from '../src/data/normalize.js';
import { input, spec } from './helpers.js';
import type { BacktestResult } from '../src/spec/types.js';

const fixture = () => runBacktest(normalizeDataset(input()), spec());
async function store(t: { after(fn: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), 'backtest-report-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('report is self-contained, script-free, and escapes every externally supplied text field', () => {
  const result = fixture();
  const attack = `<img src="https://example.invalid/x" onerror='alert(1)'>&`;
  result.engineVersion = attack; result.datasetHash = attack; result.fingerprint = attack;
  result.spec.datasetId = attack; result.spec.costs.version = attack; result.spec.account.currency = attack;
  result.fills[0]!.symbol = attack; result.fills[0]!.reason = attack; result.fills[0]!.price = attack;
  result.warnings = [{ code: attack, message: attack }];
  result.metrics.unavailable[attack] = attack;
  const html = renderReport(result);
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('&lt;img src=&quot;https://example.invalid/x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;'));
  assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<link\b|<object\b/i);
  assert.match(html, /Content-Security-Policy/);
  assert.equal((html.match(/<svg\b/g) ?? []).length, 2);
});

test('report explicitly rejects unrecorded detail and handles empty and constant series', () => {
  const summary = runBacktest(normalizeDataset(input()), spec({ output: { level: 'summary' } }));
  assert.throws(() => renderReport(summary), { code: 'DETAILS_NOT_RECORDED' });
  const empty = fixture(); empty.equity = []; empty.fills = [];
  const emptyHtml = renderReport(empty);
  assert.match(emptyHtml, /No equity observations were recorded/);
  assert.match(emptyHtml, /No fills were recorded/);
  const flat = fixture();
  flat.equity = flat.equity.map(point => ({ ...point, equity: 1000, unitNav: 1 }));
  const html = renderReport(flat);
  assert.doesNotMatch(html, /(?:NaN|Infinity)/);
  assert.match(html, /data-displayed-points="\d+"/);
  const invalid = fixture(); invalid.equity[0]!.unitNav = NaN;
  assert.throws(() => renderReport(invalid), { code: 'INVALID_REPORT_DATA' });
});

test('display sampling preserves full-series drawdown extrema and never recalculates stored metrics', () => {
  const result = fixture(), point = result.equity[0]!;
  result.equity = Array.from({ length: 20_000 }, (_, i) => ({ ...point, at: point.at + i * 60_000,
    equity: i === 501 ? 1500 : i === 502 ? 500 : 1000, unitNav: i === 501 ? 1.5 : i === 502 ? 0.5 : 1,
  }));
  result.metrics.maxDrawdownPct.value = 2 / 3;
  result.metrics.sharpe = 1.234567890123;
  const original = structuredClone(result);
  const html = renderReport(result);
  assert.deepEqual(result, original, 'rendering cannot mutate result arrays or metric objects');
  assert.match(html, /data-metric="sharpe" data-raw="1\.234567890123"/);
  assert.match(html, /-66\.6667%/);
  const sizes = [...html.matchAll(/data-displayed-points="(\d+)"/g)].map(match => Number(match[1]));
  assert.equal(sizes.length, 2);
  assert.ok(sizes.every(size => size <= 1600 && size < result.equity.length));
  assert.match(html, /20000 recorded observations/);
});

test('incomplete and unverified drawdown coverage qualifies the headline and chart without changing metrics', () => {
  for (const status of ['incomplete', 'unverified'] as const) {
    const result = fixture();
    result.metrics.drawdownCoverage = { ...result.metrics.drawdownCoverage, status };
    const original = structuredClone(result.metrics), html = renderReport(result);
    assert.match(html, new RegExp(`Observed max drawdown · unit NAV · coverage ${status}`));
    assert.match(html, new RegExp(`Observed drawdown only; coverage ${status}\\. This is not verified full-period risk\\.`));
    assert.deepEqual(result.metrics, original);
  }
  const complete = renderReport(fixture());
  assert.doesNotMatch(complete, /Observed max drawdown|not verified full-period risk/);
});

test('fullTrace persistence includes a verified, bounded HTML artifact handle', async t => {
  const root = await store(t), result = fixture();
  const manifest = await persistResult(root, 'run_report', result);
  const report = await reportArtifact(root, 'run_report');
  assert.equal(report.mimeType, 'text/html');
  assert.equal(report.path, join(root, 'runs', 'run_report', 'report.html'));
  const bytes = await readFile(report.path);
  assert.equal(bytes.length, report.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.sha256);
  assert.deepEqual(manifest.artifacts['report.html'], { bytes: report.bytes, sha256: report.sha256 });
  assert.ok(report.bytes < 2 * 1024 * 1024);
});

test('old manifests without reports stay readable and omitted reports raise a specific detail error', async t => {
  const root = await store(t);
  await persistResult(root, 'run_legacy', fixture());
  const path = join(root, 'runs', 'run_legacy');
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  delete manifest.artifacts['report.html'];
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest));
  await unlink(join(path, 'report.html'));
  assert.equal((await readManifest(root, 'run_legacy')).status, 'complete');
  await assert.rejects(reportArtifact(root, 'run_legacy'), { code: 'DETAILS_NOT_RECORDED' });
  const summary = runBacktest(normalizeDataset(input()), spec({ output: { level: 'summary' } }));
  await persistResult(root, 'run_summary', summary);
  await assert.rejects(reportArtifact(root, 'run_summary'), { code: 'DETAILS_NOT_RECORDED' });
});

test('modified, missing, or symlinked HTML artifacts cannot be returned as valid handles', async t => {
  const root = await store(t);
  await persistResult(root, 'run_corrupt', fixture());
  const path = join(root, 'runs', 'run_corrupt', 'report.html');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('Backtest report', 'Backtest REPORT'));
  await assert.rejects(reportArtifact(root, 'run_corrupt'), { code: 'ARTIFACT_INTEGRITY' });
  await unlink(path);
  await assert.rejects(reportArtifact(root, 'run_corrupt'), { code: 'ARTIFACT_MISSING' });
  const outside = join(root, 'outside.html'); await writeFile(outside, text);
  await symlink(outside, path);
  await assert.rejects(reportArtifact(root, 'run_corrupt'), { code: 'UNSAFE_ARTIFACT' });
});

test('HTML output participates in the atomic run byte budget and renderer has its own hard bound', async t => {
  const root = await store(t), result = fixture();
  const manifest = await persistResult(root, 'run_reference', result);
  const withoutReport = Object.entries(manifest.artifacts).filter(([name]) => name !== 'report.html').reduce((sum, [, artifact]) => sum + artifact.bytes, 0);
  await assert.rejects(persistResult(root, 'run_budget', result, { maxBytes: withoutReport + 1 }), { code: 'OUTPUT_BYTE_LIMIT' });
  assert.deepEqual(await readdir(join(root, 'runs')), ['run_reference']);
  const oversized: BacktestResult = structuredClone(result);
  oversized.warnings = [{ code: 'LARGE_WARNING', message: 'x'.repeat(2 * 1024 * 1024) }];
  assert.throws(() => renderReport(oversized), { code: 'REPORT_TOO_LARGE' });
});
