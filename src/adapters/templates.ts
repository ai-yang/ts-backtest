import { z } from 'zod';
import { BacktestError, assertThat } from '../spec/errors.js';
import type { Expression, Strategy } from '../spec/types.js';

const period = z.number().int().min(1).max(1_000_000);
const quantity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const symbolList = z.array(z.string().min(1).max(128)).min(1).max(100_000)
  .refine(symbols => new Set(symbols).size === symbols.length, 'symbols must be unique').optional();
const schemas = {
  sma_cross: z.strictObject({ fast: period, slow: period, quantity, symbols: symbolList }),
  rsi_threshold: z.strictObject({ period, oversold: z.number().min(0).max(100), overbought: z.number().min(0).max(100), quantity, symbols: symbolList }),
  rank_feature: z.strictObject({ feature: z.string().min(1).max(128), topK: z.number().int().positive(),
    descending: z.boolean(), rebalanceEvery: z.number().int().positive(),
    rebalanceUnit: z.enum(['bar', 'session', 'week', 'month']), weighting: z.enum(['equal', 'score']),
    grossWeight: z.number().min(0).max(1),
  }),
  buy_and_hold: z.strictObject({ quantity, symbols: symbolList }),
};

export type TemplateName = keyof typeof schemas;
export const templateNames = Object.keys(schemas) as TemplateName[];
const descriptions: Record<TemplateName, string> = {
  sma_cross: 'Target an explicit quantity on a fast/slow SMA upward crossing; close on a downward crossing.',
  rsi_threshold: 'Target an explicit quantity below the RSI oversold threshold; close above overbought.',
  rank_feature: 'Rank a point-in-time external feature and periodically allocate an explicit gross weight.',
  buy_and_hold: 'Whenever flat, target an explicit quantity; no scheduled strategy exit. This re-enters after protective or external exits; it is not a one-time purchase.',
};

export function describeTemplates(name?: TemplateName): unknown[] {
  return (name ? [name] : templateNames).map(key => ({ name: key, description: descriptions[key],
    parametersSchema: z.toJSONSchema(schemas[key]),
    supplies: 'strategy only; account, costs, execution, analytics and interval remain required',
  }));
}

export function createTemplate(name: TemplateName, parameters: unknown): Strategy {
  const schema = schemas[name];
  assertThat(schema, 'UNKNOWN_TEMPLATE', `Unknown template ${name}`, '/name');
  const parsed = schema.safeParse(parameters);
  if (!parsed.success) throw new BacktestError('INVALID_TEMPLATE_PARAMETERS', parsed.error.issues[0]!.message,
    '/parameters/' + parsed.error.issues[0]!.path.join('/'), { issues: parsed.error.issues });
  const p = parsed.data;
  if (name === 'sma_cross') {
    const args = p as z.infer<typeof schemas.sma_cross>;
    assertThat(args.fast < args.slow, 'INVALID_TEMPLATE_PARAMETERS', 'fast must be less than slow', '/parameters/fast');
    return { kind: 'rules', nodes: {
      fast: { op: 'sma', args: [{ field: 'close' }], period: args.fast },
      slow: { op: 'sma', args: [{ field: 'close' }], period: args.slow },
    }, rules: [
      { when: { op: 'cross_up', args: [{ ref: 'fast' }, { ref: 'slow' }] }, action: { type: 'target_quantity', value: args.quantity }, ...(args.symbols ? { symbols: args.symbols } : {}) },
      { when: { op: 'cross_down', args: [{ ref: 'fast' }, { ref: 'slow' }] }, action: { type: 'close' }, ...(args.symbols ? { symbols: args.symbols } : {}) },
    ] };
  }
  if (name === 'rsi_threshold') {
    const args = p as z.infer<typeof schemas.rsi_threshold>;
    assertThat(args.oversold < args.overbought, 'INVALID_TEMPLATE_PARAMETERS', 'oversold must be less than overbought', '/parameters/oversold');
    return { kind: 'rules', nodes: { rsi: { op: 'rsi', args: [{ field: 'close' }], period: args.period } }, rules: [
      { when: { op: 'lt', args: [{ ref: 'rsi' }, { value: args.oversold }] }, action: { type: 'target_quantity', value: args.quantity }, ...(args.symbols ? { symbols: args.symbols } : {}) },
      { when: { op: 'gt', args: [{ ref: 'rsi' }, { value: args.overbought }] }, action: { type: 'close' }, ...(args.symbols ? { symbols: args.symbols } : {}) },
    ] };
  }
  if (name === 'rank_feature') {
    const args = p as z.infer<typeof schemas.rank_feature>;
    return { kind: 'rank', nodes: {}, score: { feature: args.feature }, topK: args.topK,
      descending: args.descending, rebalanceEvery: args.rebalanceEvery, rebalanceUnit: args.rebalanceUnit,
      weighting: args.weighting, grossWeight: args.grossWeight,
    };
  }
  const args = p as z.infer<typeof schemas.buy_and_hold>;
  const flat: Expression = { op: 'eq', args: [{ state: 'position' }, { value: 0 }] };
  return { kind: 'rules', nodes: {}, rules: [{ when: flat, action: { type: 'target_quantity', value: args.quantity }, ...(args.symbols ? { symbols: args.symbols } : {}) }] };
}
