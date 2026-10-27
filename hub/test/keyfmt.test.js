import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as keyfmt from '../shared/keyfmt.js';

test('generate() produces WHM-XXXX-XXXX-XXXX-XXXX keys that pass check()', () => {
  for (let i = 0; i < 200; i++) {
    const k = keyfmt.generate();
    assert.match(k, /^WHM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{3}[0-9A-HJKMNP-TV-Z*~$=U]$/);
    assert.ok(keyfmt.check(k));
  }
});

test('normalize() accepts lower case, missing dashes, spaces, no prefix, and maps O->0, I/L->1', () => {
  const k = keyfmt.generate();
  const bare = k.slice(4).replace(/-/g, '');
  assert.equal(keyfmt.normalize(bare.toLowerCase()), k);
  assert.equal(keyfmt.normalize(` whm ${bare.slice(0, 8)} ${bare.slice(8)} `), k);
  const withLookalikes = bare.slice(0, 15).replace(/0/g, 'O').replace(/1/g, 'I') + bare[15];
  assert.equal(keyfmt.normalize(withLookalikes), k);
  const withL = bare.slice(0, 15).replace(/1/g, 'l') + bare[15];
  assert.equal(keyfmt.normalize(withL), k);
});

test('normalize() rejects wrong length, forbidden characters and non-strings', () => {
  assert.equal(keyfmt.normalize('WHM-ABCD'), null);
  assert.equal(keyfmt.normalize('WHM-ABCD-ABCD-ABCD-ABC!'), null);
  assert.equal(keyfmt.normalize(null), null);
  assert.equal(keyfmt.normalize('UUUUUUUUUUUUUUUU'), null);
});

test('a wrong check character is rejected', () => {
  const k = keyfmt.generate();
  const chars = k.slice(4).replace(/-/g, '');
  const wrong = keyfmt.CHECK_ALPHABET[(keyfmt.CHECK_ALPHABET.indexOf(chars[15]) + 1) % keyfmt.CHECK_ALPHABET.length];
  assert.equal(keyfmt.check(chars.slice(0, 15) + wrong), false);
  const flipped = (chars[0] === 'A' ? 'B' : 'A') + chars.slice(1);
  assert.equal(keyfmt.check(flipped), false);
});

test('hash() is sha256 of the normalized form and prefixOf() is the first group', () => {
  const k = keyfmt.generate();
  assert.equal(keyfmt.hash(k.toLowerCase()), crypto.createHash('sha256').update(k).digest('hex'));
  assert.equal(keyfmt.prefixOf(k), k.slice(0, 8));
  assert.throws(() => keyfmt.hash('nope'));
});
