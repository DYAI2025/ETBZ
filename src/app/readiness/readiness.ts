import type { ConfigIssue, ConfigLoadResult } from '../configuration/index.js';

/**
 * ETBZ-9 readiness.
 *
 * Exactly ONE capability is activated in this slice: `configuration`.
 *
 * The capability list is a closed literal union. Claiming readiness for a
 * dependency ETBZ-9 does not have (FuFirE, Etsy, database, PDF, delivery) is
 * therefore a compile error, not merely a convention. Later slices widen this
 * union together with the dependency they actually introduce.
 */

export const ETBZ9_READINESS_CAPABILITIES = ['configuration'] as const;

export type ReadinessCapabilityName = (typeof ETBZ9_READINESS_CAPABILITIES)[number];

export type CapabilityStatus = 'ok' | 'fail';

export interface CapabilityReport {
  readonly name: ReadinessCapabilityName;
  readonly status: CapabilityStatus;
  /** Value-free configuration issues. Present only when `status === 'fail'`. */
  readonly issues?: readonly ConfigIssue[];
}

export type ReadinessStatus = 'ready' | 'not_ready';

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly capabilities: readonly CapabilityReport[];
}

/** HTTP status codes the readiness endpoint is allowed to return. */
export const READINESS_HTTP_STATUS: Record<ReadinessStatus, 200 | 503> = {
  ready: 200,
  not_ready: 503,
};

/**
 * Derives the readiness report from a configuration load result.
 *
 * Fail-closed: anything other than a fully valid configuration is `not_ready`.
 */
export function evaluateReadiness(configResult: ConfigLoadResult): ReadinessReport {
  if (configResult.ok) {
    return Object.freeze({
      status: 'ready' as const,
      capabilities: Object.freeze([
        Object.freeze({ name: 'configuration' as const, status: 'ok' as const }),
      ]),
    });
  }
  return Object.freeze({
    status: 'not_ready' as const,
    capabilities: Object.freeze([
      Object.freeze({
        name: 'configuration' as const,
        status: 'fail' as const,
        issues: configResult.issues,
      }),
    ]),
  });
}

export function readinessHttpStatus(report: ReadinessReport): 200 | 503 {
  return READINESS_HTTP_STATUS[report.status];
}
