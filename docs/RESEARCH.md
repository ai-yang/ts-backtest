# Parameter research and evaluation

The research module accepts declarative specifications and local prepared datasets. It runs no generated JavaScript. All examples and tests are synthetic requirements/examples, not collected user strategy samples or evidence of profitable trading.

## Parameter sweeps

`runSweep(dataset, baseSpec, request, hooks?)` returns a promise. Its candidate workers receive shared typed-array bar columns once and reuse the same dataset across candidates. Workers execute independent accounts. The dataset descriptor is copied before dispatch; shared bar buffers are read-only by contract. The public SDK exports `runSweep`, `parseSweepRequest`, `SweepRequest` and `SweepResult`.

```ts
const result = await runSweep(dataset, baseSpec, {
  space: { '/strategy/rules/0/action/value': [10, 20, 40] },
  objective: { metric: 'netProfit', direction: 'maximize' },
  seed: 42,
  concurrency: 2,
  maxCandidates: 100,
  maxTotalBars: 10_000_000,
  maxRuntimeMs: 60_000,
});
```

Pointers use RFC 6901 escaping (`~0`, `~1`) and must identify an existing scalar property beneath `strategy`, `execution` or `costs`. Arrays use canonical numeric indexes. New properties, object replacement, array insertion, prototype keys, scalar type changes, duplicate values and unknown request fields are rejected. The Cartesian product must fit the candidate budget; invalid strategy combinations fail validation before worker launch. Runtime failures are recorded per candidate. Undefined objective values are excluded from selection; if every candidate fails or has an undefined objective, `NO_VALID_CANDIDATE` includes a bounded sample of errors. Ties choose the lexicographically smallest candidate ID.

Candidate identity hashes the parameter assignment. Its random seed derives from that ID and the request seed. Candidate order, scheduling and worker count therefore do not alter candidate results. Each candidate result also retains the complete core execution fingerprint. Money objectives compare decimal strings exactly. Sweep outputs use summary-level core results; detailed trading records require rerunning the selected parameters with the chosen seed.

Defaults and limits:

| Resource | Default | Maximum |
|---|---:|---:|
| Concurrent workers | 2 | 8 |
| Candidates | 1,000 | 10,000 |
| Candidate count × dataset rows | 100 million | 1 billion |
| Total wall time | 120 seconds | 1 hour |
| Shared dataset payload | 256 MiB | 1 GiB |
| V8 old-generation budget per worker | 512 MiB | 2 GiB |
| Expanded candidate specifications | 64 MiB | 64 MiB |

Dataset payload bytes describe serialized metadata plus typed-array bytes, not process RSS. SharedArrayBuffer/native allocations and runtime overhead also consume memory. The service may impose lower outer limits. Cancellation and wall-time expiry terminate research workers. The outer runtime must retain its job slot until nested workers finish terminating.

## Walk-forward evaluation

`runWalkForward(dataset, baseSpec, request, hooks?)` trains on rolling or expanding past intervals, records each selection, and executes the entire contiguous out-of-sample interval through **one core account**. Its `continuous` result supplies all reported OOS metrics; window returns are never concatenated to manufacture a full-account metric.

The current implementation supports `rules` strategies, with swept parameters restricted to scalar strategy fields. Execution settings, costs and account policy stay fixed. `rank`, `targets` and `replay` remain available for ordinary backtests but are rejected by this walk-forward compiler.

```ts
const result = await runWalkForward(dataset, baseSpec, {
  space: { '/strategy/nodes/average/period': [10, 20, 40] },
  objective: { metric: 'sharpe', direction: 'maximize' },
  trainSessions: 252,
  testSessions: 21,
  mode: 'rolling',
  warmup: 'all_prior',
  positionPolicy: 'carry',
  pendingOrderPolicy: 'carry',
  seed: 42,
  concurrency: 2,
  maxWindows: 24,
  maxTotalBars: 100_000_000,
});
```

Session boundaries come from observed bars and the explicit dataset calendar. Missing complete calendar sessions inside the interval are rejected. Every test window must be complete; an incomplete final window is omitted and counted in `unusedTailSessions`. Training ends at the next test session's first observed open. The training engine cannot consume events at that boundary or later. Tests are contiguous and non-overlapping. An expanding window retains its first training start; a rolling window advances it.

All earlier available bars warm market indicators. Each **training** account starts fresh at configured initial cash, filtering external flows to that training interval. Account-dependent indicators observe an empty account before its training start. All **OOS** holdings, cash, settlement lots, dividend receivables, commission accrual, pending orders and protective execution state carry continuously. There is no forced liquidation or cash reset at a parameter switch.

Selection is considered available at `selectedAt = testStart`. The first new decision is a qualifying completed bar; it cannot trade at an already reached test opening price. Selected rules compile to timestamp gates. Each window records its candidate, training score, execution fingerprint and combined rule indexes. `orderWindows` maps saved order records to the selection active at submission, including orders filled after a later switch. Protective orders still use the fixed execution policy. Summary output omits order attribution because its orders were not retained.

The aggregate training work plus one OOS execution must fit `maxTotalBars`; `maxRuntimeMs` covers the entire research operation. The combined rule graph must also fit the base specification's existing expression/node limits. Those limits are never silently increased.

## Factor diagnostics

`factorDiagnostics(dataset, request, hooks?)` returns cross-sectional Pearson IC, average-rank Spearman IC and equal-weight forward-return groups for a named external feature. It is an evaluation calculation, not a trading account simulation.

```ts
const diagnostics = factorDiagnostics(dataset, {
  feature: 'prediction',
  from: start,
  to: end,
  horizonBars: 5,
  groups: 5,
  minSamples: 20,
  maxRows: 1_000_000,
  maxPeriods: 10_000,
});
```

At each completed-bar timestamp, each observation uses the latest feature with `availableAt <= timestamp`. A null feature value explicitly removes availability. Optional `maxFeatureAgeMs` limits carry-forward age. Point-in-time membership is checked at the observation timestamp, and stale securities without a bar at that timestamp are absent from that cross-section.

The label is the raw close-to-close return after `horizonBars` **observed bars of that instrument**. Both observation and label must lie within `[from,to)`; future labels never become strategy features. An interval crossing a supplied split, dividend or delisting is excluded, with a count. Incomplete action data or missing final/delisting observations can still bias the result; the engine does not invent those returns.

Feature ties receive average ranks and stay together in a bucket, so some groups may be empty. Constant or undersized cross-sections return null correlations. ICIR is mean IC divided by its population standard deviation across valid periods; it is neither annualized nor adjusted for overlapping labels. Group returns omit trading costs and are not compounded into a portfolio curve. Outputs include sample counts, exclusion counts and these limitations.

Factor evaluation defaults to 100,000 inspected observations, 10,000 output periods and 120 seconds. These limits can be set explicitly up to 10 million observations, 100,000 periods and one hour; the enclosing service may further restrict them.

## Durable service jobs and study artifacts

`BacktestService` exposes asynchronous `sweep(planId, request)`, `walkForward(planId, request)` and `factors(datasetId, request)`. These methods validate the small request and return a job handle; dataset decoding, candidate execution and research evaluation run in workers. Existing `job(id, 'status' | 'cancel')` and restart recovery apply to research jobs as well. Success returns `{ studyId, kind }`, plus a separate `runId` for the true continuous walk-forward account.

`service.study(studyId, query)` and standalone `queryStudy(storeDir, studyId, query)` read these tables:

| Study kind | Tables |
|---|---|
| Sweep | `summary`, `candidates` |
| Walk-forward | `summary`, `windows`, `orderWindows` |
| Factors | `summary`, `periods` |

Queries support `limit` (1–200), a signed `cursor`, top-level `fields`, primitive equality `filter` and half-open `from`/`to` for timestamped tables. Pages are also limited to 256 KiB of selected JSON rows. Unknown fields, nested filters and transferred/tampered cursors are rejected. Every page streams and hashes the full selected artifact, so query work is O(total table rows) per page. Saved studies have their own schema and are never represented as ordinary backtests.

Studies publish by atomic directory rename, retain a resolved-input artifact, and verify SHA-256 hashes on read. Walk-forward studies link a separately persisted core run; if the study commit fails, the new run is rolled back. Published studies count toward the retained store quota. Startup cleans only strictly named unpublished study directories while holding the service lock; symlink escapes are refused.

The service shares one **global** `maxResearchWorkers` allowance across all studies, defaulting to its parent `concurrency` (maximum 8). Studies reserve their requested child count before launch and wait when the allowance is occupied. The maximum worker count is therefore `concurrency + maxResearchWorkers`, including parent coordinators. Server defaults also cap candidates at 1,000 and aggregate candidate bars at 100 million. Omitted request limits inherit lower server defaults; explicit requests beyond service limits fail with `RESOURCE_LIMIT`.

Run the complete synthetic prepare → validate → research → poll → study-query example after building:

```sh
node examples/research-demo.mjs
```

Its one-symbol factor example intentionally produces undefined cross-sectional IC; the integration and analytical tests use a separate three-symbol fixture for known correlations.
