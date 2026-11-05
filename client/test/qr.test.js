import { describe, it, expect } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { encodeQr, rsEncode, rsGenerator, formatBits, versionBits, dataCodewords, byteCapacity, versionFor, interleave, toBytes, qrPath, qrSvg, penalty, MAX_VERSION } from '../src/lib/qr.js';
import { QrCode } from '../src/components/QrCode.jsx';

// Reference matrices produced by an independent encoder (byte mode, level M).
const VECTORS = [
  { text: 'A', version: 1, mask: 0, rows: ['#######..###..#######', '#.....#.#.###.#.....#', '#.###.#...#...#.###.#', '#.###.#..#....#.###.#', '#.###.#.##..#.#.###.#', '#.....#...#.#.#.....#', '#######.#.#.#.#######', '...........##........', '#.#.#.#...##....#..#.', '#..###...#....#...##.', '.#....#.###.#...#...#', '#.#.#....##...#...#..', '#.#..##.#.#.#.#.#.#.#', '........####.#.#.#.#.', '#######....#.###.####', '#.....#..#.###.###...', '#.###.#.##.#.###.##.#', '#.###.#.......#...##.', '#.###.#.##..#...#...#', '#.....#..##...#...##.', '#######.#...#.#.#.###'] },
  { text: 'otpauth://totp/Keel:demo?secret=JBSWY3DPEHPK3PXP&issuer=Keel', version: 4, mask: 3, rows: ['#######.#...##..#.######..#######', '#.....#.######...##.##.#..#.....#', '#.###.#...#....##.###...#.#.###.#', '#.###.#.#.#...##.#..###...#.###.#', '#.###.#..##.#.#..#.#..#...#.###.#', '#.....#..#.####.#.###.#.#.#.....#', '#######.#.#.#.#.#.#.#.#.#.#######', '........###.....#####............', '#.##.###.#.#..##.###.####.#..#.##', '..#.##..###...#.#.####.#.###.##..', '##.##.##..#.#.#.###.#..####..#.##', '.#...#.#.#.#.####.#...####...#.##', '.##...#####....#.#.#######.#.#..#', '##...#.##...##.##.##.#######.#.#.', '.#...##.##.#.#....####...###..#..', '.....#.####.#####..#.##.#.##.####', '..##.##.##.#.##...#...##..#.#..#.', '##.....####.##.#.....########..#.', '##.#..##.###.######..#..#..#..##.', '.#...#.##.##.#..##.....##.##...##', '.##..#######.#..##..#...#..#..#.#', '#..##.....#..##.##.##.#....#..#.#', '..#.###.#.#####.#.#..#.#.#.#..###', '.#..#..######.....##......#..#.#.', '#.##.##.#..##..#.###..###########', '........#..#.####.##....#...##.#.', '#######.#...#.#...###.###.#.##.#.', '#.....#.#.##........##.##...###..', '#.###.#..###.....##.##.######.###', '#.###.#.##.#..##.#..#.####.#.#..#', '#.###.#.###....###...###..#..#...', '#.....#..#...###.###..##.###....#', '#######.#.##.#.#.###.#.#...###...'] },
];

const rowsOf = (modules) => modules.map((row) => row.map((m) => (m ? '#' : '.')).join(''));

// Reads the 15 format bits back the way a scanner does (top-left copy), undoing the mask.
function readFormat(modules) {
  const size = modules.length;
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits = (bits << 1) | (modules[8][i] ? 1 : 0);
  bits = (bits << 1) | (modules[8][7] ? 1 : 0);
  bits = (bits << 1) | (modules[8][8] ? 1 : 0);
  bits = (bits << 1) | (modules[7][8] ? 1 : 0);
  for (let i = 5; i >= 0; i--) bits = (bits << 1) | (modules[i][8] ? 1 : 0);
  let second = 0;
  for (let i = 0; i < 7; i++) second = (second << 1) | (modules[size - 1 - i][8] ? 1 : 0);
  for (let i = 7; i < 15; i++) second = (second << 1) | (modules[8][size - 15 + i] ? 1 : 0);
  return { first: bits, second };
}

describe('Reed–Solomon and BCH tables', () => {
  it('matches the published "HELLO WORLD" 1-M example (10 EC codewords)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    expect(rsGenerator(2)).toEqual([1, 3, 2]);
  });

  it('format information matches the standard table for level M and L', () => {
    const M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    M.forEach((bits, mask) => expect(formatBits('M', mask).toString(2).padStart(15, '0')).toBe(bits));
    expect(formatBits('L', 0).toString(2).padStart(15, '0')).toBe('111011111000100');
    expect(formatBits('H', 7).toString(2).padStart(15, '0')).toBe('000100000111011');
    expect(formatBits('Q', 0).toString(2).padStart(15, '0')).toBe('011010101011111');
  });

  it('version information carries the BCH(18,6) remainder', () => {
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
    expect(versionBits(10).toString(2).padStart(18, '0')).toBe('001010010011010011');
  });
});

describe('data codewords', () => {
  it('byte capacities for level M follow the standard (14 … 213 bytes for versions 1–10)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => byteCapacity(v, 'M'))).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
    expect(versionFor(14)).toBe(1);
    expect(versionFor(15)).toBe(2);
    expect(versionFor(213)).toBe(10);
    expect(() => versionFor(214)).toThrow(RangeError);
    expect(MAX_VERSION).toBe(10);
  });

  it('writes mode, count, bytes, terminator and the EC/11 padding', () => {
    const cw = dataCodewords(toBytes('A'), 1, 'M');
    expect(cw).toEqual([0x40, 0x14, 0x10, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]);
    expect(interleave(cw, 1, 'M')).toHaveLength(26);
    expect(toBytes('é')).toEqual(new Uint8Array([0xc3, 0xa9]));
  });

  it('interleaves blocks of unequal length (version 8-M: 2×38 + 2×39) column-wise', () => {
    const data = Array.from({ length: 154 }, (_, i) => i & 0xff);
    const out = interleave(data, 8, 'M');
    expect(out).toHaveLength(242);
    expect(out.slice(0, 4)).toEqual([0, 38, 76, 115]);
    expect(out[4 * 38]).toBe(114);
    expect(out[4 * 38 + 1]).toBe(153);
  });
});

describe('encodeQr', () => {
  it('reproduces the reference matrices module for module', () => {
    for (const v of VECTORS) {
      const q = encodeQr(v.text, { mask: v.mask });
      expect(q.version).toBe(v.version);
      expect(q.size).toBe(v.rows.length);
      expect(rowsOf(q.modules)).toEqual(v.rows);
    }
  });

  it('picks a mask by penalty, keeps the function patterns and writes both format copies', () => {
    const text = 'otpauth://totp/Keel%20(nova.example):testuser?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Keel%20(nova.example)&algorithm=SHA1&digits=6&period=30';
    const q = encodeQr(text);
    expect(q.version).toBe(versionFor(toBytes(text).length));
    expect(q.version).toBeGreaterThanOrEqual(7);
    expect(q.size).toBe(q.version * 4 + 17);
    expect(q.mask).toBeGreaterThanOrEqual(0);
    expect(q.mask).toBeLessThanOrEqual(7);
    const forced = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => penalty(encodeQr(text, { mask }).modules));
    expect(forced[q.mask]).toBe(Math.min(...forced));
    const { first, second } = readFormat(q.modules);
    expect(first).toBe(second);
    expect(first).toBe(formatBits('M', q.mask));
    const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    const rows = rowsOf(q.modules);
    expect(rows.slice(0, 7).map((r) => r.slice(0, 7))).toEqual(finder);
    expect(rows.slice(0, 7).map((r) => r.slice(-7))).toEqual(finder);
    expect(rows.slice(-7).map((r) => r.slice(0, 7))).toEqual(finder);
    expect(rows[6].slice(8, -8)).toBe('#.'.repeat((q.size - 17) / 2).concat('#'));
    expect(q.modules[q.size - 8][8]).toBe(true);
    // Versions 7+ carry version information: bit 0 at (0, size-11) in the top-right block.
    expect(q.modules[0][q.size - 11]).toBe((versionBits(q.version) & 1) === 1);
    expect(q.modules[5][q.size - 9]).toBe(((versionBits(q.version) >>> 17) & 1) === 1);
  });

  it('refuses unknown levels and oversized data', () => {
    expect(() => encodeQr('x', { level: 'Z' })).toThrow(RangeError);
    expect(() => encodeQr('x'.repeat(214))).toThrow(RangeError);
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
  });

  it('renders an SVG path with a quiet zone and escapes the title', () => {
    const q = encodeQr('A', { mask: 0 });
    const path = qrPath(q.modules, 4);
    expect(path.startsWith('M4 4h7v1h-7z')).toBe(true);
    const svg = qrSvg('A', { size: 100, title: 'a<b' });
    expect(svg).toContain('viewBox="0 0 29 29"');
    expect(svg).toContain('<title>a&lt;b</title>');
    expect(svg).toContain('width="100"');
  });
});

describe('QrCode component', () => {
  it('renders an inline SVG with the version and label, and the fallback when the value does not fit', () => {
    const html = renderToStaticMarkup(h(QrCode, { value: 'otpauth://totp/Keel:demo?secret=JBSWY3DPEHPK3PXP&issuer=Keel', label: 'Enrolment code' }));
    expect(html).toContain('<svg');
    expect(html).toContain('data-version="4"');
    expect(html).toContain('aria-label="Enrolment code"');
    expect(html).toContain('<path d="M');
    const fallback = renderToStaticMarkup(h(QrCode, { value: 'x'.repeat(300), fallback: h('p', null, 'too long') }));
    expect(fallback).toBe('<p>too long</p>');
    expect(renderToStaticMarkup(h(QrCode, { value: '' }))).toBe('');
  });
});
