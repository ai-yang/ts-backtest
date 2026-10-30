import { Decimal } from '../spec/decimal.js';
import { assertThat } from '../spec/errors.js';
import type { Ledger } from '../accounting/ledger.js';
import type { BacktestSpec, Dataset, Drawdown, EquityPoint, Metrics, Order } from '../spec/types.js';
import { statisticalDifference, statisticalReturn } from './numeric.js';

/** Values are positive loss magnitudes. Ties retain the earliest peak/trough. */
export function maximumDrawdown(points: readonly EquityPoint[], field: 'equity' | 'unitNav', percentage: boolean): Drawdown {
  assertThat(points.length > 0, 'EMPTY_EQUITY', 'Drawdown needs the initial equity observation');
  let peak = 0, bestPeak = 0, trough = 0, loss = 0;
  for (let i = 1; i < points.length; i++) {
    const value = points[i]![field], peakValue = points[peak]![field];
    if (statisticalDifference(value, peakValue) > 0) { peak = i; continue; }
    const difference = statisticalDifference(peakValue, value);
    const candidate = percentage ? (peakValue > 0 ? difference / peakValue : 0) : difference;
    if (candidate > loss) { loss = candidate; bestPeak = peak; trough = i; }
  }
  let recoveredAt: number | null = loss === 0 ? points[0]!.at : null;
  if (loss > 0) for (let i = trough + 1; i < points.length; i++) if (statisticalDifference(points[i]![field], points[bestPeak]![field]) >= 0) { recoveredAt = points[i]!.at; break; }
  return { value: loss, peakAt: points[bestPeak]!.at, troughAt: points[trough]!.at, recoveredAt };
}

export function calculateMetrics(spec: BacktestSpec, dataset: Dataset, ledger: Ledger, orders: readonly Order[]): Metrics {
  const statistics = ledger.statistics;
  assertThat(statistics.first && statistics.last, 'EMPTY_EQUITY', 'Metrics need an initial equity observation');
  const first = statistics.first, last = statistics.last;
  const unavailable: Record<string, string> = {};
  const final = ledger.equityExact(), initial = new Decimal(spec.account.initialCash);
  const twr = first.unitNav > 0 && Number.isFinite(last.unitNav) ? ledger.unitNavExact().div(first.unitNav).minus(1).toNumber() : null;
  const accountReturn = ledger.netExternalFlows.isZero() && spec.account.cashFlows.length === 0 ? final.div(initial).minus(1).toNumber() : null;
  if (accountReturn === null) unavailable.accountReturn = 'External cash flows require time-weighted return; simple equity return is not comparable';
  const durationYears = (last.at - first.at) / (365.25 * 86_400_000);
  let annualizedReturn = twr !== null && twr > -1 && durationYears > 0 ? Math.expm1(Math.log1p(twr) / durationYears) : null;
  if (annualizedReturn !== null && !Number.isFinite(annualizedReturn)) annualizedReturn = null;
  if (annualizedReturn === null) unavailable.annualizedReturn = 'Requires a positive-duration, positive terminal unit-NAV interval with finite annualization';

  // Daily session-end NAV returns. Minute observations still determine the full-frequency drawdown.
  const daily = statistics.daily;
  let previous = first.unitNav;
  const returns: number[] = [];
  for (const point of daily.values()) {
    if (previous <= 0 || !Number.isFinite(point.unitNav)) { returns.length = 0; break; }
    returns.push(statisticalReturn(point.unitNav, previous)); previous = point.unitNav;
  }
  let volatility: number | null = null, sharpe: number | null = null, sortino: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    volatility = Math.sqrt(variance * spec.analytics.annualPeriods);
    const periodRiskFree = Math.expm1(Math.log1p(spec.analytics.riskFreeRate) / spec.analytics.annualPeriods);
    if (volatility > 0) sharpe = (mean - periodRiskFree) * spec.analytics.annualPeriods / volatility;
    const downside = Math.sqrt(returns.reduce((sum, value) => sum + Math.min(0, value - periodRiskFree) ** 2, 0) / returns.length * spec.analytics.annualPeriods);
    if (downside > 0) sortino = (mean - periodRiskFree) * spec.analytics.annualPeriods / downside;
  }
  if (volatility === null) unavailable.annualizedVolatility = 'At least two session returns are required';
  if (sharpe === null) unavailable.sharpe = 'At least two session returns and nonzero sample volatility are required';
  if (sortino === null) unavailable.sortino = 'At least two session returns and nonzero downside deviation are required';
  const percentage = statistics.drawdownPct();
  const amount = statistics.drawdownAmount();
  const drawdownCoverage = ledger.drawdownCoverage();
  if (drawdownCoverage.status !== 'complete') {
    const reason = drawdownCoverage.reason!;
    unavailable.maxDrawdownPct = reason; unavailable.rawEquityDrawdownPct = reason; unavailable.maxDrawdownAmount = reason;
    unavailable.riskCoverage = 'Volatility and risk-adjusted ratios also use the available valuation series; missing intraperiod prices were not inferred.';
  }
  const wins = ledger.roundTrips.filter(trade => new Decimal(trade.pnl).gt(0));
  const losses = ledger.roundTrips.filter(trade => new Decimal(trade.pnl).lt(0));
  const winTotal = wins.reduce((sum, trade) => sum.plus(trade.pnl), new Decimal(0));
  const lossTotal = losses.reduce((sum, trade) => sum.minus(trade.pnl), new Decimal(0));
  const winRate = ledger.roundTrips.length ? wins.length / ledger.roundTrips.length : null;
  const profitFactor = lossTotal.gt(0) ? winTotal.div(lossTotal).toNumber() : null;
  if (winRate === null) unavailable.winRate = 'No completed flat-to-flat position cycles';
  if (profitFactor === null) unavailable.profitFactor = 'No completed losing position cycle; infinity is not reported';
  const averageEquity = statistics.sum / statistics.count;
  const turnover = averageEquity > 0 ? ledger.grossTurnover.div(averageEquity).toNumber() : null;
  if (turnover === null) unavailable.turnover = 'Requires positive mean observed account equity';

  let benchmarkReturn: number | null = null;
  const benchmarkSymbol = spec.analytics.benchmarkSymbol;
  if (benchmarkSymbol) {
    const series = dataset.series.get(benchmarkSymbol);
    const hasActions = dataset.actions.some(action => action.symbol === benchmarkSymbol && action.at >= spec.start && action.at <= last.at);
    if (hasActions) unavailable.benchmarkReturn = 'Benchmark has corporate actions; a raw price ratio would misstate a comparable holding return';
    else if (series) {
      let firstPrice: number | undefined, lastPrice: number | undefined;
      let firstTime = -Infinity, lastTime = -Infinity;
      for (let i = 0; i < series.closeTime.length; i++) {
        // Begin at the latest already-available price, not the first future closing price.
        for (const [at, price] of [[series.closeTime[i]!, series.closeTicks[i]!], [series.openTime[i]!, series.openTicks[i]!]] as const) {
          if (at <= spec.start && at >= firstTime) { firstTime = at; firstPrice = price; }
          if (at <= last.at && at < spec.end && at >= lastTime) { lastTime = at; lastPrice = price; }
        }
      }
      if (firstPrice !== undefined && lastPrice !== undefined && firstPrice > 0 && lastTime >= firstTime) benchmarkReturn = lastPrice / firstPrice - 1;
    }
    if (benchmarkReturn === null && !unavailable.benchmarkReturn) unavailable.benchmarkReturn = 'Benchmark must have a price available at the account start and an available terminal price';
  } else unavailable.benchmarkReturn = 'No benchmark was supplied';
  const excessReturn = benchmarkReturn !== null && twr !== null ? twr - benchmarkReturn : null;
  if (excessReturn === null) unavailable.excessReturn = 'Requires a benchmark return and account time-weighted return';
  if (spec.account.cashFlows.length) unavailable.maxDrawdownAmountBasis = 'Monetary drawdown uses raw account equity and may include withdrawal effects; percentage drawdown uses unit NAV';
  if (twr === null) unavailable.timeWeightedReturn = 'Initial/terminal unit NAV does not define a finite return';
  const calmar = annualizedReturn !== null && percentage.value > 0 ? annualizedReturn / percentage.value : null;
  if (calmar === null) unavailable.calmar = 'Requires finite annualized return and a nonzero unit-NAV drawdown';

  return {
    initialCash: ledger.money(initial), finalEquity: ledger.money(final), netExternalFlows: ledger.money(ledger.netExternalFlows), netProfit: ledger.money(final.minus(initial).minus(ledger.netExternalFlows)),
    accountReturn, timeWeightedReturn: twr, annualizedReturn, maxDrawdownPct: percentage, rawEquityDrawdownPct: statistics.rawEquityDrawdownPct(), maxDrawdownAmount: amount, drawdownCoverage,
    annualizedVolatility: volatility, sharpe, sortino, calmar,
    fees: ledger.money(ledger.feesTotal), fillCount: ledger.fillCount, orderCount: orders.length, rejectedOrderCount: orders.filter(o => o.status === 'rejected').length,
    roundTripCount: ledger.roundTrips.length, winRate, profitFactor, turnover, benchmarkReturn, excessReturn, unavailable,
  };
}
