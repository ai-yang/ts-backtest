# Optional local data formats

This package supplies an explicitly enabled Parquet, Arrow IPC and XLSX reader.
It is distributed separately from the core engine. The production `formats.cjs`
bundles its runtime dependencies; deployment does not run `npm install` or contact
any network service.

```bash
node /opt/ts-backtest/cli.cjs run --config run.yaml \
  --formats /opt/ts-backtest-optional-formats/formats.cjs
```

The trusted application can instead call `setFormatAdapter('/absolute/path/formats.cjs')`
before importing data or constructing workers. This sets `BACKTEST_FORMAT_ADAPTER`
for worker inheritance. Configure this once when the host starts. Strategy and data
configuration cannot select executable modules. The adapter protocol is version 1.

```yaml
dataset:
  path: prices.parquet
  format: parquet  # or arrow / xlsx
  metadataPath: metadata.json
  columns:
    symbol: ticker
    open: opening
  # formatOptions: { sheet: Bars }  # XLSX; required if multiple worksheets
spec: # the same explicit BacktestSpec used for CSV/JSON
```

All formats require the same explicit dataset metadata and canonical column
mapping as CSV. Prices, price limits and amounts must be plain decimal **text**
columns/cells. Floating-point prices and Parquet/Arrow native decimal objects are
rejected: the adapter does not claim to restore precision already lost by the
source. Epoch-millisecond integers must fit JavaScript's exact integer range;
alternatively use zoned ISO text. No timestamp unit or Excel date system is guessed.
XLSX formulas, cached formula results, error cells, date cells, encrypted archives,
and ZIP64 are rejected. Other columns must be flat scalar text/numbers/booleans.

Source bytes and row counts are bounded. XLSX ZIP directory sizes and Parquet
uncompressed column sizes are checked before expansion; the expanded-byte budget
is `min(8 * maxFileBytes, 256 MiB)`. This is a parser budget, not an out-of-core
promise or a strict process-RSS guarantee. Arrow supports IPC file/stream payloads
accepted by the pinned Apache Arrow reader. Parquet uses the pinned decompression
package; malformed or unsupported encodings return a structured import error.

Build/test installation, separate from runtime:

```bash
npm ci --prefix optional-formats
npm run test:optional
npm run package
```

Pinned dependency behavior follows the primary documentation:

- [Hyparquet reader](https://github.com/hyparam/hyparquet): metadata preflight and object rows.
- [Hyparquet writer](https://github.com/hyparam/hyparquet-writer): test-only real Parquet fixtures.
- [Apache Arrow JavaScript](https://arrow.apache.org/js/current/): IPC tables and serialization.
- [SheetJS Node installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/): the official 0.20.3 tarball, not the older npm-registry release.
- [SheetJS parsing options](https://docs.sheetjs.com/docs/api/parse-options/): raw cells, selected sheets and row bounds.

`package-lock.json` pins transitive dependencies and the official SheetJS tarball
integrity. The Parquet writer is a development dependency and is excluded from
the production adapter.
