/**
 * ETBZ-2 — deterministic JSON canonicalization for hashing and evidence.
 *
 * Pure string/domain-level helper: no imports, no I/O. Key order is sorted so
 * that two structurally equal values always serialize to the same text, which
 * is the precondition for stable SHA-256 evidence hashes.
 *
 * - Object keys are sorted lexicographically (by UTF-16 code unit).
 * - `undefined` properties are dropped; `null` is preserved.
 * - Arrays keep their order.
 * - Numbers use JSON.stringify semantics (IEEE-754 shortest round-trip).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError('canonicalJson: value is not JSON-representable');
}
