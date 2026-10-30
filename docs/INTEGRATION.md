# Implemented integration contract and evidence

This document describes the implemented SDK, CLI, and stdio MCP interfaces. It is not a proposed API. Stage 1–3 gates passed; Stage 4 functionality has executable engine, research, native-frame, optional-format, and report tests. The current full-suite and final-release evidence are tracked in [PROGRESS.md](PROGRESS.md) and [ACCEPTANCE.md](ACCEPTANCE.md); a prior test or bundle report does not certify a later changed build.

## Verified client evidence

The Stage 3 real Codex connection completed **11 calls across all seven original tools**, with exact synthetic final equity `1100.00`, profit `100.00`, and distinct paginated fill IDs. Evidence was verified from completed tool outputs, independently of the model's final prose:

- [Verified output](evidence/codex-smoke-verified.json) and [captured transcript](evidence/codex-smoke.jsonl).
- Producer: `node scripts/codex-smoke.mjs`; verifier: `node scripts/verify-codex-smoke.mjs`.
- Configuration used ephemeral `--ignore-user-config` and per-command `-c` overrides; existing user configuration was preserved.

Cancellation was **not** exercised through that short real Codex fixture. Queued/running cancellation, forced termination, cancellation/commit races, restart, and ownership recovery are covered by official SDK/runtime tests instead. These evidence categories must not be conflated.

The Stage 4 **packaged server passed actual Codex verification: 24 completed calls across all 12 tools in one connection**, including background validation, exact synthetic final equity `1042.00`, two candidate runs with profits `21.00`/`42.00`, three walk-forward windows with one account-initialization event, factor rows, pagination, explanations, and the on-disk HTML hash. The independent verifier reads completed tool results and artifact bytes, not the model's final assertion.

- [Independent verified result](evidence/codex-package-smoke-verified.json), [actual transcript](evidence/codex-package-smoke.jsonl), and [process/configuration status](evidence/codex-package-smoke-status.json).
- Producer: `node scripts/codex-package-smoke.mjs`; verifier: `node scripts/verify-codex-package-smoke.mjs`.
- The tested packaged `mcp.cjs` SHA-256 is recorded in the [independent verified result](evidence/codex-package-smoke-verified.json). Documentation-only package refreshes must preserve that executable hash; changed executables require fresh verification. Pre-renaming records are retained in `evidence/pre-rename/`.
- The client used ephemeral configuration and preserved the user's existing configuration. Cancellation remains SDK/runtime evidence, not part of these 24 actual-host calls.

## Supported entry points

All adapters use the same specification, validation, event engine, exact account ledger, and metric definitions.

| Entry point | Implemented responsibility | Boundary |
|---|---|---|
| SDK | Typed dataset, execution, research, frames, and report APIs | The embedding application owns filesystem permissions and lifecycle. |
| CLI | JSON/YAML configuration, local imports, validation, synchronous run/research completion, file output | Does not exit with an unowned background job. |
| stdio MCP | Strict JSON inputs, discovery, structured error envelopes, jobs, bounded queries, artifact handles | Does not evaluate model-written JavaScript or fetch market data. |
| Codex | Connects to the ordinary stdio MCP server | No separate Codex-specific execution semantics. |

Developer commands that exist today:

```sh
npm run build
npm run cli -- capabilities
npm run cli -- prepare --config examples/basic.json --output /tmp/backtest-dataset.json
npm run cli -- validate --config examples/basic.yaml
npm run cli -- run --config examples/basic.yaml --output /tmp/backtest-result.json
npm run cli -- report --input /tmp/backtest-result.json --output /tmp/backtest-report.html
npm run mcp -- --workspace /absolute/workspace --store /absolute/workspace/.backtest --workers 2
```

Research commands are `sweep`, `walk-forward`, and `factors`, using `--config` plus `--request`; [RESEARCH.md](RESEARCH.md) and `examples/research-demo.mjs` show complete requests. Native multi-timeframe preparation uses `dataset.frames`; see [FRAMES.md](FRAMES.md) and `examples/frames.json`. JSON/YAML are authoring formats for the same normalized specification. Missing financial settings remain errors.

For production, launch the packaged JavaScript directly. A generic client configuration uses real adapter flags, not hypothetical environment variables:

```json
{
  "mcpServers": {
    "backtest": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/backtest/mcp.cjs",
        "--workspace", "/absolute/path/to/authorized-workspace",
        "--store", "/absolute/path/to/plugin-state",
        "--workers", "2"
      ]
    }
  }
}
```

The outer `mcpServers` syntax depends on the client; the server arguments above are implemented. Workspace defaults to the server's cwd, store to `workspace/.backtest`, and workers to two, with a supported range of 1–8. Explicit absolute paths avoid unintended cwd dependence.

The separate optional-format package enables local Parquet, Arrow IPC, and XLSX readers through a trusted host startup option, `--formats /absolute/path/to/formats.cjs`, or SDK `setFormatAdapter(path)`. Dataset requests cannot select executable modules. Core CSV/JSONL/JSON needs no optional package. No runtime TypeScript compiler, Python, database, dependency installation, or network acquisition is needed.

## Twelve MCP tools

Every tool advertises input/output schemas. Responses have matching JSON `structuredContent` and compatibility text: either `{ok:true,data}` or `{ok:false,error}`, never an ambiguous success/error mixture. Errors expose code, message, path, bounded details, and retryability.

| Tool | Input and behavior | Successful response data |
|---|---|---|
| `backtest_capabilities` | Category `summary`, `schema`, `operators`, or `templates`; optional name/parameters | Bounded capability/schema/template object. Templates generate strategy only. |
| `backtest_prepare_data` | Authorized local file, explicit metadata/mappings; optional features/actions/frames | Durable prepare job; poll for `datasetId`. |
| `backtest_validate` | `datasetId`, complete `spec`, optional `background` (default false) | Default waits for worker preflight and returns `planId`, `resolvedSpec`, warnings, estimates. With `background:true`, returns a validation job immediately. |
| `backtest_run` | Existing validated `planId` | Durable run job; poll for `runId`. It does not accept an unchecked strategy bypass. |
| `backtest_job` | `jobId`, `status` or `cancel` | Current persisted job state, progress, result handles, or error. Includes validation and research jobs. |
| `backtest_result` | Run/table, optional fields/filter/time bounds/cursor | Bounded result page and continuation cursor. |
| `backtest_explain` | Run plus exactly one order ID, fill ID, or timestamp; symbol only with timestamp | Explanation job replaying the original complete range and retaining derivation provenance. |
| `backtest_sweep` | Validated plan and bounded scalar-parameter grid | Research job; poll for `studyId`. |
| `backtest_walk_forward` | Validated rules plan and rolling/expanding request | Research job; poll for study and true continuous-account run handles. |
| `backtest_factors` | Dataset and as-of factor/forward-label request | Factor-diagnostics job; poll for study handle. These are not investable simulated returns. |
| `backtest_study` | Study/table and bounded query options | Research summary, candidates, windows, periods, or attribution page. |
| `backtest_report` | FullTrace run ID | Verified local `{path,sha256,bytes,mimeType:'text/html'}`; no HTML body in tool output. |

`BacktestService.validateJob(datasetId,spec)` is the SDK's immediately returning validation-job API. `validate(datasetId,spec)` retains the waiting API for existing callers. Its worker-backed calculation does not block the protocol loop, but the request itself can wait behind other jobs and exceed an enclosing client's timeout. Large or queued MCP requests should use `background:true` and poll/cancel through `backtest_job`. Successful validation jobs retain the plan, resolved specification, warnings, and estimates in `job.result`.

Estimates describe actual supplied warmup bars/range, total/evaluation bars, and typed-column bytes. They are not predicted process RSS. MCP specifications have a separate 1 MiB input limit so returning the complete resolved specification fits the 2 MiB tool-output budget. All tool inputs also have 8 MiB, depth-64, and structural-value limits; errors have their own bounded safe encoder. The SDK stdio transport additionally bounds its read buffer.

## Files, identity, and artifacts

The service copies each authorized source into a private bounded snapshot before parsing. The source-byte hash is recorded separately from normalized dataset identity. Normalized metadata includes units, timezone, raw prices, explicit sessions/instrument rules, PIT universe mode, and corporate-action coverage. Native frame preparation adds calendar/aggregation provenance and published as-of features to that identity. Feature `null` explicitly withdraws a prior value.

Imports reject invalid or unsorted rows, ambiguous timestamps, unknown units, missing execution inputs, and precision-losing numeric JSON prices. There is no automatic sorting, deduplication, interpolation, or cleaning mode. CSV/JSONL decoding is streamed, but normalization is bounded in-memory work. Optional readers have their own decoded/expanded-size limits.

Paths resolve inside the configured workspace; store artifacts use validated handles and owned regular files. Import sources use `O_NOFOLLOW` where supported to reject a replaced leaf symlink. The application must own its store and trust workspace directories: this is not protection against a same-privilege adversarial local process repeatedly replacing ancestor directories.

Runs and studies publish complete directories by atomic rename. Manifests identify versions, fingerprints, files, byte counts, and SHA-256 hashes. Readers verify selected content rather than returning unverified partial files. Queries allow at most 200 rows and 256 KiB of selected JSON per page. Cursors are bound to artifact/query identity; unsupported projections and filters are rejected. Complete selected artifacts are currently scanned and verified on every page, so paging has O(total table rows) I/O per page.

Output `summary` still calculates full-resolution metrics but omits detail; `trades` retains orders/fills; `fullTrace` also retains ledger events, equity, decisions, and a standalone HTML/SVG report. Unrecorded details or reports produce `DETAILS_NOT_RECORDED`. Chart sampling never changes metrics. Explanation replays require the retained original dataset and compatible engine version, preserve the original range/seed/financial rules, and link the derived run to its source; missing dependencies are errors.

## Job ownership, cancellation, and retention

A persistent MCP server owns one store and its bounded worker pool across calls. If a different host creates and destroys a process per tool call, that host needs its own persistent service; a returned handle alone cannot keep a dead process alive.

Job states are `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `canceled`, and `interrupted`. Queued cancellation removes work before execution. Running work receives cooperative cancellation and then bounded worker termination if necessary. Once artifact commit has begun, cancellation is explicitly refused rather than reporting a cancellation over committed success. On restart, unfinished jobs become `interrupted`; there is no checkpoint resume claim. Recovery removes only recognized unpublished staging directories while holding store ownership.

Live ownership and stale-lock recovery are tested. If a process dies while holding the recovery guard itself, startup fails closed and operator inspection is required. Restart recovery is separate from rerunning an explanation from the original initial state.

Default service limits include 32 active/queued jobs, 64 MiB source imports, two million import rows, 256 MiB dataset/cache payloads, 120-second job runtime, 128 MiB output per job, and 512 MiB V8 old-generation budget per worker. Research has a separate global nested-worker allowance, candidate/bar limits, and read-only shared dataset columns within candidate evaluation. Ordinary workers each retain one decoded dataset; this is not an LRU cache or a guarantee that process RSS equals column bytes.

Retained datasets, plans, runs, and studies share a serialized-commit quota, default 1 GiB. `store-policy.json` explicitly records `until-explicit-cleanup` and `automaticEviction:false`. Job bookkeeping and temporary snapshots/staging are excluded from that retained quota and constrained separately. There is **no automatic LRU eviction or online deletion API**. Intentional cleanup/archiving is an offline operator action with the service stopped; active dependencies are not evicted. This is a bounded retention policy, not a filesystem-wide or total-RSS guarantee.

## Executed coverage and release evidence

| Area | Executable evidence | Interpretation |
|---|---|---|
| Official stdio/client protocol, complete workflow, schemas, errors, paging, explanations, native frames, reports | [mcp.test.ts](../test/mcp.test.ts), [adapters-research.test.ts](../test/adapters-research.test.ts) | Real SDK clients spawn the server; stdout must remain protocol-only. |
| Worker jobs, queued/running cancellation, recovery, path bounds, quotas, races, background validation | [runtime.test.ts](../test/runtime.test.ts), [runtime-races.test.ts](../test/runtime-races.test.ts), [runtime-research.test.ts](../test/runtime-research.test.ts) | SDK/runtime evidence; does not imply Codex cancellation was demonstrated. |
| SDK/CLI parity, JSON/YAML, different cwd, structured exit failures | [cli.test.ts](../test/cli.test.ts), [adapters-research.test.ts](../test/adapters-research.test.ts) | Same underlying engine and frozen dataset identity. |
| Integrity, bounded queries, report rendering and preview | [results.test.ts](../test/results.test.ts), [reports.test.ts](../test/reports.test.ts), [Chrome preview](evidence/report-preview.png) | Missing or corrupt artifacts fail explicitly; report was visually inspected. |
| Optional binary formats | [optional-format tests](../optional-formats/test/formats.test.mjs) | Real binary writers/readers, exact-price rejection, sheet/formula and expansion-limit checks. |
| Packaged/offline execution | [smoke-package.mjs](../scripts/smoke-package.mjs), generated `dist/package/smoke-report.json` | Extracted package outside repo, empty PATH/NODE_PATH, blocked networking, no installed runtime dependencies. Match the final manifest before claiming release acceptance. |
| Actual Codex | Stage 3 seven-tool transcript; Stage 4 [packaged 12-tool verifier](evidence/codex-package-smoke-verified.json) and transcript above | Passed 24 calls in one connection; real host evidence remains distinct from official SDK transport evidence. |

Recorded package smoke coverage is Linux x64 on Node 22 and Node 24. Windows, macOS, and Bun remain unverified and are not silently included in the tested support matrix. The final build is re-packaged and re-tested after source changes. Performance claims require the measured final workload report, not the historical 34-line benchmark or the design's unmeasured two-second target.
