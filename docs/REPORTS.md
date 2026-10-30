# Standalone HTML reports

`renderReport(result)` returns one self-contained HTML document with inline SVG account-equity and unit-NAV drawdown charts, original metrics, at most 20 sampled fills, the explicit fee model, warnings, engine version, dataset hash, run fingerprint, and seed. It loads no libraries, scripts, fonts, images, or network resources. All external text is HTML-escaped and a restrictive content security policy is included.

```ts
import { renderReport } from 'ts-backtest';
const html = renderReport(fullTraceResult);
```

Or render a retained result using the CLI:

```sh
node dist/src/adapters/cli.js report --input result.json --output report.html
```

Reports require `output.level: "fullTrace"`. A summary or trades result returns `DETAILS_NOT_RECORDED`, with a full-rerun hint. Empty fullTrace observations and zero-trade results render explicit empty states; they do not invent curves or trades.

The report scans every recorded unit-NAV observation to calculate the displayed drawdown series before reducing chart points. Each chart retains first/last observations and extrema within at most 400 chronological buckets, yielding at most 1,600 displayed points. Sampling never changes the supplied result or recalculates its stored metrics. Original metric values are available in the report's expandable table. Charts are a presentation of recorded bars, not additional execution evidence.

`persistResult` automatically adds `report.html` for fullTrace runs. The report is included in the same atomic publication, SHA-256 manifest, and total-output byte budget as other artifacts, and also has a separate 2 MiB limit. Older saved runs without a report remain readable.

MCP `backtest_report` takes `{ "runId": "..." }` and returns only:

```ts
{ path: string, sha256: string, bytes: number, mimeType: 'text/html' }
```

The service verifies the complete stored report against the manifest before returning that local handle. It rejects corrupted, missing, and symlinked artifacts. The HTML body is not embedded in tool output. Reports absent from older runs require a fullTrace rerun or a caller-retained full result passed to the SDK/CLI renderer.

The checked preview in `docs/evidence/report-preview.png` was rendered by local headless Google Chrome from the synthetic default example. It is visual validation of the standalone renderer, not performance evidence or market research.
