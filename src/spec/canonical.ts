import { createHash } from 'node:crypto';
import { BacktestError } from './errors.js';

/** Deterministic JSON; never silently turns NaN/Infinity into null. */
export function canonicalJSON(value: unknown): string {
  const seen = new Set<object>();
  function normalize(v: unknown): unknown {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new BacktestError('NON_FINITE_VALUE', 'Canonical data must be finite');
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v !== 'object') throw new BacktestError('INVALID_JSON_VALUE', `Unsupported canonical type ${typeof v}`);
    if (seen.has(v)) throw new BacktestError('CYCLIC_INPUT', 'Canonical input contains a cycle');
    seen.add(v);
    let result: unknown;
    if (Array.isArray(v)) result = v.map(normalize);
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new BacktestError('INVALID_JSON_VALUE', 'Only plain JSON objects are accepted');
      result = Object.fromEntries(Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined).map(k => [k, normalize((v as Record<string, unknown>)[k])]));
    }
    seen.delete(v);
    return result;
  }
  return JSON.stringify(normalize(value));
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}
