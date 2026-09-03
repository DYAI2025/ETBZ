import { Router } from 'express';
import type { ReadinessReport } from '../../app/readiness/index.js';
import { createHealthHandler } from './health.js';
import { createReadyHandler } from './ready.js';

/**
 * THE public HTTP surface of ETBZ-9.
 *
 * `PUBLIC_ROUTES` is the single source of truth. The Express router is DERIVED
 * from it, and `openapi/etbz.openapi.yaml` is verified against it by
 * `tests/contract`. Three-way agreement (registry / live router / OpenAPI) is
 * what makes contract drift detectable rather than merely discouraged.
 *
 * ETBZ-9 exposes no business surface. Adding `/orders`, `/webhook`, `/render`
 * or `/bazi` here is rejected by `tests/architecture/no-business-surface`.
 */

export type PublicRouteMethod = 'get';

export interface PublicRouteDefinition {
  readonly method: PublicRouteMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  /** Every status code this route is allowed to return. */
  readonly statuses: readonly number[];
}

export const PUBLIC_ROUTES = [
  {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Liveness probe',
    statuses: [200],
  },
  {
    method: 'get',
    path: '/ready',
    operationId: 'getReadiness',
    summary: 'Readiness probe for the configuration capability',
    statuses: [200, 503],
  },
] as const satisfies readonly PublicRouteDefinition[];

export interface PublicRouterDependencies {
  readonly evaluateReadiness: () => ReadinessReport;
}

/**
 * Builds the router by iterating `PUBLIC_ROUTES`. The `switch` is exhaustive
 * over the declared operation ids, so a registry entry without a handler is a
 * compile-time error and a handler without a registry entry is unreachable.
 */
export function createPublicRouter(dependencies: PublicRouterDependencies): Router {
  const router = Router();
  for (const route of PUBLIC_ROUTES) {
    switch (route.operationId) {
      case 'getHealth':
        router[route.method](route.path, createHealthHandler());
        break;
      case 'getReadiness':
        router[route.method](
          route.path,
          createReadyHandler({ evaluate: dependencies.evaluateReadiness }),
        );
        break;
      default: {
        const exhaustive: never = route;
        throw new Error(
          `Unhandled public route operation: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
  return router;
}

export { HEALTH_RESPONSE_BODY, createHealthHandler } from './health.js';
export { createReadyHandler } from './ready.js';
export type { ReadyHandlerDependencies } from './ready.js';
