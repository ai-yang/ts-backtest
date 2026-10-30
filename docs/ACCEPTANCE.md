# Acceptance scenarios and stage gates

Status: **implemented acceptance mapping, audited 2026-10-30**. The 25 scenarios below are representative **synthetic engineering requirements** derived from the design. Their executable fixtures are synthetic too: they are not collected user requests, production observations, evidence of investment performance, or a measured real-user strategy-coverage rate.

The execution rules are defined in [CONTRACT.md](CONTRACT.md). The matrix below maps the supported branches to actual test files and named cases. Some fixtures use different prices or timestamps while checking the same invariant; the prose is a requirement, not a claim that every possible combination has been enumerated. Unsupported alternatives are identified explicitly and do not count as implemented positive capabilities. Latest complete-suite and release-gate counts belong in [PROGRESS.md](PROGRESS.md).

## Executable acceptance matrix

“Pass” below means executable regression evidence for the declared supported semantics. It does not replace final release measurements or expand the support matrix.

| Scenario | Actual executable evidence / named cases | Audited status and boundary |
|---|---|---|
| AC-01 | [engine-strategy.test.ts](../test/engine-strategy.test.ts): `engine warms indicators from pre-start bars without trading before start`; `a close exactly at end cannot improve terminal valuation`. [engine.test.ts](../test/engine.test.ts): `evaluation end is exclusive, with no synthetic liquidation`; order audit expiry test. | Pass: warmup cannot trade; end-exclusive valuation and final order audit. |
| AC-02 | [engine.test.ts](../test/engine.test.ts): `golden next-open roundtrip: cash, positions and ledger reconcile exactly`. [engine-strategy.test.ts](../test/engine-strategy.test.ts): `same-timestamp minute close decisions fill at the adjacent next-minute open`; future-prefix test. | Pass: next-open and contiguous close/open phases, exact account reconciliation. |
| AC-03 | [data-contract.test.ts](../test/data-contract.test.ts): `data contract rejects unsorted, overlapping, malformed and wrong-session prices`. [import.test.ts](../test/import.test.ts): explicit-zone timestamps, JSON precision loss, duplicate CSV header cases. [contracts.test.ts](../test/contracts.test.ts): metadata/currency/tick validation. | Pass: strict rejection. Automatic sorting/repair is not implemented or advertised. |
| AC-04 | [engine-strategy.test.ts](../test/engine-strategy.test.ts): `feature observations cannot trigger orders before publication`; future data/publication prefix case. [frames.test.ts](../test/frames.test.ts): `week and month completion follows the entire declared calendar, including unseen future bars`; partial-source prefix case. [strategy.test.ts](../test/strategy.test.ts): rejected future/skipped updates. | Pass: publication time, completed higher frames, lag and future-prefix invariance. |
| AC-05 | [engine.test.ts](../test/engine.test.ts): `AC-05 missing quote keeps a GTC intention pending until the next actual bar`. [engine-strategy.test.ts](../test/engine-strategy.test.ts): `daily DAY orders expire in submission session while GTC targets survive to next open`. | Pass for DAY/GTC; arbitrary user-supplied expiry timestamps are not an exposed order option. |
| AC-06 | [accounting.test.ts](../test/accounting.test.ts): `AC-06 sellability follows explicit sessions and failed sells are atomic`; calendar horizon rejection. [engine-accounting.test.ts](../test/engine-accounting.test.ts): `golden minute T+1 blocks same-session sale and releases next declared session`. | Pass: explicit Friday/Monday sessions, T+0/T+1, atomic failure. |
| AC-07 | [engine.test.ts](../test/engine.test.ts): `AC-07 buy lots and full-position odd-lot sales remain distinct`. | Pass: buy rounding to 100 and legitimate split-created 150-share full sale remain separate. |
| AC-08 | [engine-accounting.test.ts](../test/engine-accounting.test.ts): `golden shared cash gives two instruments 50 shares each independent of source ordering`. [engine.test.ts](../test/engine.test.ts): `proportional allocation assigns affordable rounding residuals deterministically`. [engine-strategy.test.ts](../test/engine-strategy.test.ts): PIT ranking rotation. | Pass: shared cash, stable residual allocation, sell-then-buy rotation. |
| AC-09 | [engine.test.ts](../test/engine.test.ts): `next-open price gap downsizes with exact fees without borrowing`. [accounting.test.ts](../test/accounting.test.ts): `AC-09 affordability reserves exact minimum fees and supports partial fill step`. | Pass: actual opening prices and fees bound affordable quantity; no borrowing. |
| AC-10 | [engine-accounting.test.ts](../test/engine-accounting.test.ts): `golden unchanged target retains its partial order and minimum commission`. [acceptance-final.test.ts](../test/acceptance-final.test.ts): `AC-10 changing an unfilled buy target to zero cancels its intention without fees`; `AC-10 ordinary sells cannot reserve holdings twice and cancellation releases the reservation`. | Pass: idempotent targets, cancellation, sell reservations and reuse after cancellation. |
| AC-11 | [accounting.test.ts](../test/accounting.test.ts): `AC-11 exact half-up charges and consideration reconcile to cash`. [acceptance-final.test.ts](../test/acceptance-final.test.ts): `AC-11 fees immediately below, at, and above half a cent round exactly and reconcile cash`. | Pass: rates 0.004999 / 0.005 / 0.005001 give exact fees 0.00 / 0.01 / 0.01. |
| AC-12 | [accounting.test.ts](../test/accounting.test.ts): `AC-12 commission minimum is charged once across partial fills`. [engine-accounting.test.ts](../test/engine-accounting.test.ts): unchanged-target partial-order case. [acceptance-final.test.ts](../test/acceptance-final.test.ts): zero-fill cancellation. | Pass: cumulative per-order minimum and zero-fill fees. |
| AC-13 | [accounting.test.ts](../test/accounting.test.ts): `AC-13 cumulative commission preserves earlier rates across schedule transitions`; atomic unfunded fills; exact final equity beyond Number precision. [contracts.test.ts](../test/contracts.test.ts): fee coverage without overlaps/gaps. | Pass: dated schedules, exact decimal intermediates, coverage validation, atomic rejection. |
| AC-14 | [engine.test.ts](../test/engine.test.ts): `stop orders gapped through trigger use open quote; partial remainder stays triggered`; `limit orders receive opening improvement and never violate their limit after slippage`. [engine-accounting.test.ts](../test/engine-accounting.test.ts): protective gap opening-phase golden. | Pass: supported market, limit and stop models preserve opening-gap and limit semantics. |
| AC-15 | [engine.test.ts](../test/engine.test.ts): `ambiguous same-bar protective levels use conservative stop-first or reject explicitly`; `intrabar entry and possible exit is explicit OHLC ambiguity`. [engine-accounting.test.ts](../test/engine-accounting.test.ts): rejection of unknown limit-entry/target sequence. | Pass for declared conservative/reject path policies; no invented intrabar price path. |
| AC-16 | [engine-strategy.test.ts](../test/engine-strategy.test.ts): adjacent-minute close/open case has prior volume 100 and current volume 1, filling 10 at 10% participation. [engine-accounting.test.ts](../test/engine-accounting.test.ts): unchanged-target partial-order golden. | Pass: completed prior volume only and cumulative minimum across partial fills. |
| AC-17 | [accounting.test.ts](../test/accounting.test.ts): `AC-17 dividend receivable is equity but not spendable until payment`. [engine-accounting.test.ts](../test/engine-accounting.test.ts): `golden dividend accrual and payment preserve value without making receivable cash`. | Pass: entitlement is receivable, later payment is cash, no double counting. |
| AC-18 | [accounting.test.ts](../test/accounting.test.ts): `AC-18/19 split adjusts quantity and value, fractions require compensation`. [engine.test.ts](../test/engine.test.ts): `explicit split adjustment retains pending order identity, price audit and cumulative minimum`. | Pass: exact value/basis preservation; explicit cancel/adjust outstanding-order policy. |
| AC-19 | [engine-accounting.test.ts](../test/engine-accounting.test.ts): `golden fractional split compensates the remainder instead of losing it`. [accounting.test.ts](../test/accounting.test.ts): across-lot fractions, FIFO basis and mixed-lot settlement cases. | Pass for whole-share holdings with explicit cash-in-lieu, otherwise rejection; general fractional-share trading is not supported. |
| AC-20 | [engine.test.ts](../test/engine.test.ts): `AC-20 carried stale marks never become executable quotes and obey stale policy`. [accounting.test.ts](../test/accounting.test.ts): no future marks. [engine-accounting.test.ts](../test/engine-accounting.test.ts): explicit delisting compensation. | Pass: stale valuation is disclosed and cannot create execution liquidity. |
| AC-21 | [accounting.test.ts](../test/accounting.test.ts): `AC-21 withdrawals preserve unit NAV, returns and exact profit`. [analytics-audit.test.ts](../test/analytics-audit.test.ts): `withdrawal exposes independent raw-equity percentage and monetary drawdowns alongside NAV drawdown`. | Pass after audit repair: withdrawal 100→80 yields raw drawdown 20%/20, NAV drawdown 0, profit/TWR unaffected. |
| AC-22 | [accounting.test.ts](../test/accounting.test.ts): `AC-22 amount and percentage drawdown retain different peak/trough/recovery`. [equity-statistics.test.ts](../test/equity-statistics.test.ts): independent full-series comparison. [reports.test.ts](../test/reports.test.ts): extrema sampling and metric immutability. | Pass: independent timestamps and full-series statistics preserved through display sampling. |
| AC-23 | [engine-accounting.test.ts](../test/engine-accounting.test.ts): supplied execution replay golden. [engine.test.ts](../test/engine.test.ts): booked execution replay. [accounting.test.ts](../test/accounting.test.ts): supplied aggregate fees unclassified. [analytics-audit.test.ts](../test/analytics-audit.test.ts): one-session replay and persistent missing-held-session coverage. [contracts.test.ts](../test/contracts.test.ts): unsupported/unknown fields and operators. | Pass after audit repair: observed drawdown stays explicit; daily missing prices mark coverage incomplete, intraday cadence unverified. SDK mode is `replay`, with accounting semantics; no rematching. |
| AC-24 | [canonical.test.ts](../test/canonical.test.ts), [engine.test.ts](../test/engine.test.ts), [equity-statistics.test.ts](../test/equity-statistics.test.ts), [research.test.ts](../test/research.test.ts): identity, seed, output-level and worker-count determinism. [runtime.test.ts](../test/runtime.test.ts), [runtime-races.test.ts](../test/runtime-races.test.ts), [results.test.ts](../test/results.test.ts): cancel, commit, restart and integrity. | Pass for exposed controls. Summary uses every observation; canceled partial outputs have no completed manifest. No public execution chunk-size tuning or checkpoint resume is claimed. |
| AC-25 | [research.test.ts](../test/research.test.ts): `walk-forward training selection cannot read the next test open or future closes`; continuous partial-order/commission carry; rolling/expanding determinism; shared columns and factor goldens. [runtime-research.test.ts](../test/runtime-research.test.ts): bounded worker allowance and durable artifacts. [benchmark.mjs](../scripts/benchmark.mjs), [profile-engine.ts](../scripts/profile-engine.ts): complete workload/phase measurement. | Functional isolation/reuse tests pass. Final measured performance/package/host gate is recorded separately below and in PROGRESS; it is not inferred from passing unit tests. |

The final audit also added [analytics-audit.test.ts](../test/analytics-audit.test.ts) regressions for exact protective high-water marks and floating-point noise in derived statistics. [reports.test.ts](../test/reports.test.ts) verifies that incomplete/unverified coverage qualifies the headline and chart, including when observed drawdown is zero. Those labels do not recompute the account or metrics. The [incomplete-coverage preview](evidence/report-incomplete-preview.png) was rendered in local headless Chrome and visually inspected after the change; its [HTML source](evidence/report-incomplete-preview.html) uses the same synthetic one-quote replay fixture.

Unless a scenario overrides it: use raw prices, one currency with 0.01 settlement quantum, explicitly zero fees/slippage, positive valid OHLC bars, quantity increment 1, cash-only long holdings and a supplied session calendar. Exact expected money values are decimal values, not floating-point tolerances. Indicator/risk-statistic comparisons may use a separately declared numerical tolerance.

## A. Data, information and timing

### AC-01 — Half-open range and warm-up

Give explicit event times and evaluate `[3, 5)`. A close at 2 may warm an SMA but cannot create a hidden position. Opens/closes/flows at 3 or 4 are eligible; an open, close or external flow at 5 is not. A close at 5 cannot become a terminal mark. Preserve an initial pre-trade equity observation and expire final unfilled orders with `END_OF_RUN`.

### AC-02 — Next-open price, not signal close

Initial cash 1,000. Close of bar 1 is 10 and issues buy 10. Bar 2 opens at 12 and closes at 11. Expect a single bar-2 open fill for 120, cash 880, holdings 10, and closing equity 990. No bar-1 fill is allowed. Include contiguous bars where bar 1 closeTime equals bar 2 openTime: close-before-next-open phase ordering still permits this fill without adding a whole extra bar of delay. A later price change must not alter this fill.

### AC-03 — Invalid and ambiguous input

Independently supply duplicate instrument/timestamp keys, unsorted rows, high below low, NaN close, ambiguous timestamp convention, unknown volume units and mismatched currencies. Each must fail validation with a field/row-localized error. No run ID should claim success. An explicit sorting policy may repair ordering and must preserve a cleaning report/hash; default import must not silently repair it.

### AC-04 — Information availability and mixed frequencies

At 10:00 a strategy references a daily bar completing at 15:00 and a financial feature published tomorrow. Both remain unavailable. A historical `lag` is allowed; a future reference is rejected. Appending tomorrow's data must leave today's valid decisions unchanged.

### AC-05 — Missing quotes and pending time-in-force

A GTC buy is accepted after bar 1; the instrument has no executable bar 2; bar 3 opens at 11. It remains pending on bar 2 and fills only at bar 3, subject to valid expiry. A DAY order without a permissible same-session future execution expires on its submission session and does not become GTC. Explicitly expired orders never execute at the expiry boundary.

## B. Funds, lots and market rules

### AC-06 — T+1 uses sessions, not bars or wall-clock days

Explicit sessions are Friday, Monday, Tuesday. A Friday morning purchase is not sellable on Friday afternoon. It becomes sellable Monday, even though multiple days elapsed. A T+0 instrument using the same data can sell in a later permitted Friday phase. Missing calendar coverage causes an error rather than weekday guessing.

### AC-07 — Buy lots and odd-lot full sales

An instrument allows buys in lots of 100 and full-position odd-lot sales. A buy request for 150 is either rejected or rounded to 100 according to the resolved policy; the chosen outcome and remainder are recorded. A legitimate holding of 150 can be fully sold if the odd-lot policy permits. A request rounded to zero creates no fill or fee.

### AC-08 — Shared cash allocation is deterministic

Initial cash 1,000; two instruments each request 100 shares at 10. With equal priorities, proportional allocation and unit lots, expect 50 shares each and cash zero. Reversing input symbol order or worker scheduling does not change the result. With sell-first allocation, only actually filled sales can fund purchases; pending sales add no cash.

### AC-09 — A gap invalidates the original buying budget

Cash 1,000; a buy for 100 was sized at 10 but opens at 12. The resolved insufficient-cash policy rejects or downsizes to an affordable quantity with fees reserved. Under downsizing and unit lots/zero costs, the maximum is 83, leaving 4. No path produces negative cash or implicit borrowing.

### AC-10 — Conflicting targets and sell reservations

An accepted target creates an unfilled buy for 100. Repeating the same target on the next decision does not create another buy for 100. Changing the target to zero deterministically cancels/replaces the relevant remaining intention. Two sell orders cannot each reserve and execute the same 100 sellable shares; cancellation releases reservations.

## C. Precise charges and order execution

### AC-11 — Decimal half-up boundary

Use a fee basis of 1.00 and a rate of 0.005 with zero minimum and 0.01 settlement quantum. Exact fee 0.005 rounds to 0.01. Include values immediately below and above that boundary. Verify the serialized fee and final cash exactly; a binary floating-point rounding coincidence is not sufficient evidence.

### AC-12 — Minimum commission is cumulative per order

One buy order fills 40 then 60 shares at 10, commission rate 0.001 and minimum 5.00. Rate-based commission is 0.40 then 0.60. Charge 5.00 on the first fill and 0.00 additional commission on the second, totaling 5.00 rather than 10.00. Canceling an unfilled remainder does not refund the applied minimum. A zero-fill canceled order has zero commission.

### AC-13 — Cost schedules and atomic rejection

Select two explicit fee versions with different effective dates and verify each fill uses the applicable supported rule. Unknown fee coverage fails instead of returning zero cost. If consideration plus fees exceeds available cash and cannot be resized under policy, no fill, fee, position change or partial cash debit occurs. Oversized fixed-point intermediate products reject or use exact arithmetic; they must not silently overflow.

### AC-14 — Stop gap and limit-price protection

If supported, a long position's stop-market trigger is 95 and the next executable open is 90; fill from 90 plus declared slippage, not from 95. A buy limit 95 cannot fill at 96 after slippage/tick rounding. Unsupported limit/stop types return a validation error and must not become market orders.

### AC-15 — Same-bar stop/target ambiguity

A previously held long has stop 95 and target 105. The next OHLC is O=100, H=106, L=94, C=101. Conservative policy selects its explicitly defined pessimistic outcome, or rejection policy produces an ambiguity error. The output counts the ambiguous case. Same-bar limit entry followed by a possible stop is handled under the same declared path policy, not an invented certain sequence.

### AC-16 — Participation does not inspect future volume

An opening order uses a 10% participation model against the previous completed bar's volume of 100 shares. Eligible opening fill quantity is at most 10 shares. Changing the current bar's eventual volume from 100 to 1,000,000 must not change this opening fill. A model based on current final volume must expose different intrabar/end-of-bar timing. Repeated partial fills respect AC-12.

## D. Corporate actions and valuation

### AC-17 — Dividend is receivable before it is cash

Hold 100 shares at 10 with cash zero. Entitlement is 1 per share and the ex-dividend mark is 9. Book receivable 100: equity remains 1,000, cash remains zero, and a buy requiring that 100 cash cannot execute. At payment, move 100 from receivable to cash; total equity is unchanged. Selling after entitlement does not erase the receivable or make payment-day ownership determine eligibility.

### AC-18 — Split preserves economics and adjusts orders

Hold 100 shares with total basis 1,000 at mark 10. A 2-for-1 split creates 200 shares at mark 5 and total basis 1,000. Equity does not jump. A supported outstanding order's quantity/price are adjusted according to the same action policy and its audit record retains original values. Reject the affected run until split support is available.

### AC-19 — Fractional entitlement cannot disappear

Three shares undergo a 3-for-2 split, producing 4.5 shares. Under supported fractional holdings, retain 4.5 with trade-lot restrictions applied separately. Under whole-share-only policy, use an explicit cash-in-lieu price/payment event, or reject. Silently retaining only 4 shares without compensation fails. A 150-share odd lot is not treated as a 0.5-share fractional entitlement.

### AC-20 — Stale marks are not executable quotes

Hold 10 shares; last available close is 10; the instrument has no next bar. Under carry-forward valuation, mark its holding 100 and report stale age. Do not fill a sell at 10. Exceeding the stated stale threshold yields the configured warning/error. Missing all marks or an unpriced terminal delisting cannot silently imply a zero-valued or indefinitely current holding.

## E. Returns, reproducibility and release scope

### AC-21 — Withdrawal is not investment loss

Cash-only account begins at 100 with no market return. Withdraw 20 at a declared boundary using identical pre/post-flow marks. Terminal equity is 80, net external contribution is -20, investment profit is zero, TWR is 0%, unit-NAV drawdown is 0%. Raw-equity amount drawdown is 20 and raw-equity percentage drawdown is 20%, both labelled as cash-flow affected. A withdrawal of 120 is rejected atomically.

### AC-22 — Two maximum drawdowns have different intervals

Use no-flow equity sequence `[100, 70, 200, 160]`. Maximum percentage drawdown is 30% from observation 1 to 2. Maximum amount drawdown is 40 from observation 3 to 4. The percentage drawdown recovers at observation 3; the amount drawdown remains unrecovered. Initial equity is included and each result carries its own timestamps. Display downsampling must preserve these computed values.

### AC-23 — Ledger replay and unsupported capability honesty

Replay supplied valid fills/fees with adequate valuation data. Final cash, positions, receivables and fee totals equal an independent hand-calculated ledger; do not match those executions again. Label the mode accounting. Without full-period prices, report incomplete/null full-period drawdown. Independently request shorting, mixed currency, option exercise and an unknown strategy operator: each receives a structured unsupported/invalid error rather than approximate execution.

### AC-24 — State, resource and replay determinism

Identical frozen data/spec/seed produces identical economic events and summaries across permitted symbol ordering, chunk sizes and worker counts. IDs/timings that are explicitly operational may differ but remain separate from the economic fingerprint. Cancel a long run and verify no completed status or complete artifact manifest is published for partial output. Replay persisted events and reconcile all ledger invariants. Summary output limits do not downsample metric computation.

### AC-25 — Research isolation and end-to-end measurement

For parameter search/walk-forward, candidate selection uses only the declared training interval; changing test returns cannot alter the candidate chosen before that interval. Warm-up and carry/reset positions are explicit. Reuse immutable data rather than importing per parameter. Performance tests separately measure startup, data validation, indicators, fills/exact accounting, metrics and output for the same semantics; publish runtime, hardware, output level, p50/p95 and peak memory. A hot 34-line loop is not accepted as a complete-engine benchmark.

## Four-stage scope closure and evidence boundaries

The original design's P0–P3 correspond to the four authorized implementation steps. P4/WASM was conditional on profiling, not a fifth mandatory implementation step. Final source checks recorded **233/233 core tests**, **10/10 optional-format tests**, and successful typechecking: [core log](evidence/stage4-tests.log), [optional log](evidence/optional-tests.log), [typecheck log](evidence/typecheck.log). The stage counts and final gate decision are maintained in [PROGRESS.md](PROGRESS.md); [INTEGRATION.md](INTEGRATION.md) describes the implemented 12-tool protocol and runtime lifecycle.

| Design requirement | Implemented evidence / explicit boundary |
|---|---|
| Contracts and 20–30 scenarios | These 25 engineering scenarios have executable mappings. No genuine user-request corpus was supplied or collected; the original proposal's real-demand coverage statistic remains unavailable. Synthetic fixtures cannot replace that product-research evidence. |
| Core and plugin | Rules, targets/rank and supplied-fill accounting; precise shared cash, lots/settlement, costs, corporate actions, order models, analytics; SDK/CLI/MCP jobs, schemas, pagination, replay explanations and integrity tests. Unsupported markets are rejected. |
| Target host | User explicitly replaced unavailable zwork verification with actual Codex. Stage 3 proves seven tools/11 calls. Final [independent packaged verifier](evidence/codex-package-smoke-verified.json) proves all 12 tools/24 completed calls in one connection, exact final equity 1042.00, candidate/walk-forward/factor outputs and on-disk report integrity. This is actual host evidence, separate from SDK tests. |
| Long validation | Waiting SDK `validate` remains compatible. SDK `validateJob` and MCP `background:true` return a cancellable job before preflight completes; queued cancellation and real MCP polling are tested. |
| Research and timeframes | Bounded deterministic sweeps; rolling/expanding walk-forward over rules with explicit continuous-account carry; as-of external features/predictions and factor IC/rank-IC/groups; native completed minute/day/week/month aggregation. No built-in ML fitting or in-sample parameter selection from test returns. |
| Walk-forward boundary | Ordinary engine strategies have wider modes; walk-forward currently accepts rules, reuses all supplied preceding warmup, and carries positions and pending orders across switches. Alternative reset-account policies and non-rule walk-forward are rejected, not approximated. |
| Optional formats and delivery | Core CSV/JSONL/JSON and separate Parquet/Arrow/XLSX package; trusted host-selected adapter path, no code path in dataset requests. Final extracted/offline package smoke checks must match the final manifest. |
| Retention and recovery | Retained-store quota, atomic commits, job cancel/interruption and restart recovery are tested. No LRU/online deletion/checkpoint resume; artifacts are retained until explicit offline cleanup. Because nothing is automatically evicted, no active-reference eviction guarantee is assumed. |
| Risk semantics | Raw-equity monetary and percentage drawdowns are cash-flow affected; headline percentage is unit NAV. Coverage is separate: missing held daily sessions are incomplete, unvalidated intraday cadence is unverified. Observed risk is not certified full-period risk. |
| Intentional market scope | Cash-only long stocks/ETF, one currency, raw prices, day/minute bars. General short/margin/options/tick/live trading, fractional-share trading and a historical exchange-rule registry are not claimed. Lot/tick/settlement metadata is static per instrument; cost schedules and bar price bands are explicit. |
| Optimization | Typed columns, compiled DAGs, incremental indicators, streaming statistics, worker sharing and measured profiling. WASM remains optional; no performance claim is extrapolated from a 34-line loop. |

Final release evidence must distinguish three independently checked categories:

1. **Correctness:** complete `npm test`, `npm run check`, and optional-format tests for the final source, not only earlier gate counts.
2. **Measured delivery:** extracted packages with hashes/sizes, target Node/platform smoke tests, and complete-workload p50/p95/RSS/phase results. Five-sample p95 is merely the sample maximum, not a reliable tail estimate. Bundled artifact, CSV import/persistence, warm execution and instrumented profiles must remain separately labelled.
3. **Actual host — passed:** [packaged Codex transcript](evidence/codex-package-smoke.jsonl) and [independent verifier](evidence/codex-package-smoke-verified.json) confirm 24 completed calls across all 12 tools. The tested entry-point SHA-256 is recorded in the linked independent verifier. Cancellation evidence remains SDK/runtime; this short actual-host fixture did not cancel work.

Functional acceptance, packaged/offline runtime checks, measured performance and actual-host verification remain distinct records. A documentation-only final package refresh must preserve the tested executable hashes; executable changes require fresh verification. Linux x64 Node 22/24 smoke evidence does not certify Windows, macOS or Bun. No actual-user strategy coverage or investment outcome is established by any of these tests.
