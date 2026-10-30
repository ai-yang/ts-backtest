import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseMcpArguments } from '../src/adapters/mcp.js';
import { createTemplate } from '../src/adapters/templates.js';
import { parseSpec } from '../src/spec/validate.js';
import type { BacktestSpec } from '../src/spec/types.js';
import { input, spec, closeAt, sessions } from './helpers.js';

const serverPath = fileURLToPath(new URL('../src/adapters/mcp.js', import.meta.url));
interface Envelope { ok: boolean; data?: unknown; error?: { code: string; message: string; path: string } }
interface Job { id: string; kind: string; state: string; result?: { datasetId?: string; runId?: string; sourceRunId?: string; explanation?: unknown; planId?: string; resolvedSpec?: BacktestSpec }; error?: unknown }

function unpack(result: unknown): Envelope {
  const value = result as CallToolResult;
  assert.ok(value.structuredContent && typeof value.structuredContent === 'object');
  const text = value.content.find(item => item.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.deepEqual(JSON.parse(text.text), value.structuredContent, 'text and structured content must agree');
  assert.equal(value.isError === true, value.structuredContent.ok === false);
  return value.structuredContent as unknown as Envelope;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = unpack(await client.callTool({ name, arguments: args }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data as T;
}

async function waitJob(client: Client, id: string): Promise<Job> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const job = await call<Job>(client, 'backtest_job', { jobId: id });
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(job.state)) return job;
    assert.ok(Date.now() < deadline, `job ${id} did not complete`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'backtest-mcp-'));
  const errors: Error[] = [];
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [serverPath, '--workspace', dir, '--store', join(dir, '.store'), '--workers', '1'], stderr: 'pipe', cwd: dir,
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'backtest-mcp-acceptance', version: '1' });
  client.onerror = error => errors.push(error);
  t.after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'server stdout must contain only valid MCP protocol messages');
    assert.equal(stderr, '', 'server should not emit startup banners or unexpected errors');
  });
  await client.connect(transport);
  await writeFile(join(dir, 'bars.jsonl'), input().bars.map(bar => JSON.stringify(bar)).join('\n'));
  return { client, dir };
}

async function prepare(client: Client): Promise<string> {
  const handle = await call<Job>(client, 'backtest_prepare_data', { path: 'bars.jsonl', format: 'jsonl', metadata: input().metadata });
  assert.ok(handle.id);
  const complete = await waitJob(client, handle.id);
  assert.equal(complete.state, 'succeeded', JSON.stringify(complete.error));
  assert.ok(complete.result?.datasetId);
  return complete.result.datasetId;
}

async function run(client: Client, datasetId: string, configuration: BacktestSpec = spec()): Promise<string> {
  const validated = await call<{ planId: string; resolvedSpec: BacktestSpec;
    estimates: { inputBars: number; evaluationBars: number; warmupBars: number; estimatedColumnBytes: number; warmupRange: unknown; note: string };
  }>(client, 'backtest_validate', { datasetId, spec: configuration });
  assert.ok(validated.planId);
  assert.equal(validated.resolvedSpec.datasetId, datasetId);
  assert.equal(validated.estimates.inputBars, input().bars.length);
  assert.ok(validated.estimates.evaluationBars > 0);
  assert.ok(validated.estimates.estimatedColumnBytes > 0);
  assert.equal(typeof validated.estimates.note, 'string');
  const job = await call<Job>(client, 'backtest_run', { planId: validated.planId });
  const complete = await waitJob(client, job.id);
  assert.equal(complete.state, 'succeeded', JSON.stringify(complete.error));
  assert.ok(complete.result?.runId);
  return complete.result.runId;
}

test('MCP official SDK discovers all engine and research tools with input and output schemas', async t => {
  const { client } = await fixture(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'backtest_capabilities', 'backtest_prepare_data', 'backtest_validate', 'backtest_run', 'backtest_job', 'backtest_result', 'backtest_explain',
    'backtest_sweep', 'backtest_walk_forward', 'backtest_factors', 'backtest_study', 'backtest_report',
  ].sort());
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema?.type, 'object');
    assert.ok(Array.isArray(tool.outputSchema?.anyOf), 'success and error envelopes must be mutually exclusive');
  }
  const runOutput = listed.tools.find(tool => tool.name === 'backtest_run')!.outputSchema!;
  assert.ok(JSON.stringify(runOutput).includes('cancel_requested'), 'job states must be discoverable in the output schema');
  const resultOutput = listed.tools.find(tool => tool.name === 'backtest_result')!.outputSchema!;
  assert.ok(JSON.stringify(resultOutput).includes('matchedRows'), 'page output must declare its pagination fields');
  const info = await call<{ formats: string[]; modes: string[] }>(client, 'backtest_capabilities');
  assert.deepEqual(info.formats, ['csv', 'jsonl', 'json']);
  assert.ok(info.modes.includes('replay'));
  const schema = await call<{ schema: { type: string } }>(client, 'backtest_capabilities', { category: 'schema', name: 'spec' });
  assert.equal(schema.schema.type, 'object');
});

test('MCP background validation exposes its job and returns a usable plan through polling', async t => {
  const { client } = await fixture(t), datasetId = await prepare(client);
  const handle = await call<Job>(client, 'backtest_validate', { datasetId, spec: spec(), background: true });
  assert.equal(handle.kind, 'validate'); assert.match(handle.id, /^job_/);
  assert.ok(['queued', 'running'].includes(handle.state)); assert.equal(handle.result, undefined);
  const completed = await waitJob(client, handle.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.error));
  assert.match(completed.result!.planId!, /^plan_/);
  assert.equal(completed.result!.resolvedSpec!.datasetId, datasetId);
  const run = await waitJob(client, (await call<Job>(client, 'backtest_run', { planId: completed.result!.planId })).id);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
});

test('MCP complete prepare→validate→run→result→explain workflow uses real workers', async t => {
  const { client } = await fixture(t);
  const datasetId = await prepare(client);
  const runId = await run(client, datasetId);
  const summary = await call<{ rows: unknown[]; table: string }>(client, 'backtest_result', { runId });
  assert.equal(summary.table, 'summary');
  assert.equal(summary.rows.length, 1);
  const report = await call<{ path: string; sha256: string; bytes: number; mimeType: string }>(client, 'backtest_report', { runId });
  assert.equal(report.mimeType, 'text/html');
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.ok(JSON.stringify(report).length < 2048, 'report tool returns an artifact handle, not the HTML body');
  assert.equal((await readFile(report.path)).length, report.bytes);
  const first = await call<{ rows: { id: string; price: string }[]; nextCursor: string | null }>(client, 'backtest_result', { runId, table: 'fills', limit: 1 });
  assert.equal(first.rows.length, 1);
  assert.equal(typeof first.rows[0]!.price, 'string');
  assert.ok(first.nextCursor);
  const next = await call<{ rows: { id: string }[] }>(client, 'backtest_result', { runId, table: 'fills', limit: 1, cursor: first.nextCursor });
  assert.equal(next.rows.length, 1);
  assert.notEqual(next.rows[0]!.id, first.rows[0]!.id);
  const explanationJob = await call<Job>(client, 'backtest_explain', { runId, fillId: first.rows[0]!.id });
  const explained = await waitJob(client, explanationJob.id);
  assert.equal(explained.state, 'succeeded', JSON.stringify(explained.error));
  assert.ok(explained.result?.explanation);
  assert.ok(JSON.stringify(explained.result.explanation).includes(first.rows[0]!.id));
});

test('MCP templates generate only strategy and require explicit finance inputs', async t => {
  const { client } = await fixture(t);
  const templates = await call<{ templates: { name: string }[] }>(client, 'backtest_capabilities', { category: 'templates' });
  assert.ok(templates.templates.some(template => template.name === 'rsi_threshold'));
  const generated = await call<{ strategy: BacktestSpec['strategy']; executableSpec: boolean }>(client, 'backtest_capabilities', {
    category: 'templates', name: 'sma_cross', parameters: { fast: 2, slow: 3, quantity: 10 },
  });
  assert.equal(generated.executableSpec, false);
  assert.equal(generated.strategy.kind, 'rules');
  assert.equal(parseSpec(spec({ strategy: generated.strategy })).strategy.kind, 'rules');
  const missing = unpack(await client.callTool({ name: 'backtest_capabilities', arguments: { category: 'templates', name: 'sma_cross', parameters: { fast: 2, slow: 3 } } }));
  assert.equal(missing.error?.code, 'INVALID_TEMPLATE_PARAMETERS');
});

test('MCP explanation of summary output replays the original complete range', async t => {
  const { client } = await fixture(t);
  const datasetId = await prepare(client);
  const runId = await run(client, datasetId, spec({ output: { level: 'summary' } }));
  const absentReport = unpack(await client.callTool({ name: 'backtest_report', arguments: { runId } }));
  assert.equal(absentReport.error?.code, 'DETAILS_NOT_RECORDED');
  const handle = await call<Job>(client, 'backtest_explain', { runId, at: closeAt(sessions[2]!), symbol: 'AAA' });
  const explained = await waitJob(client, handle.id);
  assert.equal(explained.state, 'succeeded', JSON.stringify(explained.error));
  assert.equal(explained.result?.sourceRunId, runId);
  assert.ok(explained.result?.runId && explained.result.runId !== runId);
  assert.ok(explained.result.explanation);
  const source = await call<{ rows: unknown[] }>(client, 'backtest_result', { runId });
  const replay = await call<{ rows: unknown[] }>(client, 'backtest_result', { runId: explained.result.runId });
  assert.deepEqual((replay.rows[0] as { metrics: unknown }).metrics, (source.rows[0] as { metrics: unknown }).metrics,
    'explanation replay must preserve complete-range metrics and original account state');
});

test('MCP native frames prepare through workers and survive the cached execution path', async t => {
  const { client, dir } = await fixture(t);
  const configuration = JSON.parse(await readFile(new URL('../../examples/frames.json', import.meta.url), 'utf8')) as {
    dataset: Record<string, unknown>; spec: BacktestSpec;
  };
  await writeFile(join(dir, 'frames-bars.jsonl'), await readFile(new URL('../../examples/frames-bars.jsonl', import.meta.url)));
  const preparing = await call<Job>(client, 'backtest_prepare_data', configuration.dataset);
  const prepared = await waitJob(client, preparing.id);
  assert.equal(prepared.state, 'succeeded', JSON.stringify(prepared.error));
  const plan = await call<{ planId: string }>(client, 'backtest_validate', { datasetId: prepared.result!.datasetId!, spec: configuration.spec });
  const running = await call<Job>(client, 'backtest_run', { planId: plan.planId });
  const complete = await waitJob(client, running.id);
  assert.equal(complete.state, 'succeeded', JSON.stringify(complete.error));
  const summary = await call<{ rows: { metrics: { finalEquity: string; fillCount: number } }[] }>(client, 'backtest_result', { runId: complete.result!.runId! });
  assert.equal(summary.rows[0]!.metrics.finalEquity, '1010.00');
  assert.equal(summary.rows[0]!.metrics.fillCount, 2);
});

test('MCP argument, semantic and path failures preserve machine-readable errors', async t => {
  const { client } = await fixture(t);
  const extra = unpack(await client.callTool({ name: 'backtest_capabilities', arguments: { typo: true } }));
  assert.equal(extra.error?.code, 'INVALID_TOOL_ARGUMENTS');
  const missing = unpack(await client.callTool({ name: 'backtest_run', arguments: {} }));
  assert.equal(missing.error?.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(missing.error?.path, '/planId');
  const outside = unpack(await client.callTool({ name: 'backtest_prepare_data', arguments: { path: '../outside.jsonl', format: 'jsonl', metadata: input().metadata } }));
  assert.equal(outside.ok, false);
  assert.ok(outside.error?.code);
  const datasetId = await prepare(client);
  const invalid = { ...spec(), account: { ...spec().account, initialCash: 1000 } };
  const result = unpack(await client.callTool({ name: 'backtest_validate', arguments: { datasetId, spec: invalid } }));
  assert.equal(result.error?.code, 'INVALID_SPEC');
  assert.equal(result.error?.path, '/account/initialCash');
  const leverage = unpack(await client.callTool({ name: 'backtest_validate', arguments: { datasetId, spec: { ...spec(), leverage: 2 } } }));
  assert.equal(leverage.error?.code, 'INVALID_SPEC');
});

test('MCP input bounds reject oversized result pages before artifact access', async t => {
  const { client } = await fixture(t);
  const result = unpack(await client.callTool({ name: 'backtest_result', arguments: { runId: 'does-not-exist', table: 'fills', limit: 201 } }));
  assert.equal(result.error?.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(result.error?.path, '/limit');
  for (const selection of [{}, { at: 0, fillId: 'f1' }, { fillId: 'f1', symbol: 'AAA' }]) {
    const explanation = unpack(await client.callTool({ name: 'backtest_explain', arguments: { runId: 'does-not-exist', ...selection } }));
    assert.equal(explanation.error?.code, 'INVALID_TOOL_ARGUMENTS');
  }
  const oversized = unpack(await client.callTool({ name: 'backtest_validate', arguments: {
    datasetId: 'does-not-exist', spec: { ...spec(), oversized: 'x'.repeat(1024 * 1024) },
  } }));
  assert.equal(oversized.error?.code, 'MCP_SPEC_TOO_LARGE');
  assert.equal(oversized.error?.path, '/spec');
});

test('MCP rejects deep inputs and bounds oversized error messages without a secondary failure', async t => {
  const { client } = await fixture(t);
  let nested: unknown = { value: true };
  for (let i = 0; i < 100; i++) nested = { child: nested };
  const deep = unpack(await client.callTool({ name: 'backtest_capabilities', arguments: { category: 'templates', name: 'sma_cross', parameters: nested } }));
  assert.equal(deep.error?.code, 'TOOL_INPUT_TOO_DEEP');
  const key = 'x'.repeat(3 * 1024 * 1024);
  const huge = await client.callTool({ name: 'backtest_capabilities', arguments: { [key]: true } });
  const error = unpack(huge);
  assert.equal(error.error?.code, 'INVALID_TOOL_ARGUMENTS');
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) < 128 * 1024, 'both text and structured error remain bounded');
  const info = await call<{ engineVersion: string }>(client, 'backtest_capabilities');
  assert.ok(info.engineVersion, 'malformed input must not break the following valid call');
});

test('MCP remains responsive while a prepare worker is busy and cancellation is explicit', async t => {
  const { client, dir } = await fixture(t);
  const data = input();
  const count = 20_000;
  const first = Date.parse('2000-01-01T00:00:00Z');
  data.metadata.sessions = [];
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(first + i * 86_400_000).toISOString().slice(0, 10);
    data.metadata.sessions.push(day);
    rows.push(JSON.stringify({ ...data.bars[0], session: day, openTime: first + i * 86_400_000 + 5_400_000,
      closeTime: first + i * 86_400_000 + 25_200_000 }));
  }
  await writeFile(join(dir, 'large.jsonl'), rows.join('\n'));
  const handle = await call<Job>(client, 'backtest_prepare_data', { path: 'large.jsonl', format: 'jsonl', metadata: data.metadata });
  const started = Date.now();
  const info = await call<{ engineVersion: string }>(client, 'backtest_capabilities');
  assert.ok(info.engineVersion);
  assert.ok(Date.now() - started < 2000, 'main protocol loop must not execute the dataset parse');
  const canceled = await call<Job>(client, 'backtest_job', { jobId: handle.id, action: 'cancel' });
  assert.ok(['cancel_requested', 'canceled', 'succeeded'].includes(canceled.state));
  const final = await waitJob(client, handle.id);
  assert.ok(['canceled', 'succeeded'].includes(final.state));
});

test('MCP startup flags and strategy template constraints fail deterministically', () => {
  assert.throws(() => parseMcpArguments(['--workers', '0']), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => parseMcpArguments(['--workers', '2', '--workers', '3']), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => createTemplate('sma_cross', { fast: 5, slow: 2, quantity: 10 }), { code: 'INVALID_TEMPLATE_PARAMETERS' });
  assert.throws(() => createTemplate('rsi_threshold', { period: 14, oversold: 70, overbought: 30, quantity: 1 }), { code: 'INVALID_TEMPLATE_PARAMETERS' });
  assert.throws(() => createTemplate('buy_and_hold', { quantity: 10, symbols: ['AAA', 'AAA'] }), { code: 'INVALID_TEMPLATE_PARAMETERS' });
  assert.equal(createTemplate('rank_feature', { feature: 'value', topK: 5, descending: false, rebalanceEvery: 1,
    rebalanceUnit: 'month', weighting: 'equal', grossWeight: 0.8 }).kind, 'rank');
  assert.equal(createTemplate('buy_and_hold', { quantity: 10 }).kind, 'rules');
});
