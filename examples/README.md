# Local file and CLI examples

`frames.json` and `frames-bars.jsonl` provide a runnable native multi-timeframe
example combining two-minute SMA, completed daily close, and as-of predictions.
See [the frame contract and expected fills](../docs/FRAMES.md).

`prices.csv` contains five synthetic daily bars for the fictitious instrument
`AAA`. `metadata.json` explicitly defines its timezone, calendar, units, tick,
quantity, and settlement rules. It is a deterministic software fixture, not real
market data or a production market profile.

`basic.json` and `basic.yaml` describe the same run. They deliberately declare
zero transaction costs for an easily checked example: buy at the next open after
the first close, then exit at the next open after the third close. With the stated
prices and 1,000 initial cash, a complete run should finish at 1,100 before any
external flows. The zero-cost, one-share-lot, T+0 settings are fixture assumptions;
they must not be inferred as A-share defaults.

After building:

```sh
npm run build
npm run cli -- prepare --config examples/basic.yaml --output /tmp/example-dataset.json
npm run cli -- inspect --dataset /tmp/example-dataset.json
npm run cli -- validate --config examples/basic.json
npm run cli -- run --config examples/basic.yaml --output /tmp/example-result.json
```

Use an appropriate output path on your platform. Omitting `--output` from `run`
prints the result as one JSON value. `prepare` without `--output` reports the
normalized manifest without writing a cache file. `inspect --config` also imports
and reports the dataset. Paths inside configuration files are resolved relative
to the configuration file, while CLI `--output` is relative to the current cwd.

## Input contracts

The top-level CLI configuration has `dataset` and, for validation/execution,
`spec`. `dataset` is one of:

```json
{
  "path": "prices.csv",
  "format": "csv",
  "metadataPath": "metadata.json",
  "columns": { "openTime": "start_time", "closeTime": "end_time" },
  "maxRows": 2000000,
  "maxFileBytes": 67108864,
  "maxRecordBytes": 1048576
}
```

The mapping above is illustrative; the supplied example CSV already uses the
canonical headers, so `basic.json` needs no mapping. A mapping runs from canonical
field name to source column name. Inline `metadata` may replace `metadataPath`;
supplying both is rejected.

Alternatively, reuse a prepared cache:

```json
{ "cachePath": "prepared-dataset.json" }
```

Supported file inputs are:

- CSV with required columns `symbol`, `openTime`, `closeTime`, `session`, `open`,
  `high`, `low`, `close`, and `volume`; optional `amount`, `tradable`, `limitUp`,
  and `limitDown`.
- JSONL with one bar object per nonblank line and explicit external metadata.
- JSON containing a complete `DatasetInput`, or a bars array plus explicit
  external metadata. Complete JSON datasets can include features, membership,
  and corporate actions. CSV/JSONL configurations may supply those event arrays
  explicitly as sibling dataset options.

Price and amount values must be decimal strings in JSON/JSONL. CSV preserves
their decimal text. Volume is a finite nonnegative numeric quantity in the
explicit metadata unit. Units and adjustment conventions are not guessed or
converted silently.

Bar times accept integer epoch milliseconds or full ISO strings with `Z`/an
explicit UTC offset. Date-only and local timestamps are rejected; `session` is
the separately declared local trading date. The `spec` uses epoch milliseconds,
as shown in both examples. No automatic bar-open/bar-close inference is applied.

Rows must already be increasing and non-overlapping for each symbol. Import does
not silently sort, deduplicate, interpolate, or invent missing prices. CSV/JSONL
parsing is streamed with byte, record, and row limits, then bounded rows are
normalized into the in-memory columnar dataset; this is not an out-of-core engine.
JSON and YAML documents are size-bounded whole-document reads. YAML aliases and
duplicate keys are rejected.

Prepared caches contain explicit little-endian typed-array payloads, a format
version, and a checksum. Decoding checks both the envelope checksum and the
recomputed normalized dataset identity before accepting its data. This detects
corruption; it is not a cryptographic assertion about the source's trustworthiness.

The SDK entry point for the same importer is:

```ts
const dataset = await importDataset({
  path: '/absolute/path/prices.csv',
  format: 'csv',
  metadata,
  maxRows: 2_000_000,
});
```

Input imports perform no network requests. Filesystem authorization is enforced
by the embedding adapter; the standalone CLI follows the paths explicitly
provided by its caller.


## Research and standalone report

`research-config.json` supplies a small rules strategy and an explicit `prediction`
feature for the `research-sweep.json`, `research-walk-forward.json` and
`research-factors.json` requests. These single-symbol, five-bar examples exercise
interfaces; they are not statistically meaningful research. Insufficient
cross-sectional samples produce null correlations.

`research-demo.mjs` selects the compiled source service during development and
`../service.cjs` in the standalone distribution. Pass a store directory as its
first argument. The demo prints study handles and summaries for sweep,
walk-forward and factor jobs.

The CLI also exposes `sweep`, `walk-forward`, `factors` and `report`; see the root
README for complete commands. A report consumes a saved fullTrace result and emits
one HTML file containing inline SVG charts, with no network assets.
