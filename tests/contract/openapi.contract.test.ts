import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '../../src/http/routes/index.js';
import { listServedRoutes, routeKey } from '../support/expressRoutes.js';
import { createTestApp, VALID_ENVIRONMENT } from '../support/testRuntime.js';

/**
 * AC6 - contract guard.
 *
 * Three-way agreement is asserted:
 *
 *   OpenAPI document  <->  route registry  <->  LIVE Express router
 *
 * Comparing OpenAPI against the registry alone would miss a route mounted
 * directly on the app; comparing against the live router alone would miss a
 * documented-but-unserved path. Both directions are checked, so drift in
 * either direction fails.
 */

const OPENAPI_PATH = resolve(process.cwd(), 'openapi/etbz.openapi.yaml');

interface OpenApiOperation {
  readonly operationId?: string;
  readonly responses?: Record<string, unknown>;
}
interface OpenApiDocument {
  readonly openapi?: string;
  readonly paths?: Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function loadOpenApi(): OpenApiDocument {
  return yaml.load(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument;
}

function documentedRouteKeys(document: OpenApiDocument): string[] {
  const keys: string[] = [];
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.includes(method.toLowerCase())) {
        keys.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return keys.sort();
}

describe('AC6 positive: the OpenAPI document is a valid 3.1 description', () => {
  it('declares OpenAPI 3.1', () => {
    expect(loadOpenApi().openapi).toMatch(/^3\.1\.\d+$/);
  });

  it('gives every documented operation an operationId', () => {
    const document = loadOpenApi();
    for (const operations of Object.values(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations)) {
        if (HTTP_METHODS.includes(method.toLowerCase())) {
          expect(operation.operationId, `${method} is missing an operationId`).toBeTruthy();
        }
      }
    }
  });
});

describe('AC6: OpenAPI paths == actually served public routes', () => {
  it('documents exactly the routes the application serves', () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const served = listServedRoutes(app).map(routeKey).sort();
    const documented = documentedRouteKeys(loadOpenApi());

    // Both directions: undocumented served route AND unserved documented path.
    expect(served).toEqual(documented);
  });

  it('serves exactly /health and /ready in ETBZ-9', () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    expect(listServedRoutes(app).map(routeKey).sort()).toEqual([
      'GET /health',
      'GET /ready',
    ]);
  });

  it('keeps the route registry in sync with the live router', () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const registry = PUBLIC_ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path}`,
    ).sort();

    expect(listServedRoutes(app).map(routeKey).sort()).toEqual(registry);
  });

  it('keeps the route registry in sync with the OpenAPI document', () => {
    const registry = PUBLIC_ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path}`,
    ).sort();

    expect(documentedRouteKeys(loadOpenApi())).toEqual(registry);
  });

  it('documents exactly the status codes each route declares', () => {
    const document = loadOpenApi();
    for (const route of PUBLIC_ROUTES) {
      const operation = document.paths?.[route.path]?.[route.method];
      expect(operation, `missing ${route.method} ${route.path}`).toBeDefined();
      const documentedStatuses = Object.keys(operation?.responses ?? {})
        .map(Number)
        .sort((a, b) => a - b);
      expect(documentedStatuses).toEqual([...route.statuses].sort((a, b) => a - b));
    }
  });

  it('matches operationIds between registry and document', () => {
    const document = loadOpenApi();
    for (const route of PUBLIC_ROUTES) {
      expect(document.paths?.[route.path]?.[route.method]?.operationId).toBe(
        route.operationId,
      );
    }
  });
});

describe('AC6: the route observer itself is not blind (guard self-check)', () => {
  // The contract guard is only as good as what listServedRoutes() can see.
  // These probes assert it against synthetic apps that mount a surface in each
  // shape Express supports - including `app.use(path, handler)`, which carries
  // no `.route` and is therefore the easiest surface to serve invisibly.
  it('sees a conventional method route', () => {
    const probe = express();
    probe.get('/orders', (_request, response) => {
      response.json({});
    });

    expect(listServedRoutes(probe).map(routeKey)).toContain('GET /orders');
  });

  it('sees a plain handler mounted with app.use(path, handler)', () => {
    const probe = express();
    probe.use('/orders', (_request, response) => {
      response.json({});
    });

    expect(
      listServedRoutes(probe).length,
      'a surface mounted with app.use(path, handler) must not be invisible',
    ).toBeGreaterThan(0);
  });

  it('sees a router mounted under a path prefix', () => {
    const probe = express();
    const nested = express.Router();
    nested.get('/detail', (_request, response) => {
      response.json({});
    });
    probe.use('/orders', nested);

    expect(listServedRoutes(probe).length).toBeGreaterThan(0);
  });

  it('does NOT report pathless middleware as a served surface', () => {
    const probe = express();
    probe.use((_request, _response, next) => {
      next();
    });
    probe.get('/health', (_request, response) => {
      response.json({});
    });

    expect(listServedRoutes(probe).map(routeKey)).toEqual(['GET /health']);
  });
});

describe('AC6 negative: no business path is documented', () => {
  it('documents no out-of-scope business path', () => {
    const documented = Object.keys(loadOpenApi().paths ?? {});

    for (const forbidden of ['/orders', '/webhook', '/render', '/bazi', '/receipt', '/delivery']) {
      expect(documented).not.toContain(forbidden);
    }
    expect(documented.sort()).toEqual(['/health', '/ready']);
  });
});
