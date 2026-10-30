# Native higher-timeframe preparation

`applyFrames(dataset, configuration)` and `importDataset({ ..., frames })` aggregate source OHLCV/amount into native higher frames, compute indicators on those frames, and publish completed outputs as as-of features. CLI `dataset.frames` and MCP `backtest_prepare_data.frames` use the same implementation. Core execution still uses the original daily or one-minute bars; weekly/monthly evaluation does not masquerade as a daily execution dataset.

## Run the supplied example

From the project directory:

```sh
npm run build
node dist/src/adapters/cli.js run --config examples/frames.json --output /tmp/backtest-frames-result.json
```

`examples/frames-bars.jsonl` contains 16 synthetic one-minute bars over two short, split sessions. `frames.json` prepares two-minute SMA(2) and daily close, then combines both with an external `prediction` feature carrying an explicit publication timestamp. The first daily close enables an entry; the next session's subsequently published negative prediction triggers an exit. Expected fills are 10 shares bought at 18 and sold at 19, leaving 1,010 under the explicitly declared fixture costs. These shortened sessions, zero fees, and T+0 lots are software fixture assumptions.

SDK usage is identical:

```ts
import { importDataset, applyFrames } from 'ts-backtest';

const prepared = await importDataset({
  path: '/workspace/minute-bars.jsonl',
  format: 'jsonl',
  metadata,
  features: predictions, // { symbol, name, availableAt, value }
  frames: {
    from: firstSourceOpen,
    asOf: lastKnownSourceClose,
    recipes: [{
      id: 'hour',
      frame: { unit: 'minute', minutes: 60, tailPolicy: 'short' },
      missingPolicy: 'error',
      nodes: { closeAverage: { op: 'sma', args: [{ field: 'close' }], period: 20 } },
      outputs: { sma20: { ref: 'closeAverage' } },
    }],
  },
});
// For an already normalized source: applyFrames(source, configuration).
// Strategy expression: { feature: 'frame:hour:sma20' }.
```

All account, cost, execution, and annualization settings remain explicit in the separate backtest specification. The example files supply them; frame preparation does not invent them.

## Calendar and completeness

Native frames require both optional metadata fields:

```ts
calendarCoverage: { from: '2024-01-01', through: '2024-01-31' },
sessionIntervals: [{
  session: '2024-01-02',
  segments: [
    { openTime: /* UTC epoch ms */, closeTime: /* UTC epoch ms */ },
    { openTime: /* UTC epoch ms */, closeTime: /* UTC epoch ms */ },
  ],
}]
```

`calendarCoverage` declares a complete, inclusive range of calendar dates, including known non-trading dates. Every `metadata.sessions` entry inside that range must have exactly one corresponding `sessionIntervals` entry, in order. Dates absent from that complete calendar are declared non-trading dates; the engine does not consult an exchange calendar or infer holidays. Metadata may retain later settlement dates outside this range without supplying their intervals.

Segments must be non-overlapping, ordered, have whole-minute durations, and lie on their declared local session date in `metadata.timezone`. Explicit UTC timestamps account for time-zone/DST changes and half-days. Overnight sessions spanning two local dates are currently unsupported by the base dataset contract.

- **Minute N:** intervals anchor at each segment's open. Lunch breaks and other gaps reset the anchor; aggregation never crosses them. `tailPolicy: 'drop'` omits a remainder shorter than N; `'short'` emits that shorter segment-end frame only when all its source minutes exist.
- **Day:** all declared segments in that session must be present.
- **Week:** ISO Monday–Sunday calendar groups. The declared calendar must cover the whole week; publication occurs at its final declared trading session's close.
- **Month:** calendar-month groups, likewise requiring full calendar coverage and the final declared trading session's close.

`frames.from` and `frames.asOf` define the explicitly available source interval. A frame beginning before `from` or closing after `asOf` is excluded. This also excludes partial first/last weeks or months. Future bars in the source file cannot make a frame visible before `asOf`. The engine never treats the last observed row as proof that a trading session, week, or month ended.

One-minute sources must exactly match the session minute grid. Daily sources can produce day/week/month frames and must cover the full declared session; upsampling daily bars into minutes is rejected. Daily source bars naturally span intraday breaks, while minute source completeness counts only tradable segments.

For completed calendar frames, `missingPolicy: 'error'` rejects missing minutes or whole sessions. `'skip'` omits that symbol's incomplete frame, records a warning/count, and does not advance its indicators. A skip leaves the last successfully published feature in effect until a later frame publishes a replacement; choose `error` when retaining an older observation is unacceptable. No price interpolation, synthetic volume, or automatic filling of gaps occurs.

## Expressions, missing values, and publication

Each recipe has an independent compiled expression DAG. Existing arithmetic, rolling indicators, ATR/MACD, comparisons, cross sections, named references, and external as-of features are available. `period: 20` means 20 completed bars of that recipe, not 20 base bars. Cross sections synchronize symbols completing at the same frame timestamp and respect point-in-time membership. Account-state expressions are rejected because account state does not exist during preparation. `{ time: 'at' }` denotes the completed frame timestamp.

Outputs are numeric feature observations named `frame:<recipe-id>:<output-name>`. Every completed frame publishes every output at exactly its close. Warmup, unavailable input, or non-finite results publish `value: null`; this explicitly withdraws a previously available value instead of silently retaining it. At base-bar evaluation, null becomes unavailable/NaN and cannot satisfy a trading predicate. Boolean outputs are represented as 0/1.

External features and predictions also accept null withdrawal and are read only when `availableAt <= frame.closeTime`. Frames operate on original input features; recipes do not implicitly depend on another recipe's generated outputs. Put all requested recipes in a single preparation call. Re-preparing an already derived dataset and overwriting an existing output feature name are rejected.

Higher-frame outputs are available to a base decision at the same closing timestamp. Normal next-open execution then applies, including an adjacent minute whose open equals that close. They never affect an earlier base decision.

## Identity and bounds

`metadata.frameProvenance` records the source dataset hash, normalized preparation configuration, generated names, and per-recipe aggregated/missing/incomplete counts. The provenance and published features participate in the normal dataset content hash and survive cache encode/decode checks. Base bar arrays are retained, and rehashing avoids rebuilding them. Appending later valid data may change the dataset identity but cannot revise already published historical values.

Limits are 16 recipes, 64 outputs and 1,024 named nodes per recipe, preparation-object depth 56 (reserving space in the depth-64 cache envelope), dependency depth 64 and 4,096 graph nodes including output dependencies, one million candidate/aggregated windows per recipe, and one million generated feature points in total. Existing indicator memory, importer bytes/rows, worker, and MCP message limits also apply. Preparation is bounded in-memory work performed by the background prepare worker; it is amortized across subsequent runs, not an out-of-core aggregation system.
