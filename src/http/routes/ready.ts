import type { RequestHandler } from 'express';
import type { ReadinessReport } from '../../app/readiness/index.js';
import { readinessHttpStatus } from '../../app/readiness/index.js';

/**
 * Readiness for the single capability activated in ETBZ-9: `configuration`.
 *
 * The report is re-evaluated per request rather than captured at boot, so the
 * endpoint reflects the live evaluation rather than a stale snapshot. The body
 * carries variable NAMES and static expectations only - never a configuration
 * value.
 */

export interface ReadyHandlerDependencies {
  readonly evaluate: () => ReadinessReport;
}

export function createReadyHandler(
  dependencies: ReadyHandlerDependencies,
): RequestHandler {
  return (_req, res) => {
    const report = dependencies.evaluate();
    res.status(readinessHttpStatus(report)).json(report);
  };
}
