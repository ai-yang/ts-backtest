#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BacktestService } from '../runtime/manager.js';
import { queryResult, reportArtifact } from '../runtime/results.js';
import { sweepRequestSchema } from '../research/sweep.js';
import { walkForwardRequestSchema } from '../research/walk-forward.js';
import { factorRequestSchema } from '../research/factors.js';
import { ENGINE_VERSION } from '../engine/run.js';
import { backtestSpecSchema, datasetMetadataSchema, framesPreparationSchema } from '../spec/schema.js';
import { assertThat, BacktestError, errorJSON } from '../spec/errors.js';
import { setFormatAdapter, type ImportDatasetOptions } from '../data/import.js';
import { capabilities } from './capabilities.js';

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const decimal = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/);
const errorSchema = z.strictObject({ code: z.string(), message: z.string(), path: z.string(),
  details: z.record(z.string(), z.unknown()), retryable: z.boolean(),
});
function outputSchema(data: z.ZodType) {
  return z.strictObject({ ok: z.boolean(), data: data.optional(), error: errorSchema.optional() })
    .superRefine((value, context) => {
      if (value.ok ? value.data === undefined || value.error !== undefined : value.error === undefined || value.data !== undefined)
        context.addIssue({ code: 'custom', message: 'Success requires data; failure requires error, exclusively' });
    }).meta({ anyOf: [
      { properties: { ok: { const: true } }, required: ['data'], not: { required: ['error'] } },
      { properties: { ok: { const: false } }, required: ['error'], not: { required: ['data'] } },
    ] });
}
const jobSchema = z.strictObject({ id: identifier, kind: z.enum(['prepare', 'validate', 'run', 'explain', 'sweep', 'walk_forward', 'factors']),
  state: z.enum(['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'canceled', 'interrupted']),
  createdAt: z.string(), updatedAt: z.string(),
  progress: z.strictObject({ stage: z.string(), done: z.number().optional(), total: z.number().optional() }).optional(),
  result: z.record(z.string(), z.unknown()).optional(), error: errorSchema.optional(),
  cancellation: z.strictObject({ accepted: z.boolean(), reason: z.string().optional() }).optional(),
});
const validationSchema = z.strictObject({ planId: identifier, datasetId: identifier, resolvedSpec: backtestSpecSchema,
  warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), path: z.string().optional(), count: z.number().optional() })),
  estimates: z.strictObject({ warmupBars: z.number().int().nonnegative(), inputBars: z.number().int().nonnegative(),
    evaluationBars: z.number().int().nonnegative(), estimatedColumnBytes: z.number().int().nonnegative(),
    warmupRange: z.strictObject({ start: timestamp, end: timestamp }).nullable(), note: z.string(),
  }),
});
const pageSchema = z.strictObject({ runId: identifier, table: z.enum(['summary', 'orders', 'fills', 'events', 'equity', 'trace']),
  rows: z.array(z.record(z.string(), z.unknown())).max(200), nextCursor: z.string().nullable(),
  totalRows: z.number().int().nonnegative(), matchedRows: z.number().int().nonnegative(),
});
const columns = z.strictObject({ symbol: identifier.optional(), openTime: identifier.optional(), closeTime: identifier.optional(), session: identifier.optional(),
  open: identifier.optional(), high: identifier.optional(), low: identifier.optional(), close: identifier.optional(),
  volume: identifier.optional(), amount: identifier.optional(), tradable: identifier.optional(), limitUp: identifier.optional(), limitDown: identifier.optional(),
});
const prepareSchema = z.strictObject({ path: z.string().min(1).max(4096), format: z.enum(['csv', 'jsonl', 'json', 'parquet', 'arrow', 'xlsx']),
  metadata: datasetMetadataSchema.optional(), columns: columns.optional(),
  frames: framesPreparationSchema.optional(), formatOptions: z.strictObject({ sheet: z.string().min(1).max(128).optional() }).optional(),
  maxRows: z.number().int().min(1).max(100_000_000).optional(),
  maxFileBytes: z.number().int().min(1).max(2_147_483_648).optional(),
  maxRecordBytes: z.number().int().min(1).max(16 * 1024 * 1024).optional(),
  features: z.array(z.strictObject({ symbol: identifier, name: identifier, availableAt: timestamp, value: z.number().finite().nullable() })).optional(),
  membership: z.array(z.strictObject({ symbol: identifier, availableAt: timestamp, member: z.boolean() })).optional(),
  actions: z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('split'), symbol: identifier, at: timestamp, ratio: decimal, cashInLieuPrice: decimal.optional(), sequence: z.number().int().nonnegative().optional() }),
    z.strictObject({ type: z.literal('dividend'), symbol: identifier, at: timestamp, payAt: timestamp, amountPerShare: decimal, sequence: z.number().int().nonnegative().optional() }),
    z.strictObject({ type: z.literal('delist'), symbol: identifier, at: timestamp, cashPrice: decimal, sequence: z.number().int().nonnegative().optional() }),
  ])).optional(),
});

const resultSchema = z.strictObject({ runId: identifier,
  table: z.enum(['summary', 'orders', 'fills', 'events', 'equity', 'trace']).default('summary'),
  limit: z.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(4096).optional(),
  fields: z.array(z.string().min(1).max(80)).min(1).max(32).optional(),
  filter: z.record(z.string().min(1).max(80), z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()])).optional(),
  from: timestamp.optional(), to: timestamp.optional(),
});
const explainSchema = z.strictObject({ runId: identifier, orderId: identifier.optional(), fillId: identifier.optional(), at: timestamp.optional(), symbol: identifier.optional() })
  .superRefine((query, context) => {
    if ([query.orderId, query.fillId, query.at].filter(value => value !== undefined).length !== 1)
      context.addIssue({ code: 'custom', message: 'Choose exactly one orderId, fillId or at' });
    if (query.symbol !== undefined && query.at === undefined)
      context.addIssue({ code: 'custom', path: ['symbol'], message: 'symbol applies only to at explanations' });
  });

export interface McpOptions { workspace: string; storeDir: string; concurrency?: number; formats?: string }

/** Bound structure before JSON serialization or any recursive Zod schema runs. */
function inspectToolInput(raw: unknown): void {
  let count = 0;
  const ancestors = new WeakSet<object>();
  function visit(value: unknown, depth: number): void {
    assertThat(depth <= 64, 'TOOL_INPUT_TOO_DEEP', 'Tool input nesting exceeds 64 levels');
    assertThat(++count <= 500_000, 'TOOL_INPUT_TOO_LARGE', 'Tool input exceeds 500000 structural values');
    if (value === null || typeof value !== 'object') return;
    assertThat(!ancestors.has(value), 'CYCLIC_INPUT', 'Tool input contains a cyclic object');
    ancestors.add(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
    ancestors.delete(value);
  }
  visit(raw, 0);
  assertThat(Buffer.byteLength(JSON.stringify(raw ?? {})) <= 8 * 1024 * 1024,
    'TOOL_INPUT_TOO_LARGE', 'Tool input exceeds 8 MiB; reference an on-disk dataset instead');
}

/** Error handling must itself remain serializable and within a fixed budget. */
function failureResponse(failure: unknown): CallToolResult {
  let error: ReturnType<typeof errorJSON>;
  try {
    const original = errorJSON(failure);
    let values = 0;
    const seen = new WeakSet<object>();
    function bounded(value: unknown, depth: number): unknown {
      if (++values > 1000 || depth > 8) return '[truncated]';
      if (typeof value === 'string') return value.slice(0, 2048);
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value !== 'object' || seen.has(value)) return '[unavailable]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 64).map(child => bounded(child, depth + 1));
      return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, child]) => [key.slice(0, 128), bounded(child, depth + 1)]));
    }
    error = { code: String(original.code).slice(0, 128), message: String(original.message).slice(0, 4096),
      path: String(original.path).slice(0, 2048), details: bounded(original.details, 0) as Record<string, unknown>, retryable: original.retryable === true };
    if (Buffer.byteLength(JSON.stringify(error.details)) > 64 * 1024) error.details = { truncated: true };
  } catch {
    error = { code: 'INTERNAL_ERROR', message: 'Error details could not be encoded safely', path: '', details: {}, retryable: false };
  }
  const envelope = { ok: false, error };
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: true };
}

function response(data: unknown, schema: ReturnType<typeof outputSchema>): CallToolResult {
  try {
    const envelope = { ok: true, data };
    assertThat(schema.safeParse(envelope).success, 'INVALID_TOOL_OUTPUT', 'Tool returned an invalid output shape');
    const text = JSON.stringify(envelope);
    assertThat(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'TOOL_OUTPUT_TOO_LARGE', 'Tool output exceeds 2 MiB; request fewer rows or fields');
    return { content: [{ type: 'text', text }], structuredContent: envelope };
  } catch (error) { return failureResponse(error); }
}

/** Register real SDK tools, using one dispatch boundary for typed error envelopes. */
export async function createMcpServer(options: McpOptions): Promise<{ server: McpServer; service: BacktestService; close: () => Promise<void> }> {
  if (options.formats) setFormatAdapter(options.formats);
  const service = new BacktestService(options);
  await service.init();
  const server = new McpServer({ name: 'ts-backtest', version: ENGINE_VERSION });
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();

  function register<S extends z.ZodType>(name: string, description: string, inputSchema: S,
    action: (args: z.output<S>) => unknown | Promise<unknown>, readOnly: boolean, runtimeSchema: z.ZodType = inputSchema,
    dataSchema: z.ZodType = z.record(z.string(), z.unknown())): void {
    const resultSchema = outputSchema(dataSchema);
    const handler = async (raw: unknown): Promise<CallToolResult> => {
      try {
        inspectToolInput(raw);
        const parsed = runtimeSchema.safeParse(raw ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0]!;
          throw new BacktestError('INVALID_TOOL_ARGUMENTS', issue.message, '/' + issue.path.join('/'), { issues: parsed.error.issues.slice(0, 20) });
        }
        return response(await action(parsed.data as z.output<S>), resultSchema);
      } catch (error) { return failureResponse(error); }
    };
    handlers.set(name, handler);
    server.registerTool<typeof resultSchema, z.ZodType>(name, { description, inputSchema, outputSchema: resultSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
    }, handler);
  }

  register('backtest_capabilities', 'Discover supported engine behavior, JSON schemas, operator contracts, and strategy templates. Templates generate strategy only; all financial parameters stay explicit.',
    z.strictObject({ category: z.enum(['summary', 'schema', 'operators', 'templates']).default('summary'), name: identifier.optional(), parameters: z.unknown().optional() }),
    args => capabilities(args), true);
  register('backtest_prepare_data', 'Prepare a local immutable dataset in a background worker. CSV/JSONL/JSON are built in; Parquet/Arrow/XLSX require a host-configured adapter. Optional frames aggregate completed native higher bars and publish as-of indicators. Paths stay inside the workspace. Poll the returned job for datasetId.',
    prepareSchema, args => service.prepare(args as ImportDatasetOptions), false, undefined, jobSchema);
  register('backtest_validate', 'Validate an explicit specification of at most 1 MiB against a prepared dataset and create an immutable plan. Set background:true for large data or a busy queue: immediately returns a validation job; poll backtest_job for planId, resolvedSpec, work estimates and diagnostics. Default background:false waits for that same result. This does not run a backtest.',
    z.strictObject({ datasetId: identifier, spec: backtestSpecSchema, background: z.boolean().default(false) }),
    args => {
      assertThat(Buffer.byteLength(JSON.stringify(args.spec)) <= 1024 * 1024, 'MCP_SPEC_TOO_LARGE',
        'MCP specifications are limited to 1 MiB so the complete resolved specification fits in the response', '/spec', { maxSpecBytes: 1024 * 1024 });
      return args.background ? service.validateJob(args.datasetId, args.spec) : service.validate(args.datasetId, args.spec);
    }, false,
    // Core parseSpec performs bounded recursion and semantic validation itself.
    z.strictObject({ datasetId: identifier, spec: z.unknown(), background: z.boolean().default(false) }), z.union([validationSchema, jobSchema]));
  register('backtest_run', 'Enqueue a validated plan and immediately return a job handle. Poll backtest_job; completed jobs identify a persisted run for backtest_result.',
    z.strictObject({ planId: identifier }), args => service.run(args.planId), false, undefined, jobSchema);
  register('backtest_job', 'Read or cancel a prepare, validate, run, explain, sweep, walk-forward or factor job. Cancellation is cooperative/worker-bounded and canceled work is never published as a successful result.',
    z.strictObject({ jobId: identifier, action: z.enum(['status', 'cancel']).default('status') }),
    args => service.job(args.jobId, args.action), false, undefined, jobSchema);
  register('backtest_result', 'Read a bounded page from a completed run. Summary is one row; detailed tables depend on the run output level. Cursors are tied to the same run, table and query.',
    resultSchema, ({ runId, ...query }) => queryResult(options.storeDir, runId, query), true, undefined, pageSchema);
  register('backtest_explain', 'Enqueue an evidence-based explanation and return a job handle. Choose exactly one orderId, fillId or at; symbol narrows timestamp lookup. If trace was not retained, replay the original complete range with the original data/spec/seed and record replay provenance. Poll backtest_job for the explanation.',
    explainSchema, ({ runId, ...query }) => service.explain(runId, query), false, undefined, jobSchema);
  register('backtest_sweep', 'Enqueue a bounded parameter grid over one validated plan. JSON pointer paths vary existing scalar parameters. Independent workers share immutable data; candidate seeds and result ordering are deterministic. Poll the job for a studyId.',
    z.strictObject({ planId: identifier, request: sweepRequestSchema }), args => service.sweep(args.planId, args.request), false, undefined, jobSchema);
  register('backtest_walk_forward', 'Enqueue rolling or expanding training-only selection, followed by one continuous out-of-sample account. Supports rules strategies with strategy scalar parameters, all-prior warmup and carried positions/pending orders. Poll for studyId and the continuous runId.',
    z.strictObject({ planId: identifier, request: walkForwardRequestSchema }), args => service.walkForward(args.planId, args.request), false, undefined, jobSchema);
  register('backtest_factors', 'Evaluate as-of external factor values against bounded forward-return labels: IC, rank IC and group returns. These are research diagnostics, not simulated investable returns. Labels outside the interval or across corporate actions are excluded.',
    z.strictObject({ datasetId: identifier, request: factorRequestSchema }), args => service.factors(args.datasetId, args.request), false, undefined, jobSchema);
  register('backtest_study', 'Read a bounded, integrity-checked page of research summary, candidates, walk-forward windows, factor periods or order-to-window attribution. A study handle is distinct from a backtest run handle.',
    z.strictObject({ studyId: identifier, table: z.enum(['summary', 'candidates', 'windows', 'periods', 'orderWindows']).default('summary'),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(4096).optional(),
      fields: z.array(z.string().min(1).max(128)).min(1).max(32).optional(), filter: z.record(z.string().max(128), z.union([z.string().max(1024), z.number().finite(), z.null()])).optional(),
      from: timestamp.optional(), to: timestamp.optional() }),
    ({ studyId, ...query }) => service.study(studyId, query), true, undefined,
    z.strictObject({ studyId: identifier, table: z.enum(['summary', 'candidates', 'windows', 'periods', 'orderWindows']), rows: z.array(z.record(z.string(), z.unknown())).max(200), nextCursor: z.string().nullable(), totalRows: z.number().int().nonnegative(), matchedRows: z.number().int().nonnegative() }));
  register('backtest_report', 'Return the verified local HTML/SVG report artifact for a fullTrace run. The standalone report has no external scripts or network dependencies. Summary/trades runs without a report require a fullTrace rerun.',
    z.strictObject({ runId: identifier }), args => reportArtifact(options.storeDir, args.runId), true, undefined,
    z.strictObject({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative(), mimeType: z.literal('text/html') }));

  // The SDK default tools/call path turns argument errors into text-only output.
  // Use its public protocol handler to keep every tool failure machine-readable.
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.task) return failureResponse(new BacktestError('TASKS_NOT_SUPPORTED', 'Use backtest_job handles rather than MCP experimental tasks'));
    const handler = handlers.get(request.params.name);
    if (!handler) return failureResponse(new BacktestError('UNKNOWN_TOOL', `Unknown tool ${request.params.name}`, '/name'));
    return handler(request.params.arguments);
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await service.close(); await server.close(); })();
  return { server, service, close };
}

export function parseMcpArguments(argv: string[]): McpOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    assertThat(key !== undefined && ['--workspace', '--store', '--workers', '--formats'].includes(key) && value !== undefined && !value.startsWith('--') && !flags.has(key),
      'INVALID_ARGUMENTS', 'Expected unique --workspace path, --store path, --workers count, or --formats adapter-path flags');
    flags.set(key!, value!);
  }
  const workspace = resolve(flags.get('--workspace') ?? process.cwd());
  const storeDir = resolve(flags.get('--store') ?? resolve(workspace, '.backtest'));
  const workers = flags.get('--workers');
  const concurrency = workers === undefined ? undefined : Number(workers);
  assertThat(concurrency === undefined || (/^\d+$/.test(workers!) && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8),
    'INVALID_ARGUMENTS', '--workers must be an integer from 1 to 8');
  const formats = flags.get('--formats');
  return { workspace, storeDir, ...(concurrency === undefined ? {} : { concurrency }), ...(formats ? { formats: resolve(formats) } : {}) };
}

export async function mcpMain(argv = process.argv.slice(2)): Promise<void> {
  const runtime = await createMcpServer(parseMcpArguments(argv));
  const shutdown = () => { void runtime.close().catch(error => { process.stderr.write(`${JSON.stringify(errorJSON(error))}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  await runtime.server.connect(new StdioServerTransport());
}

const moduleUrl = typeof __filename === 'string' ? pathToFileURL(__filename).href : import.meta.url;
if (process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href) {
  mcpMain().catch(error => { process.stderr.write(`${JSON.stringify(errorJSON(error))}\n`); process.exitCode = 1; });
}
