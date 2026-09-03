import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '../../src/http/routes/index.js';
import { listServedRoutes } from '../support/expressRoutes.js';
import { createTestApp, VALID_ENVIRONMENT } from '../support/testRuntime.js';

/**
 * AC4 / AC8 - no premature business surface.
 *
 * ETBZ-9 is a foundation. Any business route, business schema or out-of-scope
 * runtime dependency appearing here would assert a capability the service does
 * not have.
 *
 * Route detection targets actual REGISTRATION sites
 * (`app.get('/orders', ...)`), not string occurrences, so documentation that
 * merely names a forbidden path - as the route registry's own comment does -
 * cannot produce a false positive, while a real mutation still fails.
 */

const SRC_ROOT = resolve(process.cwd(), 'src');

const FORBIDDEN_ROUTE_PATHS = [
  '/orders',
  '/order',
  '/webhook',
  '/webhooks',
  '/render',
  '/bazi',
  '/receipt',
  '/receipts',
  '/delivery',
  '/pdf',
  '/jobs',
  '/etsy',
  '/fufire',
];

const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  'sqlite3',
  'better-sqlite3',
  'pg',
  'mysql2',
  'mongodb',
  'redis',
  'ioredis',
  'puppeteer',
  'playwright',
  'weasyprint',
  'pdfkit',
  'puppeteer-core',
  'bullmq',
  'nodemailer',
  'stripe',
  'etsy',
];

// `use` is included deliberately: `app.use('/orders', handler)` really serves
// GET/POST/... /orders and /orders/*, but carries no `.route` in the Express
// stack, so a matcher that omits `use` leaves that surface undetected. A
// pathless `app.use(middleware())` has no string first argument and therefore
// does not match.
const ROUTE_REGISTRATION_PATTERN =
  /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|all|head|options|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;

function listTypeScriptFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const entryPath = join(current, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
      } else if (entry.endsWith('.ts')) {
        found.push(entryPath);
      }
    }
  };
  walk(root);
  return found;
}

interface RegisteredRoute {
  readonly file: string;
  readonly method: string;
  readonly path: string;
}

function findRegisteredRoutes(): RegisteredRoute[] {
  const registered: RegisteredRoute[] = [];
  for (const file of listTypeScriptFiles(SRC_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(ROUTE_REGISTRATION_PATTERN)) {
      const method = match[1];
      const path = match[2];
      if (method !== undefined && path !== undefined) {
        registered.push({ file: relative(process.cwd(), file), method, path });
      }
    }
  }
  return registered;
}

describe('AC4 negative: no business HTTP surface exists in ETBZ-9', () => {
  it('serves no forbidden business route', () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);
    const servedPaths = listServedRoutes(app).map((route) => route.path);

    for (const forbidden of FORBIDDEN_ROUTE_PATHS) {
      expect(servedPaths, `route ${forbidden} must not be served`).not.toContain(forbidden);
    }
    expect(servedPaths.sort()).toEqual(['/health', '/ready']);
  });

  it('declares no forbidden route in the public route registry', () => {
    const registryPaths = PUBLIC_ROUTES.map((route) => route.path);

    expect([...registryPaths].sort()).toEqual(['/health', '/ready']);
    for (const forbidden of FORBIDDEN_ROUTE_PATHS) {
      expect(registryPaths).not.toContain(forbidden);
    }
  });

  it('registers no forbidden route anywhere under src/', () => {
    const offending = findRegisteredRoutes().filter((route) =>
      FORBIDDEN_ROUTE_PATHS.some(
        (forbidden) => route.path === forbidden || route.path.startsWith(`${forbidden}/`),
      ),
    );

    expect(
      offending,
      `business routes registered in src/:\n${offending
        .map((route) => `  ${route.file}: ${route.method.toUpperCase()} ${route.path}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it.each([
    ["app.get('/orders', createOrderHandler());", '/orders'],
    ["app.use('/orders', createOrderHandler());", '/orders'],
    ["router.post('/webhook', handler);", '/webhook'],
    ['app.use("/render", handler);', '/render'],
  ])('detects the forbidden registration in %s (guard self-check)', (synthetic, expected) => {
    // Guards against a vacuously-green pattern: the same matcher applied to a
    // synthetic mutation must find it.
    const matches = [...synthetic.matchAll(ROUTE_REGISTRATION_PATTERN)].map(
      (match) => match[2],
    );

    expect(matches).toEqual([expected]);
  });

  it('does not match a pathless middleware registration', () => {
    const legitimate = 'app.use(createNotFoundHandler());';

    expect([...legitimate.matchAll(ROUTE_REGISTRATION_PATTERN)]).toEqual([]);
  });
});

describe('AC4 negative: forbidden business paths are not served (behavioural probe)', () => {
  // This probe does not introspect anything: it asks the running application.
  // It therefore holds regardless of HOW a route might have been mounted, and
  // is the backstop for any future gap in stack introspection.
  it.each(FORBIDDEN_ROUTE_PATHS)('GET %s is not served', async (path) => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get(path);

    expect(response.status).toBe(404);
  });

  it('serves no forbidden path under any method, including sub-paths', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    for (const path of ['/orders', '/orders/123', '/webhook', '/render', '/bazi']) {
      for (const method of ['get', 'post', 'put', 'delete'] as const) {
        const response = await request(app)[method](path);
        expect(
          response.status,
          `${method.toUpperCase()} ${path} must not be served`,
        ).toBe(404);
      }
    }
  });
});

describe('AC4 negative: contracts/ carries no business schema in ETBZ-9', () => {
  it('contains nothing but the boundary README', () => {
    const entries = readdirSync(resolve(process.cwd(), 'contracts'));

    expect(entries.sort()).toEqual(['README.md']);
  });

  it('contains no schema file of any kind', () => {
    const entries = readdirSync(resolve(process.cwd(), 'contracts'));
    const schemaLike = entries.filter((entry) =>
      /\.(json|ya?ml|ts|js|proto|avsc|graphql)$/i.test(entry),
    );

    expect(
      schemaLike,
      'ETBZ-9 must not declare business contracts; they arrive with their slice',
    ).toEqual([]);
  });
});

describe('AC8 negative: no out-of-scope dependency is installed', () => {
  it('declares no forbidden runtime or dev dependency', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];

    for (const forbidden of FORBIDDEN_RUNTIME_DEPENDENCIES) {
      expect(declared, `${forbidden} is out of scope for ETBZ-9`).not.toContain(forbidden);
    }
  });

  it('keeps the production dependency set minimal', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['express', 'zod']);
  });
});
