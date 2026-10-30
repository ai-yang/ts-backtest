import { ENGINE_VERSION } from '../engine/run.js';
import { backtestSpecJsonSchema, metadataJsonSchema, framesPreparationJsonSchema } from '../spec/schema.js';
import { z } from 'zod';
import { sweepRequestSchema } from '../research/sweep.js';
import { walkForwardRequestSchema } from '../research/walk-forward.js';
import { factorRequestSchema } from '../research/factors.js';
import { assertThat } from '../spec/errors.js';
import type { Operator } from '../spec/types.js';
import { createTemplate, describeTemplates, templateNames, type TemplateName } from './templates.js';

const arithmetic: Operator[] = ['add', 'sub', 'mul', 'div'];
const comparison: Operator[] = ['gt', 'gte', 'lt', 'lte', 'eq'];
const rolling: Operator[] = ['sma', 'ema', 'rsi', 'lag', 'rolling_min', 'rolling_max', 'rolling_quantile'];
export const operatorCatalog = [
  ...arithmetic.map(name => ({ name, arity: 2, inputs: 'number', output: 'number', parameters: [] })),
  ...comparison.map(name => ({ name, arity: 2, inputs: name === 'eq' ? 'matching number or boolean' : 'number', output: 'boolean', parameters: [] })),
  { name: 'and', arity: '2..32', inputs: 'boolean', output: 'boolean', parameters: [] },
  { name: 'or', arity: '2..32', inputs: 'boolean', output: 'boolean', parameters: [] },
  { name: 'not', arity: 1, inputs: 'boolean', output: 'boolean', parameters: [] },
  { name: 'if', arity: 3, inputs: 'boolean condition and matching branches', output: 'branch type', parameters: [] },
  ...rolling.map(name => ({ name, arity: 1, inputs: 'number', output: 'number', parameters: name === 'rolling_quantile' ? ['period', 'quantile'] : ['period'] })),
  { name: 'atr', arity: 0, inputs: 'implicit current OHLC', output: 'number', parameters: ['period'] },
  ...['macd', 'macd_signal', 'macd_hist'].map(name => ({ name, arity: 1, inputs: 'number', output: 'number', parameters: ['fast', 'slow', 'signal'] })),
  ...['cross_up', 'cross_down'].map(name => ({ name, arity: 2, inputs: 'number', output: 'boolean', parameters: [] })),
  ...['rank', 'zscore'].map(name => ({ name, arity: 1, inputs: 'number cross-section', output: 'number', parameters: [] })),
];

export interface CapabilityRequest {
  category?: 'summary' | 'schema' | 'operators' | 'templates';
  name?: string;
  parameters?: unknown;
}

export function capabilities(request: CapabilityRequest = {}): unknown {
  const category = request.category ?? 'summary';
  assertThat(request.parameters === undefined || category === 'templates', 'INVALID_CAPABILITY_REQUEST', 'parameters apply only to templates', '/parameters');
  if (category === 'schema') {
    const schemas = { sweep: sweepRequestSchema, walk_forward: walkForwardRequestSchema, factors: factorRequestSchema };
    if(request.name&&Object.hasOwn(schemas,request.name))return {name:request.name,schema:z.toJSONSchema(schemas[request.name as keyof typeof schemas]),semanticValidation:'Research tools additionally validate temporal boundaries and service budgets.'};
    assertThat(request.name === 'spec' || request.name === 'metadata' || request.name === 'frames', 'INVALID_CAPABILITY_REQUEST', 'Choose schema name spec, metadata, frames, sweep, walk_forward or factors', '/name');
    return { name: request.name, schema: request.name === 'spec' ? backtestSpecJsonSchema : request.name === 'metadata' ? metadataJsonSchema : framesPreparationJsonSchema,
      semanticValidation: 'Use backtest_validate to verify references, operator types, financial constraints and linked data.' };
  }
  if (category === 'operators') {
    const operators = request.name ? operatorCatalog.filter(operator => operator.name === request.name) : operatorCatalog;
    assertThat(operators.length > 0, 'UNKNOWN_OPERATOR', `Unknown operator ${request.name}`, '/name');
    return { operators, missingValues: 'Unavailable values propagate through arithmetic, comparisons, and boolean and/or/not. if requires an available condition and evaluates the selected branch; an unavailable unselected branch does not invalidate its result. An unavailable final predicate never trades.',
      conventions: { ema: 'SMA seed', rsi: 'Wilder averages, period+1 prices, flat=50', atr: 'Wilder average; first true range is high-low',
        rank: 'ascending 1-based average tie ranks among current eligible symbols', zscore: 'population deviation; constant section unavailable',
        crossSection: 'All symbols completing the same timestamp update together; stale symbols are excluded.' } };
  }
  if (category === 'templates') {
    assertThat(request.name === undefined || templateNames.includes(request.name as TemplateName), 'UNKNOWN_TEMPLATE', `Unknown template ${request.name}`, '/name');
    assertThat(request.parameters === undefined || request.name !== undefined, 'INVALID_CAPABILITY_REQUEST', 'Template parameters require a template name', '/name');
    if (request.parameters !== undefined) return { name: request.name, strategy: createTemplate(request.name as TemplateName, request.parameters),
      requires: ['account', 'costs', 'execution', 'analytics', 'start', 'end'], executableSpec: false };
    return { templates: describeTemplates(request.name as TemplateName | undefined) };
  }
  assertThat(category === 'summary' && request.name === undefined, 'INVALID_CAPABILITY_REQUEST', 'summary takes no name', '/name');
  return {
    schemaVersion: '1', engineVersion: ENGINE_VERSION, transport: 'stdio MCP', runtime: 'TypeScript/Node.js',
    modes: ['rules', 'targets', 'rank', 'replay'], formats: ['csv', 'jsonl', 'json'], frequencies: ['day', 'minute'],
    optionalFormats: { formats: ['parquet', 'arrow', 'xlsx'], activation: 'Host starts MCP with --formats /absolute/path/to/trusted/adapter.js; dataset requests cannot load code' },
    higherFrames: { units: ['minute N', 'day', 'week', 'month'], prepareArgument: 'frames',
      requiredCalendar: ['calendarCoverage', 'sessionIntervals'], publication: 'frame close only; outputs are frame:<id>:<output> features',
      indicators: 'advanced once per completed frame, not once per base bar', missingFeature: 'null explicitly withdraws the prior value' },
    instruments: ['stock', 'etf'], currency: 'one explicit settlement currency per account',
    orders: ['market', 'limit', 'stop'], accounting: ['exact decimal costs', 'order/fill commission scope', 'settlement lots', 'partial fills', 'cash flows', 'splits', 'dividends', 'delisting'],
    execution: { decisionAt: 'bar_close', fillAt: 'next_bar_open', endPositionPolicy: 'mark_to_market',
      participation: 'prior completed bar volume', intrabarAmbiguity: ['conservative', 'reject'],
      dayOrders: 'expire in their submission session; daily close DAY orders cannot fill next session' },
    outputs: ['summary', 'trades', 'fullTrace'], jobs: ['durable handles', 'status', 'cancel'],
    research: { sweep: 'bounded scalar JSON pointer grid; shared data; deterministic candidate seeds',
      walkForward: 'rules strategies; rolling/expanding training; strategy-only parameter variation; one continuous OOS account with carried positions and pending orders',
      factors: ['as-of features', 'IC', 'rank IC', 'group forward returns'], tools: ['backtest_sweep','backtest_walk_forward','backtest_factors','backtest_study'] },
    reports: { tool: 'backtest_report', output: 'standalone HTML with inline SVG', requiredOutput: 'fullTrace', networkDependencies: false },
    unsupported: ['short selling', 'borrowing/margin', 'futures/options', 'multi-currency conversion', 'tick/orderbook queue matching', 'live trading', 'arbitrary strategy source execution'],
    workflow: ['backtest_prepare_data → backtest_job', 'backtest_validate background:true → backtest_job → planId (background:false waits)', 'backtest_run → backtest_job', 'backtest_result', 'backtest_explain → backtest_job'],
    discovery: { schemaNames: ['spec', 'metadata', 'frames', 'sweep', 'walk_forward', 'factors'], operatorCount: operatorCatalog.length, templateNames },
    defaults: 'Financial inputs must be explicit; no implicit zero-cost or market-rule profile.',
    limits: { indicatorWorkingBytes: 256 * 1024 * 1024, maximumResultPageRows: 200, maximumResultPageBytes: 256 * 1024,
      maximumToolInputBytes: 8 * 1024 * 1024, maximumSpecBytes: 1024 * 1024,
      maximumToolInputDepth: 64, maximumToolInputValues: 500_000 },
  };
}
