# Backtest execution and accounting contract

Contract version: **1**. Stage 1 deliverable; a requirement in this document is not evidence that the corresponding capability has been implemented. The capability response and passing acceptance tests must identify the implemented subset. Unsupported requests fail validation rather than silently falling back to a simpler model.

This document defines ts-backtest semantics; public TypeScript field names are defined by the versioned types and schema. Examples and scenarios are synthetic engineering requirements, not collected customer requests.

## 1. Scope and modes

The target release supports a single settlement currency, cash-funded long positions in explicitly configured stocks and ETFs, daily/minute OHLCV bars, and multiple instruments sharing one account. An instrument's name or category must not implicitly determine its settlement, lot, price-limit, fee or currency rules.

Three entry modes share one account ledger:

1. **Rules:** completed-bar indicators and conditions produce order intentions.
2. **Targets:** timestamped target quantities/weights produce executable difference orders.
3. **Ledger replay:** supplied executions, costs and account events are validated and booked without matching them again. Replay is labelled accounting, not evidence that a strategy was executable.

Reject unsupported shorting, implicit borrowing, margin derivatives, options exercise, foreign-exchange conversion, tick/queue simulation and live execution. Unknown order types, operators, cost schedules and market rules are errors. Missing fees are not synonymous with a requested, explicit zero-fee model.

Initial core capabilities can exclude limit/stop orders, partial fills and corporate actions, but must reject affected specifications/data until those capabilities pass their gates. Full-release acceptance requires the supported action types to be reflected in both validation and execution.

## 2. Data and time

- Input data is an immutable, hashed snapshot with timezone, frequency, bar-label meaning, instrument metadata and explicit ordered trading-session dates.
- Every bar belongs to a declared instrument and `sessionId`. Session dates are market dates, not dates obtained by truncating a UTC timestamp. A Friday/Monday transition advances one trading session when that is what the supplied calendar declares.
- Public `BarInput.openTime` and `closeTime` are explicit UTC epoch milliseconds; `session` supplies the separate market-session date. Import adapters must expand date-only/open-labelled/close-labelled inputs using an explicit source convention and calendar, not infer exact execution times from a bare daily date.
- The evaluation range is half-open: **`start <= event.at < end`**. An opening fill is evaluated using its `openTime`; a closing signal/valuation uses its `closeTime`. A close at exactly `end` is outside the range and must not be used to improve a terminal value. The terminal account uses the last available in-range marks and reports incomplete/stale coverage when appropriate.
- Bar-based executions retain the execution phase (`open`, `intrabar`, `close`) in their reason/audit context. Exact event timestamps and deterministic phase sequence jointly determine causality.
- Completed bars before `start` may initialize indicators. They cannot create orders, positions, fees or cash flows for the evaluated account. A bar opening before `start` may supply a later in-range completed close, but its opening phase cannot be traded retroactively.
- The first equity observation is the initial account before its first evaluated event. It remains distinguishable by phase/sequence from a later observation sharing the same timestamp.
- A feature's observation date and information-availability time are distinct. A decision can only read information available at its decision phase. Completed higher-timeframe bars become visible only after they finish. Future lag, interpolation from future observations and full-sample fitting during historical evaluation are rejected.
- Duplicate instrument/bar keys, unsorted data, impossible OHLC ranges, invalid timestamps, non-finite prices and inconsistent units fail validation. Sorting, dropping or imputing requires an explicit import policy and audit report.
- OHLCV input that lacks the fields necessary for a requested execution rule fails validation. In particular, unknown liquidity cannot silently become unlimited liquidity.

Appending later observations must not change earlier causal decisions or fills, except where the original specification explicitly changes the evaluation end policy. Run-end expiry records are compared separately in this prefix-invariance test.

## 3. Deterministic phase order

All instruments at a timestamp are synchronized before account-level actions. Deterministic tie-breaking uses explicit priority followed by instrument/order IDs, never insertion order or worker completion order.

For each evaluated bar slot:

1. Advance the explicit session calendar and release due sellable quantities.
2. Apply effective splits and entitlement events according to their sequence; establish dividend receivables. Pay receivables whose payment events are due.
3. Apply scheduled external cash flows, keeping pre/post-flow valuations using the same available marks.
4. Activate eligible previously submitted orders and execute open-phase orders; execute admissible intrabar order rules if enabled.
5. Calculate each fill's exact costs and atomically update order state, cash and position lots. An invalid fill changes none of those states.
6. Value the account at completed-bar marks, including receivables and external-flow information.
7. Update indicators, cross-sectional rankings and strategy state using completed data.
8. Generate orders for a strictly later permitted execution phase.

Default rules evaluate at bar close and activate at the next available bar's open, subject to expiry and instrument eligibility. An order cannot execute at the same bar's open that precedes its signal. A close-auction model needs a separately supported information cutoff; it cannot reuse final close data for an assumed same-close fill.

Contiguous bars may have `previous.closeTime === next.openTime`. At that timestamp, the previous close phase precedes the next open phase, so a close-generated order may execute at the next open with an equal numeric timestamp. Eligibility must distinguish bar/phase ordering; requiring a strictly later numeric timestamp would incorrectly add another bar of delay. On first entering a new session, settle lots and effective session-start actions before its opening fills, after any preceding close phase at the same time.

Within an execution batch, executable sells precede buys when that policy is selected. Only actual sell proceeds are available to buys. A hypothetical or deferred sale provides no funding.

## 4. Orders, pending requests and matching

Order state transitions are recorded using accepted, partially-filled, filled, canceled, expired and rejected outcomes. An accepted but not yet eligible order is pending; an eligibility reason is retained without inventing a fill.

- Quantities are positive, prices are positive, and directions cannot create a short position in the supported cash-long account.
- Market orders use the eligible opening quote plus the configured adverse slippage, then instrument tick rounding. Tick rounding is adverse (buy up, sell down) unless a different explicit rule is supported. Full-bar high/low must not be used retroactively to improve an opening execution price.
- An order without a quote remains pending under its time-in-force. DAY orders expire at the end of their declared submission trading session; GTC orders survive sessions until filled/canceled or the run ends. An explicit expiry is exclusive: execution at or after expiry is forbidden.
- At run end, unfilled and partially unfilled orders expire with `END_OF_RUN`. Open positions remain marked to market by default. No hidden final liquidation or fee is added. Synthetic terminal liquidation, if supported later, needs an explicit policy and distinct event.
- Missing bars and suspended bars are not executable. A price-limit rule needs the applicable limit metadata; `high == low` alone is not proof of a universal trading prohibition.
- A pending order is not duplicated every time the same target is emitted. Target strategies compare desired holdings against holdings **and outstanding intentions**; changed targets cancel/replace the relevant unfilled intentions deterministically.
- Limit/stop matching, when enabled, defines opening gaps, trigger equality, price priority, validity and slippage. A buy cannot fill above its limit, nor a sell below its limit. Stop-market orders gapped through their trigger use the available opening execution price, not the stale trigger price.
- If one OHLC bar permits multiple incompatible paths, the default is either an explicitly defined conservative outcome or a structured ambiguity rejection. Report the affected order count. Same-bar entry followed by stop/target exit is included in this ambiguity policy.
- Next-open participation limits use liquidity known before that open (for example, the prior completed bar). They must not use the current bar's eventual total volume. A model consuming current-bar final volume is a distinct intrabar/end-of-bar model and must disclose that timing assumption.

All rejection/defer/expiry outcomes include machine-readable reasons and order IDs. No execution is inferred solely from a signal.

## 5. Shared cash, lots and settlement

Target weights reference a declared account valuation time and must satisfy the account exposure limit. Convert targets to quantity differences, apply lot rules, reserve exact costs, then allocate executable buys. The cash-allocation policy is explicit: proportional scaling with deterministic remainder allocation, or stated priority. It must never create negative cash through rounding.

Holdings track total quantity, unsettled quantity, sellable quantity and quantity reserved by outstanding sell orders. A fill creates a lot with the execution session and its release session. With T+N sellability, release happens on the Nth later declared trading session, not after N bars or N times 24 hours. Calendar coverage insufficient to determine a newly purchased lot's release is an error, not guessed from weekdays; an unused possible purchase beyond the run does not require calendar extension.

Buy order lots, minimum quantity increments and full-position odd-lot sales are distinct metadata. An order rounded down to zero is rejected/skipped with a recorded reason. Selling more than the free sellable holding is forbidden, including when another pending sell reserves that holding. Canceled or expired orders release reservations.

Account-funded order quantities are checked again at execution. Price gaps, new fees and prior fills can invalidate the original budget. Rejection or deterministic downsizing follows the configured policy; borrowing is never the fallback.

## 6. Decimal and fee semantics

Indicator arrays and statistical calculations may use binary floating point. Original execution prices, quantity scales and money inputs retain their exact decimal/fixed-point meaning from import; Decimal calculations must not start from already-lossy floating-point products.

Accounting uses Decimal or validated fixed-point arithmetic. Every intermediate integer product must be within its safe range; otherwise use BigInt/Decimal or reject. Decimal precision must cover declared input magnitudes and scales. Serialization emits exact decimal strings for monetary ledger values. Public equity observations may contain Number values for analytics; exact `finalEquity` and `netProfit` must be computed from the exact ledger and exact marked prices, not reconstructed by stringifying an already-rounded Number observation.

Price tick and currency settlement quantum are separate. Each fee component specifies rate, basis, minimum, side, effective dates, quantum and rounding mode. The default contract for currency settlement is decimal `ROUND_HALF_UP`; effective execution price, settled gross consideration and each fee amount are recorded so the equation can be independently checked.

For order-level minimum commission, use this cumulative rule:

```text
cumulativeRawCommission = sum(exact rate-based commission of eligible fills)
cumulativeCommissionDue = max(order minimum, round(cumulativeRawCommission))
commissionOnThisFill = cumulativeCommissionDue - commissionAlreadyBooked
```

The first actual fill can incur the minimum; later partial fills do not each incur it again. An order with zero fills incurs no commission. Canceling the remainder does not refund an already applicable minimum. Fees that legally/contractually apply per fill instead use their own explicit per-fill rule. A schedule transition inside one order must either have a defined versioned treatment or be rejected; it cannot reset the minimum silently.

Buying subtracts settled consideration plus fees; selling adds settled consideration minus fees. The initial implementation must not call host-language `Math.round` a substitute for the decimal contract. An explicit zero-fee model is allowed for tests/research and is disclosed in output.

## 7. Corporate actions, fractions and marks

Trading uses raw execution prices. Adjusted indicator prices are separate, with an identified adjustment model. Adjusted total-return prices plus separately booked dividends must not double-count the same economic return.

Dividend entitlement specifies an eligible quantity snapshot. At the entitlement event, book an **asset receivable**, not spendable cash. Include the receivable in account equity. At payment, transfer the receivable to cash without creating a second profit. Do not infer entitlement from the position held on payment day. Missing entitlement/payment information that affects an account is rejected until the supported policy can handle it.

Splits change holding quantity and cost per unit while preserving total cost basis before explicit cash-in-lieu/taxes. Adjust open order quantities and prices under the configured corporate-action policy, and retain original/adjusted values. Entitled share fractions cannot simply disappear:

Version 1 exposes `execution.splitOrderPolicy`: `cancel` (also the legacy behavior when omitted) cancels pending orders with `SPLIT_CANCEL`; explicit `adjust` retains order IDs and cumulative commission, scales quantities and inverse-scales prices, and records prior values in `Order.adjustments`. Orders whose scaled quantity or price cannot be represented exactly are canceled with `SPLIT_ORDER_UNREPRESENTABLE`, never silently rounded. Historical fills retain their original units; reconstructing current-equivalent filled quantities must apply the intervening split adjustments.

- retain fractions if instrument holding precision supports them, while separately enforcing tradable lot sizes; or
- use a supplied cash-in-lieu price/payment event; or
- reject the unsupported action.

Rounding a split quantity down without compensation is not an admissible default. Odd lots and true fractional shares are different cases.

Valuation may carry forward the last **available** mark for an instrument that has no current bar, with age and stale flags. It cannot turn that mark into an executable quote. A stale threshold produces a warning/error according to policy. Missing initial marks, delisting and terminal unpriced holdings require an explicit policy; unbounded silent carry-forward is forbidden.

Equity is spendable cash + marked holdings + receivables, minus any explicitly represented liabilities. There are no implicit liabilities or leverage in the supported account.

## 8. Returns, withdrawals and drawdowns

External deposits/withdrawals change investor capital, not trading profit. Reject withdrawals beyond available cash; a withdrawal does not implicitly sell holdings. At each external-flow boundary, use the same marks immediately before and after the flow so unitized account value is continuous through the flow.

For a flow C at a boundary (positive for deposit, negative for withdrawal), post-flow equity equals pre-flow equity + C, while NAV per unit is unchanged. Unit counts are adjusted at that NAV. Linking returns between flow boundaries produces TWR. If equity/NAV cannot support meaningful unitization (for example zero/negative value with a subsequent ambiguous restart), return an explicit undefined state rather than a fabricated return.

Return outputs distinguish:

- account profit: terminal equity minus initial capital minus net external contributions;
- simple equity return only where its no-external-flow assumption applies;
- time-weighted return for external-flow comparisons;
- investor money-weighted return only if independently implemented and labelled.

Compute maximum percentage drawdown and maximum monetary drawdown independently. Report each peak, trough and first recovery at or above the peak; unrecovered drawdown has null recovery. Ties choose the earliest qualifying peak/trough to ensure determinism. Do not reuse the percentage drawdown interval for the money drawdown.

The summary names the underlying series. Raw-equity monetary drawdown can contain withdrawal effects and must be labelled accordingly. With cash flows, also report unit-NAV percentage drawdown; do not portray a withdrawal-induced raw-equity fall as strategy loss.

The public metrics distinguish `maxDrawdownPct` (unit NAV), `rawEquityDrawdownPct` (raw account equity, including external flows), and `maxDrawdownAmount` (raw-equity currency amount). Each has its own peak, trough and recovery. A withdrawal from 100 to 80 with no trading loss therefore reports 0%, 20%, and 20 respectively.

`drawdownCoverage` states the valuation scope independently of the observed drawdown value. Missing quotes during held instrument/session pairs produce `status: incomplete`, a count and at most ten example ranges, plus explicit `unavailable` reasons for full-period risk. Cash-only periods do not require instrument prices. The retained drawdown values describe observed/carried marks; a zero observed drawdown never establishes zero full-period risk when coverage is incomplete. Minute quote-cadence completeness is currently `unverified` whenever positions were held, including when session intervals are supplied; intraday coverage is not inferred from a daily session count.

Monetary bookings, terminal equity, account return and terminal unit-NAV return use exact decimal account values. Statistical valuation points use binary floating point. Return/drawdown comparisons ignore differences within eight machine epsilons relative to the larger absolute value (approximately 1.8 × 10⁻¹⁵); there is no absolute currency cutoff. This prevents floating multiplication noise from manufacturing volatility or drawdown while preserving changes above that numerical resolution. Exact cash, cost basis, fees and terminal money are unaffected.

Use the complete chosen valuation frequency, including initial equity, to compute drawdowns. Plot downsampling must not change metrics. Daily data cannot substantiate intraday drawdown. Annualization, benchmark alignment, risk-free return convention, standard-deviation definition and sufficient-sample rules are explicit; undefined statistics return null plus a reason.

## 9. Reproduction and audit invariants

Persist dataset/config/engine/operator/calendar/cost-model versions and hashes, seeds, resolved defaults and the actual supported capabilities. Freeze the input before execution. Results include order-to-fill-to-ledger links, phase/sequence, fee components, cash/position transitions and rejected/deferred reasons.

For every successful booking:

1. Cash movement equals the sum of its exact ledger components.
2. Position movement equals filled quantity plus explicit corporate adjustments.
3. Sellable and reserved quantities are consistent with total holdings and settlement lots.
4. No funded long-only fill creates negative available cash or a short holding.
5. Replaying booked events reproduces final cash, positions, receivables and fees.

Independent backtests may run concurrently. One shared account has a deterministic event sequence. Different worker counts, input ordering and chunk sizes must not change outcomes designated order-independent by this contract. Canceled/interrupted work is not published as a completed run.

The [acceptance matrix](./ACCEPTANCE.md) is the Stage 1 test plan. Later stages must attach executable tests and recorded test results before claiming support.

## 10. Persisted result queries and explanations

Each completed run publishes one immutable directory by atomic rename after all artifacts and their manifest have been written. The manifest records artifact sizes and SHA-256 hashes, the original resolved specification fingerprint, dataset hash, engine version, and available tables. `summary` saves summary metrics; `trades` additionally saves orders and fills; `fullTrace` also saves equity, ledger events and actual decision snapshots. An omitted table raises `DETAILS_NOT_RECORDED`; absence never means zero trades or zero decisions.

Result queries accept a strict table, primitive equality filters, top-level field projections, half-open timestamp bounds and signed continuation cursors. Each page contains at most 200 records and 256 KiB of selected JSON rows. A single oversized row requires a narrower projection. A cursor is bound to its run, artifact hash and query; it cannot be transferred to another run or altered to skip arbitrary records. `orders.adjustments` and `orders.history` are projectable but cannot be used as equality filters.

The current reader streams and verifies the complete selected artifact on **every page**, then returns the selected records. Memory is bounded, but pagination costs O(total table rows) per page, including later pages. This is a deliberate integrity tradeoff in the initial implementation; immutable indexes and verified-hash caching require separate performance evidence and validation before replacement.

Explanations join only persisted order, fill, ledger and decision records. Missing indicator snapshots are explicitly identified. An explanation that requires additional detail must replay the complete original interval with the frozen dataset, engine version and specification, changing only output detail. The resulting run records its own fingerprint and the source run/fingerprint; it does not overwrite the original run or present a shortened replay as equivalent.
