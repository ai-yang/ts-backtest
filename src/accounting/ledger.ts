import { Decimal } from '../spec/decimal.js';
import { assertThat } from '../spec/errors.js';
import { EquityStatistics } from '../analytics/equity-statistics.js';
import type { BacktestSpec, CorporateAction, CostPeriod, Dataset, Diagnostic, DrawdownCoverage, EquityPoint, FeeBreakdown, Fill, Instrument, LedgerEvent, Order, RunHooks } from '../spec/types.js';

interface Lot { quantity: number; basis: Decimal; releaseSession: number }
interface Price { numeric: number; exact?: Decimal; ticks?: number; tickSize?: string }
const exactPrice = (price: Price): Decimal => price.exact ??= new Decimal(price.tickSize!).mul(price.ticks!);
const decimalPrice = (value: Decimal): Price => ({ numeric: value.toNumber(), exact: value });
const priceGreater = (a:Price,b:Price):boolean => a.ticks!==undefined&&b.ticks!==undefined&&a.tickSize===b.tickSize
  ? a.ticks>b.ticks : exactPrice(a).gt(exactPrice(b));
interface Position {
  lots: Lot[];
  quantity: number;
  openedAt: number;
  openedSession: number;
  lastExitSession: number | null;
  high: Price;
  cycleBuys: Decimal;
  cycleReceipts: Decimal;
}
interface Mark { price: Price; at: number; session: number }
interface Receivable { symbol: string; amount: Decimal; payAt: number; paid: boolean }
export interface RoundTrip { symbol: string; openedAt: number; closedAt: number; pnl: string }

/** One cash-long, single-currency account. Matching and pending-order reservations live outside it. */
export class Ledger {
  readonly fills: Fill[] = [];
  readonly events: LedgerEvent[] = [];
  readonly equity: EquityPoint[] = [];
  readonly warnings: Diagnostic[] = [];
  readonly roundTrips: RoundTrip[] = [];
  readonly statistics = new EquityStatistics();
  fillCount = 0;
  eventCount = 0;
  grossTurnover = new Decimal(0);
  private _cash: Decimal;
  private _receivables = new Decimal(0);
  private _netExternalFlows = new Decimal(0);
  private _feesTotal = new Decimal(0);
  private units: Decimal;
  private numericCash = 0;
  private numericReceivables = 0;
  private numericUnits = 0;
  private lastEmptyNav = new Decimal(1);
  private pendingFlow = 0;
  private positions = new Map<string, Position>();
  private marks = new Map<string, Mark>();
  private instruments: Map<string, Instrument>;
  private dividends: Receivable[] = [];
  private appliedActions = new Set<string>();
  private staleWarnings = new Set<string>();
  private everHeld = false;
  private missingQuoteSessions = 0;
  private missingQuoteThrough = new Map<string, number>();
  private missingQuoteExamples: DrawdownCoverage['examples'] = [];

  constructor(readonly spec: BacktestSpec, readonly dataset: Dataset, private readonly hooks: RunHooks = {}) {
    this._cash = new Decimal(spec.account.initialCash);
    this.units = new Decimal(spec.account.initialCash);
    this.refreshNumeric();
    this.instruments = new Map(dataset.metadata.instruments.map(i => [i.symbol, i]));
    this.event(spec.start, 'initial', this._cash, new Decimal(0), { initialCash: this.money(this._cash) });
    this.recordEquity(spec.start, this.sessionAt(spec.start));
  }

  get cash(): Decimal { return this._cash; }
  get receivables(): Decimal { return this._receivables; }
  get netExternalFlows(): Decimal { return this._netExternalFlows; }
  get feesTotal(): Decimal { return this._feesTotal; }
  get lastEquity(): EquityPoint { return this.statistics.last!; }
  private refreshNumeric(): void { this.numericCash=this._cash.toNumber();this.numericReceivables=this._receivables.toNumber();this.numericUnits=this.units.toNumber(); }

  private quoteGap(symbol: string, from: number, through: number): void {
    from = Math.max(from, (this.missingQuoteThrough.get(symbol) ?? -1) + 1);
    if (through < from) return;
    this.missingQuoteSessions += through - from + 1; this.missingQuoteThrough.set(symbol, through);
    if (this.missingQuoteExamples.length < 10) this.missingQuoteExamples.push({ symbol, fromSession: this.dataset.metadata.sessions[from]!, throughSession: this.dataset.metadata.sessions[through]! });
    if (!this.warnings.some(warning => warning.code === 'INCOMPLETE_VALUATION_COVERAGE')) this.warnings.push({ code: 'INCOMPLETE_VALUATION_COVERAGE', message: 'Held positions lack quotes in some declared sessions; risk metrics describe observed/carried marks, not complete-period price paths' });
  }
  drawdownCoverage(): DrawdownCoverage {
    const status = this.missingQuoteSessions ? 'incomplete' : this.everHeld && this.dataset.metadata.frequency === 'minute' ? 'unverified' : 'complete';
    return { status, scope: 'observed_marks', frequency: this.dataset.metadata.frequency, missingSessions: this.missingQuoteSessions, examples: [...this.missingQuoteExamples],
      ...(status === 'incomplete' ? { reason: 'Held instrument/session pairs have no available quote; recorded drawdowns are limited to observed and carried marks, not full-period risk.' }
        : status === 'unverified' ? { reason: 'Intraday quote-cadence completeness has not been verified; minute drawdowns use observed marks only, even when session intervals are supplied.' } : {}) };
  }
  money(value: Decimal | string | number): string { return new Decimal(value).toFixed(this.spec.account.moneyDecimals, Decimal.ROUND_HALF_UP); }
  private settled(value: Decimal): Decimal { return value.toDecimalPlaces(this.spec.account.moneyDecimals, Decimal.ROUND_HALF_UP); }

  private instrument(symbol: string): Instrument {
    const instrument = this.instruments.get(symbol);
    assertThat(instrument, 'UNKNOWN_INSTRUMENT', `No instrument metadata for ${symbol}`);
    return instrument;
  }

  private holding(symbol: string): Position {
    this.instrument(symbol);
    let p = this.positions.get(symbol);
    if (!p) {
      p = { lots: [], quantity: 0, openedAt: 0, openedSession: 0, lastExitSession: null, high: decimalPrice(new Decimal(0)), cycleBuys: new Decimal(0), cycleReceipts: new Decimal(0) };
      this.positions.set(symbol, p);
    }
    return p;
  }

  position(symbol: string): number { return this.positions.get(symbol)?.quantity ?? 0; }
  sellable(symbol: string, sessionIndex: number): number {
    return this.positions.get(symbol)?.lots.reduce((sum, lot) => sum + (lot.releaseSession <= sessionIndex ? lot.quantity : 0), 0) ?? 0;
  }
  averageEntryExact(symbol: string): Decimal {
    const p = this.positions.get(symbol);
    return p?.quantity ? p.lots.reduce((sum, lot) => sum.plus(lot.basis), new Decimal(0)).div(p.quantity) : new Decimal(0);
  }
  averageEntry(symbol: string): number { return this.averageEntryExact(symbol).toNumber(); }
  holdingHighExact(symbol: string): Decimal { const price=this.positions.get(symbol)?.high;return price?exactPrice(price):new Decimal(0); }
  state(symbol: string, sessionIndex: number): { position: number; holding_sessions: number; holding_high: number; cooldown_sessions: number } {
    const p = this.positions.get(symbol);
    return { position: p?.quantity ?? 0, holding_sessions: p?.quantity ? sessionIndex - p.openedSession : 0,
      holding_high: p?.quantity ? p.high.numeric : 0,
      cooldown_sessions: p?.lastExitSession === null || p?.lastExitSession === undefined ? Number.MAX_SAFE_INTEGER : sessionIndex - p.lastExitSession };
  }

  private costPeriod(at: number): CostPeriod {
    const period = this.spec.costs.periods.find(p => p.from <= at && (p.to === undefined || at < p.to));
    assertThat(period, 'COST_PERIOD_GAP', `No cost schedule covers ${at}`);
    return period;
  }

  estimateCosts(order: Order, quantity: number, price: string, at: number): FeeBreakdown {
    const p = this.costPeriod(at);
    const notional = new Decimal(price).mul(quantity);
    const rawCommission = notional.mul(p.commissionRate);
    const commission = this.spec.costs.scope === 'order'
      ? Decimal.max(0, Decimal.max(p.minimumCommission, this.settled(new Decimal(order.commissionAccruedRaw).plus(rawCommission))).minus(order.commissionPaid))
      : Decimal.max(p.minimumCommission, this.settled(rawCommission));
    const tax = order.side === 'sell' ? this.settled(notional.mul(p.sellTaxRate)) : new Decimal(0);
    const transfer = this.settled(notional.mul(p.transferRate));
    return { commission: this.money(commission), tax: this.money(tax), transfer: this.money(transfer), total: this.money(commission.plus(tax).plus(transfer)) };
  }

  /** Use quantityStep=1 for partial fills of an already-valid whole-lot order. */
  affordableQuantity(order: Order, price: string, at: number, maxQuantity: number, budget: Decimal = this._cash, quantityStep = this.instrument(order.symbol).lotSize): number {
    assertThat(Number.isSafeInteger(maxQuantity) && maxQuantity >= 0 && Number.isSafeInteger(quantityStep) && quantityStep > 0, 'INVALID_QUANTITY', 'Affordability requires nonnegative safe-integer quantities');
    const available = Decimal.min(this._cash, budget);
    let low = 0, high = Math.floor(maxQuantity / quantityStep);
    while (low < high) {
      const middle = low + Math.ceil((high - low) / 2);
      const quantity = middle * quantityStep;
      const required = this.settled(new Decimal(price).mul(quantity)).plus(this.estimateCosts(order, quantity, price, at).total);
      if (required.lte(available)) low = middle; else high = middle - 1;
    }
    return low * quantityStep;
  }

  fill(order: Order, quantity: number, price: string, at: number, sessionIndex: number, reason = 'execution', providedFees?: string): Fill {
    assertThat(Number.isSafeInteger(quantity) && quantity > 0 && quantity <= order.remaining, 'INVALID_QUANTITY', 'Fill quantity must be positive and no greater than the remaining order');
    assertThat(order.status === 'accepted' || order.status === 'partial', 'INVALID_ORDER_STATE', 'Only live orders can fill');
    assertThat(Number.isSafeInteger(sessionIndex) && sessionIndex >= 0 && sessionIndex < this.dataset.metadata.sessions.length, 'UNKNOWN_SESSION', 'Fill session is not in the explicit calendar');
    const instrument = this.instrument(order.symbol);
    const executionPrice = new Decimal(price);
    assertThat(executionPrice.isFinite() && executionPrice.gt(0) && executionPrice.div(instrument.tickSize).isInteger(), 'INVALID_PRICE', 'Execution price must be positive and tick aligned');
    const rawNotional = executionPrice.mul(quantity);
    const notional = this.settled(rawNotional);
    const fees: FeeBreakdown = providedFees === undefined ? this.estimateCosts(order, quantity, price, at)
      : { commission: this.money(0), tax: this.money(0), transfer: this.money(0), other: this.money(providedFees), total: this.money(providedFees) };
    assertThat(new Decimal(fees.total).gte(0), 'INVALID_FEE', 'Fees cannot be negative');
    const charge = new Decimal(fees.total);
    const cashDelta = order.side === 'buy' ? notional.plus(charge).negated() : notional.minus(charge);
    assertThat(this._cash.plus(cashDelta).gte(0), 'INSUFFICIENT_CASH', 'Execution would make cash negative');
    const p = this.holding(order.symbol);
    const highPrice=decimalPrice(executionPrice), highTicks=executionPrice.div(instrument.tickSize).toNumber();
    if(Number.isSafeInteger(highTicks)){highPrice.ticks=highTicks;highPrice.tickSize=instrument.tickSize;}
    const releaseSession = sessionIndex + instrument.settlementDays;
    if (order.side === 'buy') {
      assertThat(releaseSession < this.dataset.metadata.sessions.length, 'SETTLEMENT_CALENDAR_INCOMPLETE', 'Explicit calendar does not cover this bought lot release session');
      assertThat(Number.isSafeInteger(p.quantity + quantity), 'INVALID_QUANTITY', 'Position quantity exceeds safe integer bounds');
    } else assertThat(quantity <= this.sellable(order.symbol, sessionIndex), 'INSUFFICIENT_SELLABLE', 'Execution exceeds settled sellable shares');

    const priorMark = this.marks.get(order.symbol);
    if (p.quantity && priorMark && priorMark.session < sessionIndex) this.quoteGap(order.symbol, Math.max(p.openedSession, priorMark.session + 1), sessionIndex);

    // All financially fallible validation above precedes the first account or order mutation.
    this._cash = this._cash.plus(cashDelta);
    this._feesTotal = this._feesTotal.plus(charge);
    if (order.side === 'buy') {
      this.everHeld = true;
      if (p.quantity === 0) { p.openedAt = at; p.openedSession = sessionIndex; p.high = highPrice; p.cycleBuys = new Decimal(0); p.cycleReceipts = new Decimal(0); }
      p.lots.push({ quantity, basis: notional.plus(charge), releaseSession });
      p.quantity += quantity;
      p.cycleBuys = p.cycleBuys.plus(notional).plus(charge);
      if(priceGreater(highPrice,p.high))p.high=highPrice;
    } else {
      let left = quantity;
      for (const lot of p.lots) {
        if (left === 0) break;
        if (lot.releaseSession > sessionIndex) continue;
        const removed = Math.min(left, lot.quantity);
        lot.basis = removed === lot.quantity ? new Decimal(0) : lot.basis.mul(lot.quantity - removed).div(lot.quantity);
        lot.quantity -= removed; left -= removed;
      }
      p.lots = p.lots.filter(lot => lot.quantity > 0);
      p.quantity -= quantity;
      p.cycleReceipts = p.cycleReceipts.plus(notional).minus(charge);
      this.closeCycle(order.symbol, p, at, sessionIndex);
    }
    order.remaining -= quantity;
    order.status = order.remaining === 0 ? 'filled' : 'partial';
    (order.history ??= []).push({ at, status: order.status, remaining: order.remaining, reason });
    order.cumulativeNotional = new Decimal(order.cumulativeNotional).plus(rawNotional).toFixed();
    if (providedFees === undefined) order.commissionAccruedRaw = new Decimal(order.commissionAccruedRaw).plus(rawNotional.mul(this.costPeriod(at).commissionRate)).toFixed();
    order.commissionPaid = new Decimal(order.commissionPaid).plus(fees.commission).toFixed();
    const fill: Fill = { id: `fill-${++this.fillCount}`, orderId: order.id, at, symbol: order.symbol, side: order.side, quantity, price: executionPrice.toFixed(), notional: this.money(notional), fees,
      cashAfter: this.money(this._cash), positionAfter: p.quantity, reason };
    this.grossTurnover=this.grossTurnover.plus(notional);
    if(this.spec.output.level!=='summary')this.fills.push(fill);
    this.event(at, 'fill', cashDelta, new Decimal(0), { orderId: order.id, price: fill.price, notional: fill.notional, fees, reason }, order.symbol, order.side === 'buy' ? quantity : -quantity, fill.id);
    this.hooks.onFill?.(fill);
    return fill;
  }

  cashFlow(amount: string, at: number): void {
    const flow = new Decimal(amount);
    assertThat(flow.isFinite() && flow.decimalPlaces() <= this.spec.account.moneyDecimals, 'INVALID_CASH_FLOW', 'Cash flow precision exceeds settlement quantum');
    assertThat(this._cash.plus(flow).gte(0), 'INSUFFICIENT_CASH', 'Withdrawal exceeds spendable cash');
    const before = this.equityExact();
    const nav = this.units.isZero() ? this.lastEmptyNav : before.div(this.units);
    assertThat(nav.gt(0) && nav.isFinite(), 'UNDEFINED_UNIT_NAV', 'Cannot unitize cash flows at nonpositive account NAV');
    const units = this.units.plus(flow.div(nav));
    assertThat(units.gte(0), 'INVALID_CASH_FLOW', 'Cash flow would make fund units negative');
    this.units = units; this.lastEmptyNav = nav;
    this._cash = this._cash.plus(flow); this.pendingFlow += flow.toNumber(); this._netExternalFlows = this._netExternalFlows.plus(flow);
    this.event(at, 'cash_flow', flow, new Decimal(0), { navBefore: nav.toFixed(), unitsAfter: units.toFixed(), equityBefore: this.money(before) });
  }

  corporateAction(action: CorporateAction, sessionIndex: number): void {
    const key = JSON.stringify(action);
    assertThat(!this.appliedActions.has(key), 'DUPLICATE_ACTION', 'Corporate action already applied');
    const p = this.holding(action.symbol);
    const priorMark = this.marks.get(action.symbol);
    if (p.quantity && priorMark && sessionIndex > priorMark.session + 1) this.quoteGap(action.symbol, Math.max(p.openedSession, priorMark.session + 1), sessionIndex - 1);
    if (action.type === 'dividend') {
      const amount = this.settled(new Decimal(action.amountPerShare).mul(p.quantity));
      assertThat(amount.gte(0) && action.payAt >= action.at, 'INVALID_ACTION', 'Dividend must be nonnegative and paid no earlier than accrual');
      this._receivables = this._receivables.plus(amount);
      p.cycleReceipts = p.cycleReceipts.plus(amount);
      this.dividends.push({ symbol: action.symbol, amount, payAt: action.payAt, paid: false });
      this.event(action.at, 'dividend_accrual', new Decimal(0), amount, { entitledQuantity: p.quantity, amountPerShare: action.amountPerShare, payAt: action.payAt }, action.symbol);
    } else if (action.type === 'split') {
      const ratio = new Decimal(action.ratio);
      assertThat(ratio.gt(0), 'INVALID_ACTION', 'Split ratio must be positive');
      const exactQuantity = new Decimal(p.quantity).mul(ratio);
      assertThat(exactQuantity.lte(Number.MAX_SAFE_INTEGER), 'INVALID_QUANTITY', 'Split position exceeds exact quantity range');
      const totalQuantity = exactQuantity.floor().toNumber();
      const fraction = exactQuantity.minus(totalQuantity);
      assertThat(fraction.isZero() || action.cashInLieuPrice !== undefined, 'FRACTIONAL_SPLIT_UNSUPPORTED', 'Fractional split requires an explicit cash-in-lieu price');
      const cashPrice = new Decimal(action.cashInLieuPrice ?? '0');
      assertThat(cashPrice.gte(0), 'INVALID_ACTION', 'Cash-in-lieu price cannot be negative');
      const cashInLieu = this.settled(fraction.mul(cashPrice));
      // Preserve FIFO basis. Carry sub-share entitlements into the following lot,
      // including their cost and latest release session, instead of losing them
      // or averaging the cost of economically distinct purchase lots.
      let carryQuantity = new Decimal(0), carryBasis = new Decimal(0), carryRelease = 0;
      const nonempty: Lot[] = [];
      for (const lot of p.lots) {
        const transformed = new Decimal(lot.quantity).mul(ratio);
        const available = transformed.plus(carryQuantity), quantity = available.floor().toNumber();
        const releaseSession = Math.max(lot.releaseSession, carryRelease);
        if (quantity) {
          const usedNewBasis = lot.basis.mul(new Decimal(quantity).minus(carryQuantity)).div(transformed);
          nonempty.push({ quantity, basis: carryBasis.plus(usedNewBasis), releaseSession });
          carryBasis = lot.basis.minus(usedNewBasis);
        } else carryBasis = carryBasis.plus(lot.basis);
        carryQuantity = available.minus(quantity); carryRelease = releaseSession;
      }
      const retainedBasis = nonempty.reduce((sum, lot) => sum.plus(lot.basis), new Decimal(0));
      const oldQuantity = p.quantity;
      p.lots = nonempty; p.quantity = totalQuantity;
      p.high = decimalPrice(exactPrice(p.high).div(ratio));
      p.cycleReceipts = p.cycleReceipts.plus(cashInLieu);
      this._cash = this._cash.plus(cashInLieu);
      const mark = this.marks.get(action.symbol);
      if (mark) this.marks.set(action.symbol, { ...mark, price: decimalPrice(exactPrice(mark.price).div(ratio)) });
      this.event(action.at, 'split', cashInLieu, new Decimal(0), { ratio: action.ratio, fractionalQuantity: fraction.toFixed(), cashInLieuPrice: action.cashInLieuPrice ?? null, cashInLieu: this.money(cashInLieu), priorQuantity: oldQuantity, retainedBasis: retainedBasis.toFixed() }, action.symbol, totalQuantity - oldQuantity);
      this.closeCycle(action.symbol, p, action.at, sessionIndex);
    } else {
      const cashPrice = new Decimal(action.cashPrice);
      assertThat(cashPrice.gte(0), 'INVALID_ACTION', 'Delisting compensation cannot be negative');
      const prior = p.quantity, proceeds = this.settled(cashPrice.mul(prior));
      p.cycleReceipts = p.cycleReceipts.plus(proceeds);
      p.quantity = 0; p.lots = []; this._cash = this._cash.plus(proceeds);
      this.event(action.at, 'delist', proceeds, new Decimal(0), { cashPrice: action.cashPrice }, action.symbol, -prior);
      this.closeCycle(action.symbol, p, action.at, sessionIndex);
    }
    this.appliedActions.add(key);
    this.payDividends(action.at);
  }

  payDividends(at: number): void {
    for (const d of this.dividends) if (!d.paid && d.payAt <= at) {
      d.paid = true; this._receivables = this._receivables.minus(d.amount); this._cash = this._cash.plus(d.amount);
      this.event(d.payAt, 'dividend_payment', d.amount, d.amount.negated(), { amount: this.money(d.amount), paidAt: d.payAt }, d.symbol);
    }
  }

  observeHigh(symbol: string, price: string): void {
    const p = this.positions.get(symbol);
    if (p?.quantity) { const value=new Decimal(price);if(value.gt(exactPrice(p.high)))p.high=decimalPrice(value); }
  }

  observeHighTicks(symbol:string,ticks:number):void {
    const p=this.positions.get(symbol);if(!p?.quantity)return;
    const tickSize=this.instrument(symbol).tickSize,numeric=ticks*Number(tickSize);
    const price={numeric,ticks,tickSize};if(priceGreater(price,p.high))p.high=price;
  }
  hasMark(symbol:string):boolean{return this.marks.has(symbol);}
  markExact(symbol:string):Decimal { const mark=this.marks.get(symbol);assertThat(mark,'MISSING_MARK',`No available mark for ${symbol}`);return exactPrice(mark.price); }
  setMarkTicks(symbol:string,ticks:number,at:number,sessionIndex:number):void {
    const tickSize=this.instrument(symbol).tickSize;
    assertThat(Number.isSafeInteger(ticks)&&ticks>=0,'INVALID_MARK','Mark ticks must be an exact nonnegative integer');
    const existing=this.marks.get(symbol);assertThat(!existing||at>=existing.at,'MARK_TIME_REVERSED','Cannot replace a mark with an earlier observation');
    const price:Price={numeric:ticks*Number(tickSize),ticks,tickSize};
    const p=this.positions.get(symbol);
    if(p?.quantity&&existing&&sessionIndex>existing.session+1)this.quoteGap(symbol,Math.max(p.openedSession,existing.session+1),sessionIndex-1);
    this.marks.set(symbol,{price,at,session:sessionIndex});
    if(p?.quantity&&priceGreater(price,p.high))p.high=price;
  }

  setMark(symbol: string, price: string, at: number, sessionIndex: number): void {
    this.instrument(symbol);
    const value = new Decimal(price);
    assertThat(value.isFinite() && value.gte(0), 'INVALID_MARK', 'Mark price must be finite and nonnegative');
    const existing = this.marks.get(symbol);
    assertThat(!existing || at >= existing.at, 'MARK_TIME_REVERSED', 'Cannot replace a mark with an earlier observation');
    const position = this.positions.get(symbol);
    if (position?.quantity && existing && sessionIndex > existing.session + 1) this.quoteGap(symbol, Math.max(position.openedSession, existing.session + 1), sessionIndex - 1);
    this.marks.set(symbol, { price: decimalPrice(value), at, session: sessionIndex });
    this.observeHigh(symbol, price);
  }

  equityExact(): Decimal {
    let equity = this._cash.plus(this._receivables);
    for (const [symbol, p] of this.positions) if (p.quantity) {
      const mark = this.marks.get(symbol);
      assertThat(mark, 'MISSING_MARK', `No available mark for open position ${symbol}`);
      equity = equity.plus(exactPrice(mark.price).mul(p.quantity));
    }
    return equity;
  }

  unitNavExact(): Decimal { return this.units.isZero() ? this.lastEmptyNav : this.equityExact().div(this.units); }

  recordEquity(at: number, sessionIndex: number): EquityPoint {
    const staleSymbols: string[] = [];
    for (const [symbol, p] of this.positions) if (p.quantity) {
      const mark = this.marks.get(symbol);
      assertThat(mark, 'MISSING_MARK', `No available mark for open position ${symbol}`);
      assertThat(mark.at <= at, 'FUTURE_MARK', `Future mark is not available for ${symbol}`);
      if (mark.at < at) staleSymbols.push(symbol);
      const age = sessionIndex - mark.session;
      if (age > 0) this.quoteGap(symbol, Math.max(p.openedSession, mark.session + 1), sessionIndex);
      if (age > this.spec.execution.maxStaleSessions) {
        assertThat(this.spec.execution.stalePolicy !== 'error', 'STALE_MARK', `Mark for ${symbol} is ${age} sessions old`);
        const key = `${symbol}/${sessionIndex}`;
        if (!this.staleWarnings.has(key)) { this.staleWarnings.add(key); this.warnings.push({ code: 'STALE_MARK', message: `Mark for ${symbol} is ${age} sessions old` }); }
      }
    }
    let marketValue=0;for(const [symbol,p] of this.positions)if(p.quantity)marketValue+=this.marks.get(symbol)!.price.numeric*p.quantity;
    const equity=this.numericCash+this.numericReceivables+marketValue;
    const nav=this.numericUnits===0?this.lastEmptyNav.toNumber():equity/this.numericUnits;
    const point: EquityPoint = { at, session: this.dataset.metadata.sessions[sessionIndex] ?? '', cash: this.numericCash, marketValue, receivables: this.numericReceivables, equity, externalFlow: this.pendingFlow, unitNav: nav, staleSymbols: staleSymbols.sort() };
    assertThat(Object.values(point).filter(v => typeof v === 'number').every(v => Number.isFinite(v)), 'ANALYTICS_OVERFLOW', 'Account cannot be represented by finite analytics values');
    this.pendingFlow = 0;
    this.statistics.add(point);
    if(this.spec.output.level==='fullTrace')this.equity.push(point); this.hooks.onEquity?.(point);
    return point;
  }

  private closeCycle(symbol: string, p: Position, at: number, sessionIndex: number): void {
    if (p.quantity === 0 && p.cycleBuys.gt(0)) {
      this.roundTrips.push({ symbol, openedAt: p.openedAt, closedAt: at, pnl: this.money(p.cycleReceipts.minus(p.cycleBuys)) });
      p.lastExitSession = sessionIndex; p.high = decimalPrice(new Decimal(0)); p.cycleBuys = new Decimal(0); p.cycleReceipts = new Decimal(0);
    }
  }

  private event(at: number, type: LedgerEvent['type'], cashDelta: Decimal, receivableDelta: Decimal, details: Record<string, unknown>, symbol?: string, quantityDelta?: number, fillId?: string): void {
    this.refreshNumeric();
    const event: LedgerEvent = { id: `event-${++this.eventCount}`, at, type, cashDelta: this.money(cashDelta), receivableDelta: this.money(receivableDelta), details, ...(symbol === undefined ? {} : { symbol }), ...(quantityDelta === undefined ? {} : { quantityDelta }), ...(fillId === undefined ? {} : { fillId }) };
    if(this.spec.output.level==='fullTrace')this.events.push(event); this.hooks.onEvent?.(event);
  }

  private sessionAt(at: number): number {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.dataset.metadata.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const date = ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-');
    const index = this.dataset.metadata.sessions.findIndex(session => session >= date);
    return index < 0 ? this.dataset.metadata.sessions.length - 1 : index;
  }
}
