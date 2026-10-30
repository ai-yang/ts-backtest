import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, contentHash } from '../src/spec/canonical.js';

test('fingerprints ignore JSON object key order but retain ordered schedules', () => {
  assert.equal(contentHash({ b: [1, 2], a: '0.005' }), contentHash({ a: '0.005', b: [1, 2] }));
  assert.notEqual(contentHash({ b: [1, 2] }), contentHash({ b: [2, 1] }));
  assert.notEqual(contentHash({ amount: '0.005' }), contentHash({ amount: '0.006' }));
});

test('invalid canonical data cannot turn into plausible JSON', () => {
  for (const value of [NaN, Infinity, -Infinity, 1n, new Date()]) assert.throws(() => canonicalJSON({ value }));
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => canonicalJSON(cycle), /cycle/);
  assert.equal(canonicalJSON({ b: undefined, a: null }), '{"a":null}');
});
