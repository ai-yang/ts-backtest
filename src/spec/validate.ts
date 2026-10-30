import { Decimal } from './decimal.js';
import { z } from 'zod';
import { BacktestError, assertThat } from './errors.js';
import { backtestSpecSchema, datasetMetadataSchema, framesPreparationSchema } from './schema.js';
import type { BacktestSpec, DatasetMetadata, Expression, Strategy, FramePreparation } from './types.js';

export { backtestSpecSchema, datasetMetadataSchema, backtestSpecJsonSchema, metadataJsonSchema } from './schema.js';

const MAX_DEPTH = 64;
const MAX_INPUT_VALUES = 5_000_000;

/** Run before recursive schema parsing, including for callers bypassing JSON/YAML. */
function inspectInput(input: unknown, maxDepth = MAX_DEPTH): void {
  const ancestors = new WeakSet<object>();
  let count = 0;
  function visit(value: unknown, path: string, depth: number): void {
    assertThat(++count <= MAX_INPUT_VALUES, 'INPUT_TOO_LARGE', 'Input exceeds the structural value limit', path);
    assertThat(depth <= maxDepth, 'INPUT_TOO_DEEP', `Input nesting exceeds ${maxDepth}`, path);
    if (value === null || typeof value !== 'object') return;
    assertThat(!ancestors.has(value), 'CYCLIC_INPUT', 'Input contains a cyclic object', path);
    const proto = Object.getPrototypeOf(value);
    assertThat(Array.isArray(value) || proto === Object.prototype || proto === null,
      'INVALID_INPUT', 'Only plain objects and arrays are accepted', path);
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      assertThat(!['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_KEY', 'Reserved object key', `${path}/${key}`);
      visit(child, `${path}/${key}`, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, '', 0);
}

function parse<T>(schema: z.ZodType<T>, input: unknown, maxDepth = MAX_DEPTH): T {
  inspectInput(input, maxDepth);
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new BacktestError('INVALID_SPEC', first.message, '/' + first.path.join('/'),
      { issues: result.error.issues.slice(0, 20) });
  }
  return result.data;
}

function exact(value: string, path: string, positive = false): string {
  const result = new Decimal(value);
  assertThat(result.isFinite() && (!positive || result.gt(0)), 'INVALID_DECIMAL', positive ? 'Value must be positive' : 'Value must be finite', path);
  assertThat(result.decimalPlaces() <= 18, 'INVALID_PRECISION', 'At most 18 fractional digits are supported', path);
  return result.isZero() ? '0' : result.toFixed();
}

type ValueType = 'number' | 'boolean';
const windowOps = new Set(['sma', 'ema', 'rsi', 'atr', 'lag', 'rolling_min', 'rolling_max', 'rolling_quantile']);
const macdOps = new Set(['macd', 'macd_signal', 'macd_hist']);
const arithmeticOps = new Set(['add', 'sub', 'mul', 'div']);
const compareOps = new Set(['gt', 'gte', 'lt', 'lte', 'cross_up', 'cross_down']);

function validateGraph(strategy: Extract<Strategy, { nodes: unknown }>, maxNodes: number): void {
  const types = new Map<string, ValueType>();
  const visiting = new Set<string>();
  let count = 0;
  const named = strategy.nodes;
  function node(name: string, path: string, depth: number): ValueType {
    assertThat(Object.hasOwn(named, name), 'UNKNOWN_REFERENCE', `Unknown expression node: ${name}`, path);
    assertThat(!visiting.has(name), 'CYCLIC_EXPRESSION', `Expression reference cycle at ${name}`, path);
    const cached = types.get(name);
    if (cached) return cached;
    visiting.add(name);
    const type = expression(named[name]!, `/strategy/nodes/${name}`, depth + 1);
    visiting.delete(name);
    types.set(name, type);
    return type;
  }
  function expression(expr: Expression, path: string, depth = 0): ValueType {
    assertThat(depth <= MAX_DEPTH, 'EXPRESSION_TOO_DEEP', 'Expression dependency depth exceeds limit', path);
    assertThat(++count <= maxNodes, 'EXPRESSION_LIMIT', 'Expression node budget exceeded', path);
    if ('ref' in expr) return node(expr.ref, path, depth);
    if ('value' in expr) return typeof expr.value as ValueType;
    if (!('op' in expr)) return 'number';
    const { op, args } = expr;
    const window = windowOps.has(op), macd = macdOps.has(op);
    for (const key of ['period', 'quantile', 'fast', 'slow', 'signal'] as const) {
      const applicable = key === 'period' ? window : key === 'quantile' ? op === 'rolling_quantile' : macd;
      assertThat(applicable || expr[key] === undefined, 'INVALID_OPERATOR_PARAMETER', `${key} is not applicable to ${op}`, `${path}/${key}`);
      if (applicable) assertThat(expr[key] !== undefined, 'MISSING_OPERATOR_PARAMETER', `${op} requires ${key}`, `${path}/${key}`);
    }
    if (macd) assertThat(expr.fast! < expr.slow!, 'INVALID_OPERATOR_PARAMETER', 'MACD fast must be less than slow', path);
    const expected = op === 'atr' ? 0 : op === 'if' ? 3 : arithmeticOps.has(op) || compareOps.has(op) || op === 'eq' ? 2 : 1;
    if (op === 'and' || op === 'or') assertThat(args.length >= 2, 'INVALID_ARITY', `${op} requires at least two arguments`, path);
    else assertThat(args.length === expected, 'INVALID_ARITY', `${op} requires ${expected} arguments`, path);
    const inputs = args.map((arg, i) => expression(arg, `${path}/args/${i}`, depth + 1));
    if (op === 'if') {
      assertThat(inputs[0] === 'boolean' && inputs[1] === inputs[2], 'EXPRESSION_TYPE', 'if requires a boolean condition and matching branch types', path);
      return inputs[1]!;
    }
    if (op === 'eq') {
      assertThat(inputs[0] === inputs[1], 'EXPRESSION_TYPE', 'eq requires matching argument types', path);
      return 'boolean';
    }
    const boolean = op === 'and' || op === 'or' || op === 'not';
    const required = boolean ? 'boolean' : 'number';
    assertThat(inputs.every(type => type === required), 'EXPRESSION_TYPE', `${op} requires ${required} arguments`, path);
    return boolean || compareOps.has(op) ? 'boolean' : 'number';
  }
  for (const name of Object.keys(named)) node(name, `/strategy/nodes/${name}`, 0);
  if (strategy.kind === 'rules') {
    strategy.rules.forEach((rule, i) => {
      assertThat(expression(rule.when, `/strategy/rules/${i}/when`) === 'boolean', 'EXPRESSION_TYPE', 'Rule predicates must be boolean', `/strategy/rules/${i}/when`);
      if (rule.symbols) assertThat(new Set(rule.symbols).size === rule.symbols.length, 'DUPLICATE_SYMBOL', 'Rule symbols must be unique', `/strategy/rules/${i}/symbols`);
      const action = rule.action;
      if (action.type === 'order') {
        const path = `/strategy/rules/${i}/action/price`;
        if (action.orderType === 'market') assertThat(action.price === undefined, 'INVALID_ORDER', 'Market orders cannot specify a price', path);
        else {
          assertThat(action.price !== undefined, 'INVALID_ORDER', 'Limit and stop orders require a price', path);
          action.price = exact(action.price, path, true);
        }
      }
    });
  } else {
    assertThat(expression(strategy.score, '/strategy/score') === 'number', 'EXPRESSION_TYPE', 'Ranking score must be numeric', '/strategy/score');
    if (strategy.filter) assertThat(expression(strategy.filter, '/strategy/filter') === 'boolean', 'EXPRESSION_TYPE', 'Ranking filter must be boolean', '/strategy/filter');
  }
}

export function parseSpec(input: unknown): BacktestSpec {
  const spec: BacktestSpec = parse(backtestSpecSchema, input);
  assertThat(spec.start < spec.end, 'INVALID_RANGE', 'end must be greater than start (exclusive)', '/end');
  spec.account.initialCash = exact(spec.account.initialCash, '/account/initialCash', true);
  const cashPrecision = (value: string, path: string) => assertThat(new Decimal(value).decimalPlaces() <= spec.account.moneyDecimals,
    'INVALID_PRECISION', 'Cash amount exceeds account moneyDecimals', path);
  cashPrecision(spec.account.initialCash, '/account/initialCash');
  let previous = -1;
  spec.account.cashFlows.forEach((flow, i) => {
    const path = `/account/cashFlows/${i}`;
    assertThat(flow.at >= spec.start && flow.at < spec.end && flow.at >= previous, 'INVALID_CASH_FLOW_TIME', 'Cash flows must be ordered and inside [start, end)', `${path}/at`);
    previous = flow.at;
    flow.amount = exact(flow.amount, `${path}/amount`);
    assertThat(!new Decimal(flow.amount).isZero(), 'INVALID_CASH_FLOW', 'Cash flow amount must be nonzero', `${path}/amount`);
    cashPrecision(flow.amount, `${path}/amount`);
  });
  let coveredUntil = spec.start;
  let previousEnd = -1;
  spec.costs.periods.forEach((period, i) => {
    const path = `/costs/periods/${i}`;
    const end = period.to ?? Infinity;
    assertThat(end > period.from, 'INVALID_COST_PERIOD', 'Cost period must have positive duration', path);
    assertThat(period.from >= previousEnd, 'OVERLAPPING_COST_PERIODS', 'Cost periods must be ordered and non-overlapping', path);
    previousEnd = end;
    if (end > spec.start && period.from < spec.end) {
      assertThat(period.from <= coveredUntil, 'COST_PERIOD_GAP', 'Cost model must cover the complete backtest range', path);
      coveredUntil = end;
    }
    for (const key of ['commissionRate', 'sellTaxRate', 'transferRate', 'minimumCommission'] as const) {
      period[key] = exact(period[key], `${path}/${key}`);
      if (key !== 'minimumCommission') assertThat(new Decimal(period[key]).lt(1), 'INVALID_COST_RATE', 'Cost rates must be below 1', `${path}/${key}`);
      else cashPrecision(period[key], `${path}/${key}`);
    }
  });
  assertThat(coveredUntil >= spec.end, 'COST_PERIOD_GAP', 'Cost model does not cover the complete backtest range', '/costs/periods');

  const strategy = spec.strategy;
  if ('nodes' in strategy) validateGraph(strategy, spec.limits.maxNodes);
  if (strategy.kind === 'targets') {
    let last = -1;
    strategy.schedule.forEach((point, i) => {
      const path = `/strategy/schedule/${i}`;
      assertThat(point.at >= spec.start && point.at < spec.end && point.at > last, 'INVALID_TARGET_TIME', 'Target timestamps must be unique, ordered and inside [start, end)', `${path}/at`);
      assertThat(point.availableAt <= point.at, 'FUTURE_DATA', 'Targets cannot be used before they are available', `${path}/availableAt`);
      assertThat((point.weights !== undefined) !== (point.quantities !== undefined), 'INVALID_TARGET', 'Specify exactly one of weights or quantities', path);
      if (point.weights) {
        const total = Object.values(point.weights).reduce((sum, value) => sum.plus(String(value)), new Decimal(0));
        assertThat(total.lte(1), 'LEVERAGE_NOT_SUPPORTED', 'Target weights cannot sum to more than 1', `${path}/weights`);
      }
      last = point.at;
    });
  }
  if (strategy.kind === 'replay') {
    let last = -1;
    strategy.fills.forEach((fill, i) => {
      const path = `/strategy/fills/${i}`;
      assertThat(fill.at >= spec.start && fill.at < spec.end && fill.at >= last, 'INVALID_REPLAY_TIME', 'Replay fills must be ordered and inside [start, end)', `${path}/at`);
      fill.price = exact(fill.price, `${path}/price`, true);
      assertThat(strategy.feePolicy === 'provided' ? fill.fees !== undefined : fill.fees === undefined,
        'INVALID_REPLAY_FEES', 'Provided policy requires fees; recalculate policy forbids provided fees', `${path}/fees`);
      if (fill.fees !== undefined) {
        fill.fees = exact(fill.fees, `${path}/fees`);
        cashPrecision(fill.fees, `${path}/fees`);
      }
      last = fill.at;
    });
  }
  return spec;
}

export function validateDatasetMetadata(input: unknown): DatasetMetadata {
  const metadata: DatasetMetadata = parse(datasetMetadataSchema, input);
  try { new Intl.DateTimeFormat('en', { timeZone: metadata.timezone }).format(0); }
  catch { throw new BacktestError('INVALID_TIMEZONE', 'Unknown IANA timezone', '/timezone'); }
  let last = '';
  metadata.sessions.forEach((session, i) => {
    const date = new Date(`${session}T00:00:00Z`);
    assertThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === session,
      'INVALID_SESSION', 'Calendar contains an invalid date', `/sessions/${i}`);
    assertThat(session > last, 'INVALID_CALENDAR', 'Calendar sessions must be unique and sorted', `/sessions/${i}`);
    last = session;
  });
  const symbols = new Set<string>();
  metadata.instruments.forEach((instrument, i) => {
    const path = `/instruments/${i}`;
    assertThat(!symbols.has(instrument.symbol), 'DUPLICATE_SYMBOL', 'Instrument symbols must be unique', `${path}/symbol`);
    symbols.add(instrument.symbol);
    assertThat(instrument.currency === metadata.currency, 'MULTI_CURRENCY_NOT_SUPPORTED', 'All instruments must use the dataset currency', `${path}/currency`);
    instrument.tickSize = exact(instrument.tickSize, `${path}/tickSize`, true);
  });
  assertThat((metadata.calendarCoverage === undefined) === (metadata.sessionIntervals === undefined),
    'INVALID_SESSION_BOUNDARIES', 'calendarCoverage and sessionIntervals must be supplied together');
  if (metadata.calendarCoverage && metadata.sessionIntervals) {
    const validDate = (value: string) => {
      const at = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
    };
    const coverage = metadata.calendarCoverage;
    assertThat(validDate(coverage.from) && validDate(coverage.through) && coverage.from <= coverage.through,
      'INVALID_CALENDAR_COVERAGE', 'Calendar coverage requires ordered valid inclusive dates');
    const covered = metadata.sessions.filter(session => session >= coverage.from && session <= coverage.through);
    assertThat(covered.length === metadata.sessionIntervals.length && metadata.sessionIntervals.every((item, i) => item.session === covered[i]),
      'INVALID_SESSION_BOUNDARIES', 'sessionIntervals must describe every trading session inside calendarCoverage, in calendar order');
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: metadata.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = (at: number) => {
      const parts = formatter.formatToParts(at);
      return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
    };
    let previousClose = -1;
    for (const item of metadata.sessionIntervals) for (const segment of item.segments) {
      assertThat(segment.openTime < segment.closeTime && segment.openTime >= previousClose &&
        localDate(segment.openTime) === item.session && localDate(segment.closeTime) === item.session &&
        (segment.closeTime - segment.openTime) % 60_000 === 0,
      'INVALID_SESSION_BOUNDARIES', 'Session segments must be ordered, nonoverlapping, minute-sized, and lie on their declared local date');
      previousClose = segment.closeTime;
    }
  }
  return metadata;
}

/** Data-only graphs reuse the same operator typing and dependency checks as strategies. */
export function parseFramePreparation(input: unknown): FramePreparation {
  // Leave room for provenance and the cache envelope's own structural levels.
  const preparation = parse(framesPreparationSchema, input, MAX_DEPTH - 8);
  assertThat(preparation.from < preparation.asOf, 'INVALID_FRAME_RANGE', 'Frame from must precede asOf');
  const ids = new Set<string>();
  for (const recipe of preparation.recipes) {
    assertThat(!ids.has(recipe.id), 'DUPLICATE_FRAME', 'Frame recipe IDs must be unique'); ids.add(recipe.id);
    const outputNames = Object.keys(recipe.outputs);
    assertThat(outputNames.length >= 1 && outputNames.length <= 64 && Object.keys(recipe.nodes).length <= 1024,
      'FRAME_GRAPH_LIMIT', 'Each frame requires 1..64 outputs and at most 1024 named nodes');
    const combined = { ...recipe.nodes };
    for (const [name, expression] of Object.entries(recipe.outputs)) {
      const key = `$frame_output:${name}`;
      assertThat(!Object.hasOwn(combined, key), 'INVALID_KEY', 'Reserved internal frame node prefix');
      combined[key] = expression;
    }
    function dataOnly(expr: Expression): void {
      assertThat(!('state' in expr), 'FRAME_ACCOUNT_STATE', 'Prepared frame expressions cannot depend on runtime account state');
      if ('op' in expr) expr.args.forEach(dataOnly);
    }
    Object.values(combined).forEach(dataOnly);
    validateGraph({ kind: 'rank', nodes: combined, score: { value: 0 }, topK: 1, descending: true,
      rebalanceEvery: 1, rebalanceUnit: 'bar', weighting: 'equal', grossWeight: 1 }, 4096);
  }
  return preparation;
}
