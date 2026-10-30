import { z } from 'zod';
import type { Expression } from './types.js';

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const finite = z.number().finite();
const identifier = z.string().min(1).max(128);
const currency = z.string().regex(/^[A-Z]{3}$/);
const decimal = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/);
const nonnegativeDecimal = z.string().max(80).regex(/^\d+(?:\.\d+)?$/);
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fraction = finite.min(0).max(1);
const period = z.number().int().min(1).max(1_000_000);
const decimalRecord = z.record(identifier, finite.min(0));

export const expressionSchema: z.ZodType<Expression> = z.lazy(() => z.union([
  z.strictObject({ field: z.enum(['open', 'high', 'low', 'close', 'volume', 'amount']) }),
  z.strictObject({ time: z.literal('at') }),
  z.strictObject({ feature: identifier }),
  z.strictObject({ ref: identifier }),
  z.strictObject({ value: z.union([finite, z.boolean()]) }),
  z.strictObject({ state: z.enum(['position', 'holding_sessions', 'holding_high', 'cooldown_sessions']) }),
  z.strictObject({
    op: z.enum(['add', 'sub', 'mul', 'div', 'gt', 'gte', 'lt', 'lte', 'eq', 'and', 'or', 'not', 'if',
      'sma', 'ema', 'rsi', 'atr', 'macd', 'macd_signal', 'macd_hist', 'lag', 'rolling_min',
      'rolling_max', 'rolling_quantile', 'cross_up', 'cross_down', 'rank', 'zscore']),
    args: z.array(expressionSchema).max(32),
    period: period.optional(), quantile: fraction.optional(),
    fast: period.optional(), slow: period.optional(), signal: period.optional(),
  }),
]));

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('target_weight'), value: fraction, tag: identifier.optional() }),
  z.strictObject({ type: z.literal('target_quantity'), value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), tag: identifier.optional() }),
  z.strictObject({ type: z.literal('close'), tag: identifier.optional() }),
  z.strictObject({ type: z.literal('cancel'), tag: identifier.optional() }),
  z.strictObject({
    type: z.literal('order'), side: z.enum(['buy', 'sell']), quantity: positiveInt,
    orderType: z.enum(['market', 'limit', 'stop']), price: nonnegativeDecimal.optional(),
    tif: z.enum(['day', 'gtc']), tag: identifier.optional(),
  }),
]);

const nodes = z.record(identifier, expressionSchema);
export const frameRecipeSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/),
  frame: z.discriminatedUnion('unit', [
    z.strictObject({ unit: z.literal('minute'), minutes: z.number().int().min(1).max(1440), tailPolicy: z.enum(['drop', 'short']) }),
    z.strictObject({ unit: z.literal('day') }), z.strictObject({ unit: z.literal('week') }), z.strictObject({ unit: z.literal('month') }),
  ]),
  missingPolicy: z.enum(['error', 'skip']), nodes,
  outputs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/), expressionSchema),
});
export const framesPreparationSchema = z.strictObject({ from: timestamp, asOf: timestamp,
  recipes: z.array(frameRecipeSchema).min(1).max(16),
});
export const strategySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rules'), nodes,
    rules: z.array(z.strictObject({ when: expressionSchema, action: actionSchema,
      symbols: z.array(identifier).min(1).max(100_000).optional() })).min(1).max(10_000),
  }),
  z.strictObject({ kind: z.literal('rank'), nodes, score: expressionSchema,
    filter: expressionSchema.optional(), topK: positiveInt, descending: z.boolean(),
    rebalanceEvery: positiveInt, rebalanceUnit: z.enum(['bar', 'session', 'week', 'month']),
    weighting: z.enum(['equal', 'score']), grossWeight: finite.min(0).max(1),
  }),
  z.strictObject({ kind: z.literal('targets'), schedule: z.array(z.strictObject({
    at: timestamp, availableAt: timestamp, weights: decimalRecord.optional(),
    quantities: z.record(identifier, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).optional(),
  })).min(1).max(1_000_000) }),
  z.strictObject({ kind: z.literal('replay'), feePolicy: z.enum(['provided', 'recalculate']),
    fills: z.array(z.strictObject({ at: timestamp, symbol: identifier, side: z.enum(['buy', 'sell']),
      quantity: positiveInt, price: nonnegativeDecimal, fees: nonnegativeDecimal.optional(),
    })).max(1_000_000),
  }),
]);

export const backtestSpecSchema = z.strictObject({
  schemaVersion: z.literal('1'), datasetId: identifier.optional(), start: timestamp, end: timestamp,
  account: z.strictObject({ currency, initialCash: nonnegativeDecimal,
    moneyDecimals: z.number().int().min(0).max(8),
    cashFlows: z.array(z.strictObject({ at: timestamp, amount: decimal })).max(1_000_000),
  }),
  strategy: strategySchema,
  costs: z.strictObject({ version: identifier, scope: z.enum(['order', 'fill']),
    periods: z.array(z.strictObject({ from: timestamp, to: timestamp.optional(),
      commissionRate: nonnegativeDecimal, minimumCommission: nonnegativeDecimal,
      sellTaxRate: nonnegativeDecimal, transferRate: nonnegativeDecimal,
    })).min(1).max(10_000),
  }),
  execution: z.strictObject({
    decisionAt: z.literal('bar_close'), fillAt: z.literal('next_bar_open'),
    slippage: z.strictObject({ type: z.enum(['fixed_bps', 'uniform_bps']), bps: finite.min(0).lt(10_000) }),
    intrabarPolicy: z.enum(['conservative', 'reject']), cashAllocation: z.enum(['proportional', 'priority']),
    endPositionPolicy: z.literal('mark_to_market'), participationRate: finite.gt(0).max(1),
    maxPositionWeight: finite.gt(0).max(1), stopLossPct: finite.gt(0).lt(1).optional(),
    takeProfitPct: finite.gt(0).optional(), trailingStopPct: finite.gt(0).lt(1).optional(),
    splitOrderPolicy: z.enum(['cancel', 'adjust']).optional(),
    maxStaleSessions: z.number().int().min(0).max(1_000_000), stalePolicy: z.enum(['warn', 'error']),
  }),
  analytics: z.strictObject({ annualPeriods: finite.gt(0).max(100_000_000),
    riskFreeRate: finite.gt(-1), benchmarkSymbol: identifier.optional(),
  }),
  output: z.strictObject({ level: z.enum(['summary', 'trades', 'fullTrace']).default('summary') }).default({ level: 'summary' }),
  seed: z.number().int().min(0).max(0xffff_ffff).default(1),
  limits: z.strictObject({
    maxBars: z.number().int().min(1).max(100_000_000).default(10_000_000),
    maxOrders: z.number().int().min(1).max(10_000_000).default(100_000),
    maxRuntimeMs: z.number().int().min(1).max(3_600_000).default(120_000),
    maxNodes: z.number().int().min(1).max(10_000).default(1024),
    maxOutputRows: z.number().int().min(1).max(10_000_000).default(1_000_000),
  }).default({ maxBars: 10_000_000, maxOrders: 100_000, maxRuntimeMs: 120_000, maxNodes: 1024, maxOutputRows: 1_000_000 }),
});

export const datasetMetadataSchema = z.strictObject({
  schemaVersion: z.literal('1'), timezone: z.string().min(1).max(128),
  frequency: z.enum(['day', 'minute']), priceAdjustment: z.literal('raw'),
  volumeUnit: z.literal('shares'), amountUnit: z.literal('currency'), currency,
  calendarVersion: identifier, sessions: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(1_000_000),
  instruments: z.array(z.strictObject({
    symbol: identifier, type: z.enum(['stock', 'etf']), currency, tickSize: nonnegativeDecimal,
    lotSize: positiveInt, settlementDays: z.number().int().min(0).max(365),
    allowOddLotSell: z.boolean(), requirePriceLimits: z.boolean(),
  })).min(1).max(100_000),
  corporateActionsCoverage: z.enum(['complete', 'partial', 'none']),
  universeMode: z.enum(['point_in_time', 'static']),
  calendarCoverage: z.strictObject({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).optional(),
  sessionIntervals: z.array(z.strictObject({ session: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    segments: z.array(z.strictObject({ openTime: timestamp, closeTime: timestamp })).min(1).max(32),
  })).min(1).max(1_000_000).optional(),
  frameProvenance: z.strictObject({ version: z.literal('1'), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    configuration: framesPreparationSchema, generatedFeatures: z.array(identifier).max(1024),
    counts: z.array(z.strictObject({ id: identifier, bars: z.number().int().nonnegative(), skippedMissing: z.number().int().nonnegative(), excludedIncomplete: z.number().int().nonnegative() })).max(16),
  }).optional(),
});

/** Structural schema; parseSpec additionally checks graph types and financial invariants. */
export const backtestSpecJsonSchema = z.toJSONSchema(backtestSpecSchema, { io: 'input' });
export const metadataJsonSchema = z.toJSONSchema(datasetMetadataSchema, { io: 'input' });
export const framesPreparationJsonSchema = z.toJSONSchema(framesPreparationSchema, { io: 'input' });
