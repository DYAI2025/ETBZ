import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import {
  STRUCTURAL_HASH_PREFIX,
  sha256Hex,
  structuralHash,
} from '../../src/domain/structural-hash.js';

/**
 * ETBZ-25 — the digest is MEASURED, not asserted.
 *
 * `src/domain` may import nothing (`dependency-direction.test.ts`, allowlist
 * `[]`), so `node:crypto` is unreachable from that layer and SHA-256 is
 * implemented there in plain TypeScript. A hand-written digest is worth exactly
 * as much as its equivalence proof, so this suite compares it against
 * `node:crypto` — which the TEST layer may use — over the cases that break a
 * wrong implementation: the empty string, every padding boundary, multi-byte
 * UTF-8, and multi-block input.
 */

const reference = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('ETBZ-25: the domain SHA-256 equals node:crypto', () => {
  it('agrees on the published FIPS test vectors', () => {
    // Independent of node:crypto: the two canonical published digests.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it.each([
    ['empty', ''],
    ['single byte', 'a'],
    ['ascii word', 'abc'],
    ['55 bytes (last single-block length)', 'a'.repeat(55)],
    ['56 bytes (first two-block length)', 'a'.repeat(56)],
    ['57 bytes', 'a'.repeat(57)],
    ['63 bytes', 'a'.repeat(63)],
    ['64 bytes (exact block)', 'a'.repeat(64)],
    ['65 bytes', 'a'.repeat(65)],
    ['119 bytes', 'a'.repeat(119)],
    ['120 bytes', 'a'.repeat(120)],
    ['1000 bytes (multi-block)', 'xy'.repeat(500)],
    ['hanzi this repository actually carries', '庚午壬午辛亥乙未'],
    ['tone-marked pinyin', 'gēng wǔ rén wǔ xīn hài yǐ wèi'],
    ['german labels', 'Pferd Schwein Ziege Büffel Gefährte'],
    ['mixed multi-byte and ascii', 'Xin/辛 (xīn) — Metall'],
    ['four-byte code point', 'a\u{1F600}b'],
    ['json text', canonicalJson({ b: [1, 2, 3], a: 'x', n: null })],
  ])('matches the reference digest for %s', (_label, text) => {
    expect(sha256Hex(text)).toBe(reference(text));
  });

  it('matches the reference across every length from 0 to 200 bytes', () => {
    // A padding bug typically survives one hand-picked length and fails a
    // neighbour, so the whole boundary range is swept rather than sampled.
    for (let length = 0; length <= 200; length += 1) {
      const text = 'a'.repeat(length);
      expect(sha256Hex(text), `length ${String(length)}`).toBe(reference(text));
    }
  });

  it('separates inputs that differ only in a multi-byte character', () => {
    expect(sha256Hex('辛')).not.toBe(sha256Hex('庚'));
  });
});

describe('ETBZ-25: structuralHash is canonical and self-describing', () => {
  it('names its own algorithm', () => {
    expect(structuralHash({ a: 1 }).startsWith(STRUCTURAL_HASH_PREFIX)).toBe(true);
    expect(structuralHash({ a: 1 })).toBe(`${STRUCTURAL_HASH_PREFIX}${reference('{"a":1}')}`);
  });

  it('is insensitive to key order but sensitive to value change', () => {
    expect(structuralHash({ a: 1, b: 2 })).toBe(structuralHash({ b: 2, a: 1 }));
    expect(structuralHash({ a: 1, b: 2 })).not.toBe(structuralHash({ a: 1, b: 3 }));
  });

  it('is sensitive to array ORDER (evidence order is part of the fact)', () => {
    expect(structuralHash(['A', 'B'])).not.toBe(structuralHash(['B', 'A']));
  });

  it('is sensitive to a removed or duplicated entry', () => {
    expect(structuralHash(['A', 'A'])).not.toBe(structuralHash(['A']));
  });
});
