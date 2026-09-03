import type { RequestHandler } from 'express';
import { getCorrelationId } from '../middleware/correlationId.js';
import type { ErrorResponseBody } from './httpError.js';

/**
 * Terminal 404 handler. The requested path is deliberately NOT echoed: the
 * response body stays a constant so no request-controlled content is reflected.
 */
export function createNotFoundHandler(): RequestHandler {
  return (_req, res) => {
    const body: ErrorResponseBody = {
      error: {
        code: 'not_found',
        message: 'Resource not found.',
        correlationId: getCorrelationId(res),
      },
    };
    res.status(404).json(body);
  };
}
