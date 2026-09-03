import type { EnvironmentRecord } from './configuration/index.js';

/**
 * Build / provenance metadata.
 *
 * Hard rule for ETBZ-9: the source revision must never silently degrade to a
 * placeholder such as `unknown`. An absent or malformed revision is represented
 * as `null` and is rejected by `assertProvenance`, which the image build and
 * the provenance gate both run. The literal strings `unknown`, `none`, `n/a`
 * and `latest` are treated as INVALID rather than as values.
 */

export const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** Placeholders that must never be accepted as a real revision. */
export const FORBIDDEN_REVISION_PLACEHOLDERS: readonly string[] = [
  'unknown',
  'none',
  'n/a',
  'na',
  'null',
  'undefined',
  'latest',
  'dev',
  'head',
];

export const BUILD_INFO_VARIABLES = {
  revision: 'ETBZ_GIT_COMMIT',
  version: 'ETBZ_BUILD_VERSION',
  source: 'ETBZ_SOURCE_REPOSITORY',
  builtAt: 'ETBZ_BUILD_TIMESTAMP',
} as const;

export interface BuildInfo {
  /** 40-character lowercase git SHA, or null when not provably present. */
  readonly revision: string | null;
  readonly version: string | null;
  readonly source: string | null;
  readonly builtAt: string | null;
}

export interface ProvenanceIssue {
  readonly field: keyof BuildInfo;
  readonly variable: string;
  readonly code: 'missing' | 'invalid';
  readonly expectation: string;
}

export type ProvenanceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ProvenanceIssue[] };

function present(environment: EnvironmentRecord, variable: string): string | null {
  const raw = environment[variable];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function isValidRevision(value: string | null): value is string {
  if (value === null) {
    return false;
  }
  if (FORBIDDEN_REVISION_PLACEHOLDERS.includes(value.toLowerCase())) {
    return false;
  }
  return GIT_COMMIT_PATTERN.test(value);
}

/** Reads build metadata. Never invents a value; absent stays `null`. */
export function resolveBuildInfo(environment: EnvironmentRecord): BuildInfo {
  const revision = present(environment, BUILD_INFO_VARIABLES.revision);
  return Object.freeze({
    revision: isValidRevision(revision) ? revision : null,
    version: present(environment, BUILD_INFO_VARIABLES.version),
    source: present(environment, BUILD_INFO_VARIABLES.source),
    builtAt: present(environment, BUILD_INFO_VARIABLES.builtAt),
  });
}

/**
 * Provenance gate: used by the image build and by `scripts/build-dry-run.sh`.
 * A missing or placeholder revision fails, so `GIT_COMMIT` cannot default.
 */
export function assertProvenance(info: BuildInfo): ProvenanceResult {
  const issues: ProvenanceIssue[] = [];
  if (info.revision === null) {
    issues.push({
      field: 'revision',
      variable: BUILD_INFO_VARIABLES.revision,
      code: 'missing',
      expectation: 'a 40-character lowercase git commit SHA (no placeholder)',
    });
  }
  if (info.source === null) {
    issues.push({
      field: 'source',
      variable: BUILD_INFO_VARIABLES.source,
      code: 'missing',
      expectation: 'the source repository URL the artifact was built from',
    });
  }
  if (info.version === null) {
    issues.push({
      field: 'version',
      variable: BUILD_INFO_VARIABLES.version,
      code: 'missing',
      expectation: 'a non-empty build version identifier',
    });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
