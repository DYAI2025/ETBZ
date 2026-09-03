import type { RequestHandler, Response } from 'express';

/**
 * Correlation ID propagation.
 *
 * An inbound ID is REUSED only when it is provably safe: a bounded,
 * conservatively charactered token. Anything else (over-long, control
 * characters, header injection attempts, absent) is replaced by a freshly
 * generated ID, so an attacker cannot steer log content through a header.
 */

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

/** Conservative allowlist: alphanumerics and `. _ - :`, 8..128 characters. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const CORRELATION_ID_LOCAL = 'correlationId';

export interface CorrelationIdOptions {
  readonly generate: () => string;
}

export function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

export function getCorrelationId(res: Response): string {
  const value: unknown = res.locals[CORRELATION_ID_LOCAL];
  return typeof value === 'string' ? value : '';
}

export function createCorrelationIdMiddleware(
  options: CorrelationIdOptions,
): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get(CORRELATION_ID_HEADER) ?? req.get(REQUEST_ID_HEADER);
    const correlationId = isSafeCorrelationId(inbound)
      ? inbound
      : options.generate();
    res.locals[CORRELATION_ID_LOCAL] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  };
}
