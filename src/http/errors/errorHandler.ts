import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../../app/logging/index.js';
import { getCorrelationId } from '../middleware/correlationId.js';
import { HttpError } from './httpError.js';
import type { ErrorResponseBody } from './httpError.js';

/**
 * Terminal error handler.
 *
 * Client-visible detail is limited to a code plus an authored message. Internal
 * errors always produce the same constant message, so configuration values,
 * stack traces and dependency internals cannot escape through a 5xx body. The
 * full error goes to the (redacting) logger instead.
 */

export const INTERNAL_ERROR_MESSAGE = 'Internal server error.';

export interface ErrorHandlerOptions {
  readonly logger: Logger;
}

export function createErrorHandler(options: ErrorHandlerOptions): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const correlationId = getCorrelationId(res);
    const isHttpError = error instanceof HttpError;
    const status = isHttpError ? error.status : 500;
    const code = isHttpError ? error.code : 'internal_error';
    const message = isHttpError ? error.message : INTERNAL_ERROR_MESSAGE;

    options.logger.error('http_request_failed', {
      correlationId,
      status,
      code,
      error: error instanceof Error ? error : { name: 'NonError', message: 'non-error thrown' },
    });

    const body: ErrorResponseBody = { error: { code, message, correlationId } };
    res.status(status).json(body);
  };
}
