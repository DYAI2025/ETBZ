/**
 * ETBZ-25 — deterministic structural hashing for the narrative chain.
 *
 * Pure domain: no imports beyond the canonicalizer that already lives here, no
 * I/O, no clock, no randomness. `src/domain` may import NOTHING external
 * (`tests/architecture/dependency-direction.test.ts`, allowlist `[]`), so
 * `node:crypto` is not reachable from this layer and the digest is implemented
 * here in plain TypeScript.
 *
 * A hand-written digest is only trustworthy if it is MEASURED against the
 * reference implementation rather than asserted. `tests/unit/structural-hash.test.ts`
 * compares this function against `node:crypto`'s `createHash('sha256')` over
 * the empty string, ASCII, multi-byte UTF-8 (the Hanzi this repository actually
 * carries), every padding boundary (55/56/57/63/64/65 bytes) and multi-block
 * inputs. That equivalence proof is what makes the value below a SHA-256 rather
 * than "some hash"; without it this file would be an unverified claim.
 *
 * Scope: this is a STRUCTURAL FINGERPRINT for change detection and evidence —
 * it is not a security boundary, not a signature and not an authentication
 * mechanism, and nothing in ETBZ treats it as one.
 */

import { canonicalJson } from './canonical-json.js';

/** SHA-256 round constants (FIPS 180-4 §4.2.2). */
const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 initial hash value (FIPS 180-4 §5.3.3). */
const SHA256_H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/**
 * Checked word read.
 *
 * `noUncheckedIndexedAccess` types every array read as `number | undefined`.
 * Substituting a default here would silently produce a WRONG digest, so an
 * out-of-range read throws instead. Every call site below indexes within a
 * fixed, locally allocated buffer, so this branch is unreachable for any input
 * — it exists so that a future edit cannot make it reachable silently.
 */
function word(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`structural-hash: word index ${index} is outside the buffer`);
  }
  return value;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * SHA-256 of the UTF-8 encoding of `text`, lowercase hex.
 *
 * The encoding step is explicit: two structurally different strings must never
 * collapse to the same byte sequence, so the Hanzi and tone-marked pinyin this
 * repository carries are hashed as their real UTF-8 bytes.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // One 0x80 byte, then zeros, then a 64-bit big-endian length; the whole
  // message must end on a 64-byte boundary.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  // The high word is written explicitly rather than assumed zero: assuming it
  // would be an unstated input-size precondition.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = [...SHA256_H0];
  const schedule: number[] = new Array<number>(64).fill(0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      schedule[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = word(schedule, i - 15);
      const w2 = word(schedule, i - 2);
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      schedule[i] = (word(schedule, i - 16) + s0 + word(schedule, i - 7) + s1) >>> 0;
    }

    let a = word(h, 0);
    let b = word(h, 1);
    let c = word(h, 2);
    let d = word(h, 3);
    let e = word(h, 4);
    let f = word(h, 5);
    let g = word(h, 6);
    let hh = word(h, 7);

    for (let i = 0; i < 64; i += 1) {
      const bigS1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + bigS1 + ch + word(SHA256_K, i) + word(schedule, i)) >>> 0;
      const bigS0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (bigS0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (word(h, 0) + a) >>> 0;
    h[1] = (word(h, 1) + b) >>> 0;
    h[2] = (word(h, 2) + c) >>> 0;
    h[3] = (word(h, 3) + d) >>> 0;
    h[4] = (word(h, 4) + e) >>> 0;
    h[5] = (word(h, 5) + f) >>> 0;
    h[6] = (word(h, 6) + g) >>> 0;
    h[7] = (word(h, 7) + hh) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += word(h, i).toString(16).padStart(8, '0');
  }
  return hex;
}

/** Algorithm marker carried in every emitted hash, so evidence names its own method. */
export const STRUCTURAL_HASH_PREFIX = 'sha256:';

/**
 * Deterministic structural hash of any JSON-representable value.
 *
 * Canonicalization first (sorted keys, dropped `undefined`, preserved array
 * order), then SHA-256 of that text. Two structurally equal values therefore
 * always hash equal, and ANY structural change — a changed fact, a removed or
 * reordered source warning, a different theme membership — changes the hash.
 */
export function structuralHash(value: unknown): string {
  return `${STRUCTURAL_HASH_PREFIX}${sha256Hex(canonicalJson(value))}`;
}

/**
 * Structural hash of text that is ALREADY canonical.
 *
 * This exists because `structuralHash` must NOT be used on a canonical string:
 * canonicalizing a string is `JSON.stringify` of it, so the digest would be
 * taken over the QUOTED, escaped form. The published hash would then not be the
 * hash of the published text, and anyone re-deriving it independently
 * (`sha256sum` of the canonical JSON) would get a different value. A hash that
 * cannot be reproduced from what it is published next to is not evidence.
 *
 * `tests/unit/report-model.test.ts` re-derives both published hashes with
 * `node:crypto` from the published canonical text, so this property is
 * measured rather than asserted.
 */
export function structuralHashOfCanonicalText(canonicalText: string): string {
  return `${STRUCTURAL_HASH_PREFIX}${sha256Hex(canonicalText)}`;
}
