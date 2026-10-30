import { assertThat } from '../spec/errors.js';
import type { BacktestResult, EquityPoint } from '../spec/types.js';

const MAX_BUCKETS = 400;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const number = (value: number | null): string => value !== null && Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value) : 'Unavailable';
const percent = (value: number | null): string => value !== null && Number.isFinite(value) ? `${number(value * 100)}%` : 'Unavailable';
function timestamp(at: number): string {
  if (!Number.isFinite(at)) return 'Unavailable';
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', ' UTC') : 'Unavailable';
}
interface Point { index: number; at: number; value: number }
interface Bucket { first: Point; last: Point; minimum: Point; maximum: Point }
function include(bucket: Bucket | undefined, point: Point): Bucket {
  if (!bucket) return { first: point, last: point, minimum: point, maximum: point };
  bucket.last = point;
  if (point.value < bucket.minimum.value) bucket.minimum = point;
  if (point.value > bucket.maximum.value) bucket.maximum = point;
  return bucket;
}
function finish(bucket: Bucket | undefined, points: Point[]): void {
  if (!bucket) return;
  const unique = new Map([bucket.first, bucket.minimum, bucket.maximum, bucket.last].map(point => [point.index, point]));
  points.push(...[...unique.values()].sort((a, b) => a.index - b.index));
}

/** Scan every original NAV before sampling; sampling never feeds back into metrics. */
function sample(points: EquityPoint[]): { equity: Point[]; drawdown: Point[] } {
  const width = Math.max(1, Math.ceil(points.length / MAX_BUCKETS));
  const equity: Point[] = [], drawdown: Point[] = [];
  let equityBucket: Bucket | undefined, drawdownBucket: Bucket | undefined;
  let peak = 0, previousAt = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const row = points[i]!;
    assertThat(Number.isFinite(row.at) && row.at >= previousAt && Number.isFinite(row.equity) &&
      Number.isFinite(row.unitNav) && row.unitNav >= 0, 'INVALID_REPORT_DATA', 'Equity observations must be ordered and have finite equity and nonnegative unit NAV');
    previousAt = row.at; peak = Math.max(peak, row.unitNav);
    equityBucket = include(equityBucket, { index: i, at: row.at, value: row.equity });
    drawdownBucket = include(drawdownBucket, { index: i, at: row.at, value: peak > 0 ? Math.min(0, row.unitNav / peak - 1) : 0 });
    if ((i + 1) % width === 0 || i === points.length - 1) {
      finish(equityBucket, equity); finish(drawdownBucket, drawdown);
      equityBucket = undefined; drawdownBucket = undefined;
    }
  }
  return { equity, drawdown };
}

function chart(points: Point[], kind: 'equity' | 'drawdown', title: string): string {
  if (!points.length) return '<p class="empty">No equity observations were recorded.</p>';
  const w = 960, h = 270, left = 80, right = 24, top = 22, bottom = 42;
  let min = Infinity, max = -Infinity;
  for (const point of points) { min = Math.min(min, point.value); max = Math.max(max, point.value); }
  if (kind === 'drawdown') { max = 0; if (min === 0) min = -0.01; }
  else if (min === max) { const padding = Math.max(Math.abs(min) * 0.05, 1); min -= padding; max += padding; }
  else { const padding = (max - min) * 0.08; min -= padding; max += padding; }
  const first = points[0]!, last = points.at(-1)!;
  const x = (at: number) => first.at === last.at ? (left + w - right) / 2 : left + (at - first.at) / (last.at - first.at) * (w - left - right);
  const y = (value: number) => top + (max - value) / (max - min) * (h - top - bottom);
  const coord = (value: number) => value.toFixed(2);
  const path = points.map((point, i) => `${i ? 'L' : 'M'}${coord(x(point.at))},${coord(y(point.value))}`).join(' ');
  const axisValue = (value: number) => kind === 'drawdown' ? `${number(value * 100)}%`
    : new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5, ...(Math.abs(value) >= 1_000_000 ? { notation: 'compact' as const } : {}) }).format(value);
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = max - (max - min) * i / 4, at = y(value);
    return `<line x1="${left}" y1="${coord(at)}" x2="${w - right}" y2="${coord(at)}" stroke="#e4eaf0"/><text x="${left - 12}" y="${coord(at + 4)}" text-anchor="end">${escape(axisValue(value))}</text>`;
  }).join('');
  const area = `${path} L${coord(x(last.at))},${coord(y(kind === 'drawdown' ? 0 : min))} L${coord(x(first.at))},${coord(y(kind === 'drawdown' ? 0 : min))} Z`;
  const color = kind === 'equity' ? '#177c72' : '#bd5b4c';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${kind}-title" data-displayed-points="${points.length}"><title id="${kind}-title">${escape(title)}</title><rect width="${w}" height="${h}" fill="#ffffff"/>${grid}<path d="${area}" fill="${color}" fill-opacity="0.09"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${coord(x(last.at))}" cy="${coord(y(last.value))}" r="3" fill="${color}"/><text x="${left}" y="${h - 12}">${escape(timestamp(first.at))}</text><text x="${w - right}" y="${h - 12}" text-anchor="end">${escape(timestamp(last.at))}</text></svg>`;
}

function card(label: string, value: unknown, raw: unknown, key: string): string {
  return `<div class="metric" data-metric="${escape(key)}" data-raw="${escape(raw)}"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`;
}

/** A standalone, script-free report; all metrics remain those of the original run. */
export function renderReport(result: BacktestResult): string {
  assertThat(result?.spec?.output?.level === 'fullTrace' && Array.isArray(result.equity),
    'DETAILS_NOT_RECORDED', 'HTML reports require a fullTrace run with retained equity observations', '',
    { requiredOutput: 'fullTrace', rerunRequired: true, rerunScope: 'original complete run with original data and versions' });
  assertThat(result.metrics && result.spec.account && result.spec.costs && Array.isArray(result.fills) && Array.isArray(result.warnings),
    'INVALID_REPORT_DATA', 'Report requires complete result metadata, metrics, fees and fill arrays');
  const sampled = sample(result.equity), metrics = result.metrics;
  const coverage = metrics.drawdownCoverage?.status ?? 'unverified';
  const qualifiedDrawdown = coverage !== 'complete';
  const drawdownLabel = qualifiedDrawdown ? `Observed max drawdown · unit NAV · coverage ${coverage}` : 'Max drawdown · unit NAV';
  const coverageCaption = qualifiedDrawdown ? `Observed drawdown only; coverage ${coverage}. This is not verified full-period risk. ` : '';
  const displayedFills = result.fills.length <= 20 ? result.fills : [...result.fills.slice(0, 10), ...result.fills.slice(-10)];
  const fillRows = displayedFills.map(fill => `<tr><td>${escape(timestamp(fill.at))}</td><td>${escape(fill.symbol)}</td><td>${escape(fill.side)}</td><td class="numeric">${escape(fill.quantity)}</td><td class="numeric">${escape(fill.price)}</td><td class="numeric">${escape(fill.fees.total)}</td><td>${escape(fill.reason)}</td></tr>`).join('');
  const warnings = result.warnings.slice(0, 50).map(warning => `<li><code>${escape(warning.code)}</code> ${escape(warning.message)}</li>`).join('');
  const unavailable = Object.entries(metrics.unavailable).slice(0, 30).map(([key, reason]) => `<li><code>${escape(key)}</code>: ${escape(reason)}</li>`).join('');
  const feeRows = result.spec.costs.periods.slice(0, 20).map(period => `<tr><td>${escape(timestamp(period.from))}</td><td>${period.to === undefined ? 'Open-ended' : escape(timestamp(period.to))}</td><td>${escape(period.commissionRate)}</td><td>${escape(period.minimumCommission)}</td><td>${escape(period.sellTaxRate)}</td><td>${escape(period.transferRate)}</td></tr>`).join('');
  const rawMetrics = Object.entries(metrics).filter(([key]) => key !== 'unavailable').map(([key, value]) => `<tr><th>${escape(key)}</th><td class="mono">${escape(typeof value === 'object' ? JSON.stringify(value) : value)}</td></tr>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Backtest report · ${escape(result.mode)}</title><style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#243449;background:#f1f4f7}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:36px auto;padding:0 28px 40px}header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#177c72;font-weight:700}h1{font-size:34px;letter-spacing:-.04em;margin:7px 0 8px}h2{font-size:18px;margin:0 0 12px}p{line-height:1.6}.subtitle,.muted{color:#69788c;font-size:13px}.badge{padding:7px 12px;border-radius:30px;background:#e0ece9;font-size:12px;font-weight:700;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}.metric{background:white;border:1px solid #e0e6ec;border-radius:12px;padding:17px 20px;min-width:0}.metric span{display:block;font-size:12px;color:#69788c;margin-bottom:9px}.metric strong{font-size:24px;font-weight:650;overflow-wrap:anywhere}.panel{background:white;border:1px solid #e0e6ec;border-radius:14px;padding:24px;margin:16px 0;overflow:hidden}svg{width:100%;height:auto;display:block}svg text{font:11px system-ui,sans-serif;fill:#718096}.chart-note{margin:8px 0 0;font-size:12px;color:#69788c}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #edf0f4;padding:10px 9px;vertical-align:top}th{font-weight:600;color:#69788c}.numeric{text-align:right}.mono,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.meta{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px 16px;font-size:12px}.meta dt{color:#69788c}.meta dd{margin:0;overflow-wrap:anywhere}.notice{border-left:3px solid #d6a652;background:#faf7f0;padding:12px 16px;font-size:12px}li{margin:8px 0;line-height:1.5;overflow-wrap:anywhere}ul{padding-left:20px}.empty{padding:50px 12px;text-align:center;color:#69788c}details summary{cursor:pointer;font-weight:600;font-size:13px}footer{font-size:11px;color:#69788c;margin-top:24px}@media(max-width:650px){main{padding:0 14px}.metrics{grid-template-columns:repeat(2,1fr)}.panel{padding:16px}header{align-items:flex-start;flex-direction:column}.meta{grid-template-columns:1fr;gap:4px}.meta dd{margin-bottom:10px}}@media print{body{background:white}main{margin:0;max-width:none;padding:0}.panel,.metric{break-inside:avoid}details{display:block}}
</style></head><body><main><header><div><div class="eyebrow">ts-backtest / TypeScript engine</div><h1>Backtest report</h1><div class="subtitle">${escape(timestamp(result.spec.start))} — ${escape(timestamp(result.spec.end))} · end exclusive</div></div><span class="badge">${escape(result.mode)} · fullTrace</span></header>
<div class="metrics">${card(`Final equity · ${result.spec.account.currency}`, metrics.finalEquity, metrics.finalEquity, 'finalEquity')}${card('Net profit', metrics.netProfit, metrics.netProfit, 'netProfit')}${card('Time-weighted return', percent(metrics.timeWeightedReturn), metrics.timeWeightedReturn, 'timeWeightedReturn')}${card(drawdownLabel, percent(metrics.maxDrawdownPct.value), metrics.maxDrawdownPct.value, 'maxDrawdownPct')}${card('Sharpe', number(metrics.sharpe), metrics.sharpe, 'sharpe')}${card('Total fees', metrics.fees, metrics.fees, 'fees')}</div>
<section class="panel"><h2>Account equity · ${escape(result.spec.account.currency)}</h2>${chart(sampled.equity, 'equity', 'Account equity over time')}<p class="chart-note">${escape(result.equity.length)} recorded observations; ${escape(sampled.equity.length)} displayed. Account equity includes external cash flows.</p></section>
<section class="panel"><h2>${qualifiedDrawdown ? 'Observed drawdown' : 'Drawdown'} · unit NAV</h2>${chart(sampled.drawdown, 'drawdown', 'Drawdown from the running peak of unit NAV')}<p class="chart-note">${escape(coverageCaption)}Drawdown is computed from every recorded unit-NAV observation before chart sampling. First/last points and each bucket's extrema are retained. Report metrics are copied unchanged from the complete run.</p></section>
<section class="panel"><h2>Execution sample</h2><p class="muted">${escape(metrics.fillCount)} total fills; ${escape(displayedFills.length)} retained fills shown${result.fills.length > 20 ? ' (first 10 and last 10)' : ''}. Prices and fees retain their recorded decimal strings.</p>${displayedFills.length ? `<div class="scroll"><table><thead><tr><th>Time (UTC)</th><th>Symbol</th><th>Side</th><th>Quantity</th><th>Price</th><th>Fees</th><th>Reason</th></tr></thead><tbody>${fillRows}</tbody></table></div>` : '<p class="empty">No fills were recorded.</p>'}</section>
<section class="panel"><h2>Run provenance</h2><dl class="meta"><dt>Engine / schema</dt><dd>${escape(result.engineVersion)} / ${escape(result.schemaVersion)}</dd><dt>Dataset hash</dt><dd class="mono">${escape(result.datasetHash)}</dd><dt>Run fingerprint</dt><dd class="mono">${escape(result.fingerprint)}</dd><dt>Dataset handle</dt><dd class="mono">${escape(result.spec.datasetId ?? 'Not supplied')}</dd><dt>Random seed</dt><dd>${escape(result.spec.seed)}</dd><dt>Strategy / execution</dt><dd>${escape(result.spec.strategy.kind)} · ${escape(result.spec.execution.decisionAt)} → ${escape(result.spec.execution.fillAt)}</dd><dt>Initial cash / flows</dt><dd>${escape(metrics.initialCash)} / ${escape(metrics.netExternalFlows)} ${escape(result.spec.account.currency)}</dd><dt>Annualization</dt><dd>${escape(result.spec.analytics.annualPeriods)} periods/year; risk-free rate ${escape(result.spec.analytics.riskFreeRate)}</dd></dl></section>
<section class="panel"><h2>Explicit cost model</h2><p class="muted">${escape(result.spec.costs.version)} · commission scope: ${escape(result.spec.costs.scope)} · slippage: ${escape(result.spec.execution.slippage.type)} / ${escape(result.spec.execution.slippage.bps)} bps.</p><div class="scroll"><table><thead><tr><th>From (UTC)</th><th>To (exclusive)</th><th>Commission rate</th><th>Minimum</th><th>Sell tax rate</th><th>Transfer rate</th></tr></thead><tbody>${feeRows}</tbody></table></div>${result.spec.costs.periods.length > 20 ? `<p class="muted">Showing the first 20 of ${escape(result.spec.costs.periods.length)} cost periods; inspect the resolved specification for all periods.</p>` : ''}</section>
<section class="panel"><h2>Warnings and unavailable metrics</h2>${warnings ? `<ul class="notice">${warnings}</ul>` : '<p class="muted">No run warnings were recorded.</p>'}${result.warnings.length > 50 ? '<p class="muted">Only the first 50 warnings are shown.</p>' : ''}${unavailable ? `<ul>${unavailable}</ul>` : '<p class="muted">No metric availability limitations were recorded.</p>'}</section>
<section class="panel"><details><summary>Original metric values</summary><div class="scroll"><table><tbody>${rawMetrics}</tbody></table></div></details></section><footer>Standalone report · no JavaScript, external assets, or network requests. Display sampling affects charts only. A report documents the supplied backtest result and its declared assumptions.</footer></main></body></html>`;
  assertThat(Buffer.byteLength(html) <= MAX_REPORT_BYTES, 'REPORT_TOO_LARGE', 'HTML report exceeds its 2 MiB artifact budget');
  return html;
}
