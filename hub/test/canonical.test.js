import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, canonicalString, isCanonical } from '../shared/canonical.js';
import { canonicalVectors } from './fixtures/index.js';

test('golden vectors produce the exact canonical bytes', () => {
  for (const v of canonicalVectors.vectors) {
    assert.equal(canonicalString(v.value), v.canonical, v.name);
    assert.deepEqual(canonicalize(v.value), Buffer.from(v.canonical, 'utf8'), `${v.name} bytes`);
    assert.ok(isCanonical(v.canonical), `${v.name} round-trips`);
  }
});

test('keys sort by UTF-16 code unit, not by code point or locale', () => {
  assert.equal(canonicalString({ '￿': 1, '😀': 2 }), '{"😀":2,"￿":1}');
  assert.equal(canonicalString({ b: 1, B: 2, a: 3 }), '{"B":2,"a":3,"b":1}');
});

test('integers only: floats, NaN, Infinity, unsafe integers, bigint throw', () => {
  for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 10n]) {
    assert.throws(() => canonicalize({ n: bad }), /not canonical|non-|safe range|bigint|unsupported/i, String(bad));
  }
  assert.equal(canonicalString({ z: -0 }), '{"z":0}');
});

test('undefined, functions, symbols, buffers and toJSON objects are refused; undefined object members are dropped', () => {
  assert.throws(() => canonicalize(undefined));
  assert.throws(() => canonicalize({ f() {} }));
  assert.throws(() => canonicalize({ b: Buffer.from('x') }));
  assert.throws(() => canonicalize({ d: new Date(0) }));
  assert.equal(canonicalString({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalString([undefined, 1]), '[null,1]');
});

test('escaping matches JSON: only what JSON requires, lowercase \\u00xx for controls, raw UTF-8 otherwise', () => {
  assert.equal(canonicalString('\u0000\u001f\u007f\u0080é'), '"\\u0000\\u001f\u007f\u0080é"');
  assert.equal(canonicalString('</script>'), '"</script>"');
});

test('isCanonical rejects whitespace, re-ordered keys and invalid JSON', () => {
  assert.equal(isCanonical('{"b":1,"a":2}'), false);
  assert.equal(isCanonical('{"a": 1}'), false);
  assert.equal(isCanonical('{'), false);
  assert.equal(isCanonical('{"a":1,"b":[true]}'), true);
});
