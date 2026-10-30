# Implementation gates

User objective: complete all four implementation steps, fix defects and pass each gate before entering the next.

The user explicitly replaced unavailable zwork source verification with Codex MCP service verification. The standalone engine remains host-independent.

The public project is named **ts-backtest** and uses the **MIT License**. Package names, CLI binaries, the MCP server name, generated reports and distribution directories use this name. Before-renaming release and Codex records are preserved in `evidence/pre-rename/`; the original benchmark and stage-3 records retain their historical names and paths. Historical performance measurements are not represented as newly rerun measurements after renaming.

| Step | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Data/spec/accounting contracts, schemas, representative acceptance cases | Passed | `npm test`: 25/25 tests; `npm run check`: passed. Strict JSON/YAML, 18 schema cases, exact ticks/data errors, canonical hashing. 25 synthetic acceptance scenarios documented. |
| 2 | Tested accounting/engine/strategy/data/analytics and CLI | Passed | `npm test`: 113/113, `npm run check`: passed. Exact financial goldens, next-open/minute phase causality, PIT/feature availability, replay and CLI parity. Includes 2 large/deep cache regression cases. |
| 3 | MCP, jobs, artifacts, explanations, corporate actions and order models | Passed | `npm test`: 173/173; `npm run check`: passed. Official MCP 9 tests; real Codex 11 calls across all 7 tools; cancellation/forced termination/SIGKILL recovery/lock races/quota/artifact integrity tests. Transcript independently verified. |
| 4 | Parameter sweeps, walk-forward, external predictions/factors, optional formats, benchmark/packaging | Passed | Final core suite 233/233, optional formats 10/10, typecheck passed. Fourteen full-workload benchmark cases plus four final-revision hot cases, each with five normal samples. Extracted offline packages passed on Linux x64 Node 22.23.4 and 24.18.0. Actual packaged Codex: 24 completed calls across all 12 tools, independently verified against tool outputs and artifact hashes. |

The four implementation gates are complete. Acceptance scenarios are explicitly representative synthetic cases; no claims about real-user strategy coverage or investment outcomes are inferred from them.

Stage 2 resolved defects include repeated target minimum commissions, partial lot-valid fills, direct order dispatch, protective gap execution and reserved-exit precedence, exact Decimal protective thresholds, same-bar entry/exit ambiguity, and point-in-time exit handling. Final independent auditing additionally repaired mixed-representation holding-high comparisons, statistical roundoff, separate cash-flow-affected percentage drawdown, and missing valuation coverage disclosure. Background validation now returns a cancellable job when requested. Public-release verification also repaired a staging-cleanup race: terminal job status is exposed after cleanup, and rejected cancellation cannot overwrite the durable terminal state. A deterministic regression covers both boundaries.

Final verification records:

- [Core test log](evidence/stage4-tests.log), [optional-format test log](evidence/optional-tests.log), [typecheck](evidence/typecheck.log).
- [Actual packaged Codex verification](evidence/codex-package-smoke-verified.json) and [transcript](evidence/codex-package-smoke.jsonl). The original seven-tool stage-3 evidence remains separate.
- [Full-workload benchmark](evidence/benchmark.json), [final-revision hot rerun](evidence/benchmark-final-hot.json), and [performance methodology](PERFORMANCE.md).
- `dist/package/size-report.json` and `dist/package/smoke-report.json` record exact package bytes and independently extracted runtime checks. `docs/evidence/release.json` consolidates source/lock/artifact hashes and final gate evidence after packaging.
- [Acceptance mapping](ACCEPTANCE.md) maps all 25 scenarios to named executable tests. [Integration](INTEGRATION.md), [research](RESEARCH.md), [native frames](FRAMES.md) and [reports](REPORTS.md) state supported behavior and limits.

On the measured Ryzen 7 5800H/Linux/Node 24 host, the final revision's 1,000,000-minute-bar, 9,998-fill summary run has hot p50 **3.326 s** and p95 **3.543 s**. The proposed 2 s target was **not achieved**. The earlier full I/O measurement took p50 **30.947 s** from CSV import to result publication, with process peak RSS **2.71 GiB** across all pipeline phases; it is labelled with its measured revision separately from the final hot rerun. No WASM acceleration or lower memory claim is implied. See PERFORMANCE.md for complete phase, fixture, revision, and memory boundaries.

Runtime delivery excludes Node and user data. Windows, macOS and Bun were not tested. Walk-forward currently supports rules with carried positions/orders; intraday valuation-cadence completeness is reported as unverified. No automatic LRU eviction, live trading, short/margin/derivative trading, or zwork-host integration is claimed.
