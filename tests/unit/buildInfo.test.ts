import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_REVISION_PLACEHOLDERS,
  assertProvenance,
  isValidRevision,
  resolveBuildInfo,
} from '../../src/app/buildInfo.js';

const VALID_SHA = 'a'.repeat(40);

describe('AC7 positive: build provenance metadata', () => {
  it('resolves a complete provenance record', () => {
    const info = resolveBuildInfo({
      ETBZ_GIT_COMMIT: VALID_SHA,
      ETBZ_BUILD_VERSION: '0.1.0',
      ETBZ_SOURCE_REPOSITORY: 'https://github.com/DYAI2025/ETBZ',
      ETBZ_BUILD_TIMESTAMP: '2026-01-01T00:00:00Z',
    });

    expect(info.revision).toBe(VALID_SHA);
    expect(assertProvenance(info)).toEqual({ ok: true });
  });
});

describe('AC7 negative: revision metadata must never silently default', () => {
  it('never produces the literal string "unknown"', () => {
    for (const value of [undefined, '', '   ', 'unknown', 'UNKNOWN', 'latest', 'HEAD']) {
      const info = resolveBuildInfo(
        value === undefined ? {} : { ETBZ_GIT_COMMIT: value },
      );
      expect(info.revision).toBeNull();
      expect(info.revision).not.toBe('unknown');
    }
  });

  it('rejects every forbidden placeholder', () => {
    for (const placeholder of FORBIDDEN_REVISION_PLACEHOLDERS) {
      expect(isValidRevision(placeholder)).toBe(false);
    }
  });

  it('rejects a malformed sha', () => {
    expect(isValidRevision('abc123')).toBe(false);
    expect(isValidRevision('A'.repeat(40))).toBe(false);
    expect(isValidRevision(`${VALID_SHA}0`)).toBe(false);
    expect(isValidRevision(VALID_SHA)).toBe(true);
  });

  it('fails the provenance gate when the revision is absent', () => {
    const result = assertProvenance(
      resolveBuildInfo({
        ETBZ_BUILD_VERSION: '0.1.0',
        ETBZ_SOURCE_REPOSITORY: 'https://github.com/DYAI2025/ETBZ',
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field)).toContain('revision');
  });
});
