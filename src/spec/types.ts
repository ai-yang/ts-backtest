/** Public, versioned contracts. All timestamps are UTC epoch milliseconds. */
export type DecimalString = string;
export type Side = 'buy' | 'sell';
export type Field = 'open' | 'high' | 'low' | 'close' | 'volume' | 'amount';
export type OrderType = 'market' | 'limit' | 'stop';
export type OutputLevel = 'summary' | 'trades' | 'fullTrace';
export interface Instrument {
    symbol: string;
    type: 'stock' | 'etf';
    currency: string;
    tickSize: DecimalString;
    lotSize: number;
    settlementDays: number;
    allowOddLotSell: boolean;
    /** Required when the market profile must enforce price bands. */
    requirePriceLimits: boolean;
}
export interface DatasetMetadata {
    schemaVersion: '1';
    timezone: string;
    frequency: 'day' | 'minute';
    priceAdjustment: 'raw';
    volumeUnit: 'shares';
    amountUnit: 'currency';
    currency: string;
    calendarVersion: string;
    /** Explicit trading dates, including settlement horizon; sorted YYYY-MM-DD. */
    sessions: string[];
    instruments: Instrument[];
    corporateActionsCoverage: 'complete' | 'partial' | 'none';
    universeMode: 'point_in_time' | 'static';
    /** Complete calendar coverage, including non-trading dates, inclusive. */
    calendarCoverage?: { from: string; through: string };
    /** Explicit local-session trading segments represented as UTC instants. */
    sessionIntervals?: SessionIntervals[];
    /** Native preparation provenance; its contents participate in the dataset hash. */
    frameProvenance?: FrameProvenance;
}
export interface SessionIntervals { session: string; segments: { openTime: number; closeTime: number }[] }
export interface FrameRecipe {
    id: string;
    frame: { unit: 'minute'; minutes: number; tailPolicy: 'drop' | 'short' } | { unit: 'day' | 'week' | 'month' };
    missingPolicy: 'error' | 'skip';
    nodes: Record<string, Expression>;
    outputs: Record<string, Expression>;
}
export interface FramePreparation { from: number; asOf: number; recipes: FrameRecipe[] }
export interface FrameProvenance {
    version: '1'; sourceHash: string; configuration: FramePreparation;
    generatedFeatures: string[];
    counts: { id: string; bars: number; skippedMissing: number; excludedIncomplete: number }[];
}
export interface BarInput {
    symbol: string;
    openTime: number;
    closeTime: number;
    session: string;
    open: DecimalString;
    high: DecimalString;
    low: DecimalString;
    close: DecimalString;
    volume: number;
    amount?: DecimalString;
    tradable?: boolean;
    limitUp?: DecimalString;
    limitDown?: DecimalString;
}
export interface FeaturePoint {
    symbol: string;
    name: string;
    availableAt: number;
    /** null withdraws a previously published value at availableAt. */
    value: number | null;
}
export interface MembershipPoint {
    symbol: string;
    availableAt: number;
    member: boolean;
}
export type CorporateAction = {
    type: 'split';
    symbol: string;
    at: number;
    ratio: DecimalString;
    cashInLieuPrice?: DecimalString;
    sequence?: number;
} | {
    type: 'dividend';
    symbol: string;
    at: number;
    payAt: number;
    amountPerShare: DecimalString;
    sequence?: number;
} | {
    type: 'delist';
    symbol: string;
    at: number;
    cashPrice: DecimalString;
    sequence?: number;
};
export interface DatasetInput {
    metadata: DatasetMetadata;
    bars: BarInput[];
    features?: FeaturePoint[];
    membership?: MembershipPoint[];
    actions?: CorporateAction[];
}
/** Price columns contain exact safe-integer tick counts, not binary-float prices. */
export interface BarSeries {
    instrument: Instrument;
    openTime: Float64Array;
    closeTime: Float64Array;
    sessionIndex: Uint32Array;
    openTicks: Float64Array;
    highTicks: Float64Array;
    lowTicks: Float64Array;
    closeTicks: Float64Array;
    volume: Float64Array;
    amount: Float64Array;
    tradable: Uint8Array;
    limitUpTicks: Float64Array;
    limitDownTicks: Float64Array;
}
export interface Dataset {
    id: string;
    hash: string;
    metadata: DatasetMetadata;
    series: Map<string, BarSeries>;
    features: FeaturePoint[];
    membership: MembershipPoint[];
    actions: CorporateAction[];
    rowCount: number;
    warnings: Diagnostic[];
}
export interface Diagnostic {
    code: string;
    message: string;
    path?: string;
    count?: number;
}
export type Operator = 'add' | 'sub' | 'mul' | 'div' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'and' | 'or' | 'not' | 'if' | 'sma' | 'ema' | 'rsi' | 'atr' | 'macd' | 'macd_signal' | 'macd_hist' | 'lag' | 'rolling_min' | 'rolling_max' | 'rolling_quantile' | 'cross_up' | 'cross_down' | 'rank' | 'zscore';
export type StateField = 'position' | 'holding_sessions' | 'holding_high' | 'cooldown_sessions';
export type Expression = {
    field: Field;
} | {
    time: 'at';
} | {
    feature: string;
} | {
    ref: string;
} | {
    value: number | boolean;
} | {
    state: StateField;
} | {
    op: Operator;
    args: Expression[];
    period?: number;
    quantile?: number;
    fast?: number;
    slow?: number;
    signal?: number;
};
export interface Action {
    type: 'target_weight' | 'target_quantity' | 'close' | 'order' | 'cancel';
    value?: number;
    side?: Side;
    quantity?: number;
    orderType?: OrderType;
    price?: DecimalString;
    tif?: 'day' | 'gtc';
    tag?: string;
}
export interface Rule {
    when: Expression;
    action: Action;
    symbols?: string[];
}
export interface RulesStrategy {
    kind: 'rules';
    nodes: Record<string, Expression>;
    rules: Rule[];
}
export interface TargetPoint {
    at: number;
    availableAt: number;
    weights?: Record<string, number>;
    quantities?: Record<string, number>;
}
export interface TargetsStrategy {
    kind: 'targets';
    schedule: TargetPoint[];
}
export interface RankStrategy {
    kind: 'rank';
    nodes: Record<string, Expression>;
    score: Expression;
    filter?: Expression;
    topK: number;
    descending: boolean;
    rebalanceEvery: number;
    rebalanceUnit: 'bar' | 'session' | 'week' | 'month';
    weighting: 'equal' | 'score';
    grossWeight: number;
}
export interface ReplayFill {
    at: number;
    symbol: string;
    side: Side;
    quantity: number;
    price: DecimalString;
    fees?: DecimalString;
}
export interface ReplayStrategy {
    kind: 'replay';
    fills: ReplayFill[];
    feePolicy: 'provided' | 'recalculate';
}
export type Strategy = RulesStrategy | TargetsStrategy | RankStrategy | ReplayStrategy;
export interface CostPeriod {
    from: number;
    to?: number;
    commissionRate: DecimalString;
    minimumCommission: DecimalString;
    sellTaxRate: DecimalString;
    transferRate: DecimalString;
}
export interface CostModel {
    version: string;
    scope: 'order' | 'fill';
    periods: CostPeriod[];
}
export interface CashFlow {
    at: number;
    amount: DecimalString;
}
export interface BacktestSpec {
    schemaVersion: '1';
    datasetId?: string;
    start: number;
    end: number;
    account: {
        currency: string;
        initialCash: DecimalString;
        moneyDecimals: number;
        cashFlows: CashFlow[];
    };
    strategy: Strategy;
    costs: CostModel;
    execution: {
        decisionAt: 'bar_close';
        fillAt: 'next_bar_open';
        slippage: {
            type: 'fixed_bps' | 'uniform_bps';
            bps: number;
        };
        intrabarPolicy: 'conservative' | 'reject';
        cashAllocation: 'proportional' | 'priority';
        endPositionPolicy: 'mark_to_market';
        participationRate: number;
        /** next-open participation uses the PREVIOUS completed bar's volume. */
        maxPositionWeight: number;
        stopLossPct?: number;
        takeProfitPct?: number;
        trailingStopPct?: number;
        /** Unspecified retains v1's documented cancel policy. */
        splitOrderPolicy?: 'cancel' | 'adjust';
        maxStaleSessions: number;
        stalePolicy: 'warn' | 'error';
    };
    analytics: {
        annualPeriods: number;
        riskFreeRate: number;
        benchmarkSymbol?: string;
    };
    output: {
        level: OutputLevel;
    };
    seed: number;
    limits: {
        maxBars: number;
        maxOrders: number;
        maxRuntimeMs: number;
        maxNodes: number;
        maxOutputRows: number;
    };
}
export interface Order {
    id: string;
    symbol: string;
    side: Side;
    type: OrderType;
    quantity: number;
    remaining: number;
    submittedAt: number;
    price?: DecimalString;
    tif: 'day' | 'gtc';
    tag?: string;
    status: 'accepted' | 'partial' | 'filled' | 'canceled' | 'expired' | 'rejected';
    reason?: string;
    cumulativeNotional: DecimalString;
    commissionAccruedRaw: DecimalString;
    commissionPaid: DecimalString;
    source: string;
    adjustments?: Array<{ at: number; reason: 'split'; ratio: DecimalString; priorQuantity: number; priorRemaining: number; priorPrice?: DecimalString }>;
    history?: Array<{ at: number; status: Order['status']; remaining: number; reason?: string }>;
}
export interface FeeBreakdown {
    commission: DecimalString;
    tax: DecimalString;
    transfer: DecimalString;
    other?: DecimalString;
    total: DecimalString;
}
export interface Fill {
    id: string;
    orderId: string;
    at: number;
    symbol: string;
    side: Side;
    quantity: number;
    price: DecimalString;
    notional: DecimalString;
    fees: FeeBreakdown;
    cashAfter: DecimalString;
    positionAfter: number;
    reason: string;
}
export interface LedgerEvent {
    id: string;
    at: number;
    type: 'initial' | 'fill' | 'cash_flow' | 'split' | 'dividend_accrual' | 'dividend_payment' | 'delist';
    cashDelta: DecimalString;
    receivableDelta: DecimalString;
    symbol?: string;
    quantityDelta?: number;
    fillId?: string;
    details: Record<string, unknown>;
}
export interface EquityPoint {
    at: number;
    session: string;
    cash: number;
    marketValue: number;
    receivables: number;
    equity: number;
    externalFlow: number;
    unitNav: number;
    staleSymbols: string[];
}
export interface Drawdown {
    value: number;
    peakAt: number;
    troughAt: number;
    recoveredAt: number | null;
}
export interface DrawdownCoverage {
    status: 'complete' | 'incomplete' | 'unverified';
    scope: 'observed_marks';
    frequency: 'day' | 'minute';
    /** Number of missing instrument/session pairs while positions were held. */
    missingSessions: number;
    examples: Array<{ symbol: string; fromSession: string; throughSession: string }>;
    reason?: string;
}
export interface Metrics {
    initialCash: DecimalString;
    finalEquity: DecimalString;
    netExternalFlows: DecimalString;
    netProfit: DecimalString;
    accountReturn: number | null;
    timeWeightedReturn: number | null;
    annualizedReturn: number | null;
    maxDrawdownPct: Drawdown;
    /** Percentage drawdown of raw account equity, including external flows. */
    rawEquityDrawdownPct: Drawdown;
    maxDrawdownAmount: Drawdown;
    drawdownCoverage: DrawdownCoverage;
    annualizedVolatility: number | null;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    fees: DecimalString;
    fillCount: number;
    orderCount: number;
    rejectedOrderCount: number;
    roundTripCount: number;
    winRate: number | null;
    profitFactor: number | null;
    turnover: number | null;
    benchmarkReturn: number | null;
    excessReturn: number | null;
    unavailable: Record<string, string>;
}
export interface BacktestResult {
    schemaVersion: '1';
    engineVersion: string;
    fingerprint: string;
    mode: 'backtest' | 'replay';
    spec: BacktestSpec;
    datasetHash: string;
    metrics: Metrics;
    orders: Order[];
    fills: Fill[];
    events: LedgerEvent[];
    equity: EquityPoint[];
    trace?: DecisionTrace[];
    warnings: Diagnostic[];
    timing: {
        totalMs: number;
        indicatorMs: number | null;
        engineMs: number | null;
        phaseTiming: 'measured' | 'disabled';
    };
}
export interface DecisionTrace {
    at: number;
    symbol: string;
    values: Record<string, number | null>;
    rules?: Array<{ index: number; matched: boolean }>;
    state: Record<StateField, number>;
}
export interface RunHooks {
    /** Per-phase clocks add overhead; enable for profiling rather than throughput runs. */
    measurePhases?: boolean;
    canceled?: () => boolean;
    progress?: (done: number, total: number) => void;
    onFill?: (fill: Fill) => void;
    onEvent?: (event: LedgerEvent) => void;
    onEquity?: (point: EquityPoint) => void;
}
