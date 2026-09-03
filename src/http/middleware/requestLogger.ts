import type { RequestHandler } from 'express';
import type { Logger } from '../../app/logging/index.js';
import { getCorrelationId } from './correlationId.js';

/**
 * Emits exactly one structured JSON record per completed request.
 *
 * Only the ROUTE pattern is logged, never the raw URL or query string, so that
 * user-supplied content cannot be smuggled into the log stream. All values pass
 * through the logger's redaction layer regardless.
 */

export interface RequestLoggerOptions {
  readonly logger: Logger;
  /** Monotonic millisecond source; injected for deterministic tests. */
  readonly now?: () => number;
}

export function createRequestLoggerMiddleware(
  options: RequestLoggerOptions,
): RequestHandler {
  const now = options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  return (req, res, next) => {
    const startedAt = now();
    res.on('finish', () => {
      const route: string =
        typeof req.route === 'object' && req.route !== null && 'path' in req.route
          ? String((req.route as { path: unknown }).path)
          : 'unmatched';
      options.logger.info('http_request_completed', {
        correlationId: getCorrelationId(res),
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: now() - startedAt,
      });
    });
    next();
  };
}
