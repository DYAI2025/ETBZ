/**
 * Deterministic redaction for structured logs.
 *
 * Two independent defences:
 *  1. KEY-shaped detection  - any field whose name looks credential-bearing is
 *     replaced wholesale, regardless of its value;
 *  2. VALUE-shaped detection - well-known credential encodings are replaced
 *     even when the surrounding field name is innocuous.
 *
 * Redaction is total (the value is dropped, not truncated or hashed) so that
 * no partial secret material can be reconstructed from logs.
 */

export const REDACTED = '[REDACTED]';

/** Field names that always carry credential material. */
const SECRET_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|credential|authorization|^auth$|cookie|session[-_]?id|private[-_]?key|api[-_]?key|access[-_]?key|client[-_]?secret|signature|signing[-_]?key|salt|bearer|^key$|^pwd$|^pw$)/i;

/** Value encodings that are credential material irrespective of field name. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /\b(?:AIza)[0-9A-Za-z_-]{35}\b/,
];

const MAX_DEPTH = 6;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function containsSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function redactString(value: string): string {
  return containsSecretValue(value) ? REDACTED : value;
}

/**
 * Returns a redacted deep copy. Cycles, functions, symbols and over-deep
 * structures are collapsed to markers rather than thrown on, because a logger
 * must never be able to crash the request path.
 */
export function redact(input: unknown): unknown {
  return redactInternal(input, 0, new WeakSet<object>());
}

function redactInternal(
  input: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (input === null || input === undefined) {
    return input;
  }
  if (typeof input === 'string') {
    return redactString(input);
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'bigint') {
    return input.toString();
  }
  if (typeof input === 'function' || typeof input === 'symbol') {
    return '[UNSERIALIZABLE]';
  }
  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (input instanceof Error) {
    return {
      name: input.name,
      message: redactString(input.message),
    };
  }
  if (input instanceof Date) {
    return input.toISOString();
  }
  if (typeof input === 'object') {
    if (seen.has(input)) {
      return '[CIRCULAR]';
    }
    seen.add(input);
    if (Array.isArray(input)) {
      return input.map((item) => redactInternal(item, depth + 1, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = isSecretKey(key)
        ? REDACTED
        : redactInternal(value, depth + 1, seen);
    }
    return output;
  }
  return '[UNSERIALIZABLE]';
}
