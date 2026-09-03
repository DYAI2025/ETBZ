import express from 'express';
import type { Express } from 'express';
import type { Logger } from '../app/logging/index.js';
import type { ReadinessReport } from '../app/readiness/index.js';
import { createErrorHandler } from './errors/errorHandler.js';
import { createNotFoundHandler } from './errors/notFound.js';
import { createCorrelationIdMiddleware } from './middleware/correlationId.js';
import { createRequestLoggerMiddleware } from './middleware/requestLogger.js';
import { createPublicRouter } from './routes/index.js';

/**
 * Express 5 application factory - a THIN adapter.
 *
 * No body parser is mounted: the ETBZ-9 surface is GET-only, so request-body
 * handling would be unused attack surface. `x-powered-by` is disabled and
 * `etag` is off so probe responses carry no incidental fingerprinting.
 *
 * All collaborators are injected. `createEtbzApp` performs no I/O, reads no
 * environment and starts no listener, which is what lets the integration,
 * negative and contract suites drive it in-process via supertest.
 */

export interface EtbzAppDependencies {
  readonly evaluateReadiness: () => ReadinessReport;
  readonly logger: Logger;
  readonly generateCorrelationId: () => string;
}

export function createEtbzApp(dependencies: EtbzAppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');

  app.use(
    createCorrelationIdMiddleware({ generate: dependencies.generateCorrelationId }),
  );
  app.use(createRequestLoggerMiddleware({ logger: dependencies.logger }));

  app.use(
    createPublicRouter({ evaluateReadiness: dependencies.evaluateReadiness }),
  );

  app.use(createNotFoundHandler());
  app.use(createErrorHandler({ logger: dependencies.logger }));

  return app;
}
