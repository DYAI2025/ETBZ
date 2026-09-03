import type { RequestHandler } from 'express';

/**
 * Liveness only.
 *
 * The body is a frozen constant with EXACTLY one field. `/health` asserts that
 * this process is running and able to serve HTTP - nothing else. It makes no
 * statement about configuration, FuFirE, a database, Etsy, PDF rendering,
 * delivery, or production readiness, and it must keep answering 200 while
 * configuration is invalid so that an unhealthy-config container stays
 * observable instead of being killed by a liveness probe.
 */
export const HEALTH_RESPONSE_BODY = Object.freeze({ status: 'alive' } as const);

export function createHealthHandler(): RequestHandler {
  return (_req, res) => {
    res.status(200).json(HEALTH_RESPONSE_BODY);
  };
}
