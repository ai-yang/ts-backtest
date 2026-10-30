import type { BacktestSpec, BarInput, DatasetInput, Instrument } from '../src/spec/types.js';

export const sessions = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11'];
export const openAt = (session: string) => Date.parse(`${session}T01:30:00Z`);
export const closeAt = (session: string) => Date.parse(`${session}T07:00:00Z`);

export function instrument(symbol = 'AAA', overrides: Partial<Instrument> = {}): Instrument {
  return { symbol, type: 'stock', currency: 'CNY', tickSize: '0.01', lotSize: 1, settlementDays: 0, allowOddLotSell: true, requirePriceLimits: false, ...overrides };
}

export function bar(session: string, price: string, overrides: Partial<BarInput> = {}): BarInput {
  return { symbol: 'AAA', openTime: openAt(session), closeTime: closeAt(session), session, open: price, high: price, low: price, close: price, volume: 100000, amount: '1000000', tradable: true, ...overrides };
}

export function input(prices = ['10', '10', '12', '11', '11']): DatasetInput {
  return {
    metadata: { schemaVersion: '1', timezone: 'Asia/Shanghai', frequency: 'day', priceAdjustment: 'raw', volumeUnit: 'shares', amountUnit: 'currency', currency: 'CNY', calendarVersion: 'test-v1', sessions: [...sessions], instruments: [instrument()], corporateActionsCoverage: 'complete', universeMode: 'static' },
    bars: prices.map((p, i) => bar(sessions[i]!, p)),
    features: [], membership: [], actions: [],
  };
}

export function spec(overrides: Partial<BacktestSpec> = {}): BacktestSpec {
  return {
    schemaVersion: '1', start: openAt(sessions[0]!), end: closeAt(sessions[4]!) + 1,
    account: { currency: 'CNY', initialCash: '1000.00', moneyDecimals: 2, cashFlows: [] },
    strategy: { kind: 'targets', schedule: [{ at: closeAt(sessions[0]!), availableAt: closeAt(sessions[0]!), weights: { AAA: 1 } }, { at: closeAt(sessions[2]!), availableAt: closeAt(sessions[2]!), weights: { AAA: 0 } }] },
    costs: { version: 'explicit-zero-v1', scope: 'order', periods: [{ from: 0, commissionRate: '0', minimumCommission: '0', sellTaxRate: '0', transferRate: '0' }] },
    execution: { decisionAt: 'bar_close', fillAt: 'next_bar_open', slippage: { type: 'fixed_bps', bps: 0 }, intrabarPolicy: 'conservative', cashAllocation: 'proportional', endPositionPolicy: 'mark_to_market', participationRate: 1, maxPositionWeight: 1, maxStaleSessions: 5, stalePolicy: 'warn' },
    analytics: { annualPeriods: 252, riskFreeRate: 0 }, output: { level: 'fullTrace' }, seed: 1,
    limits: { maxBars: 2000000, maxOrders: 100000, maxRuntimeMs: 30000, maxNodes: 512, maxOutputRows: 5000000 },
    ...overrides,
  };
}
