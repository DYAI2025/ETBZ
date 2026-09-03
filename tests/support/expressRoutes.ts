import type { Express } from 'express';

/**
 * Introspects the LIVE Express router.
 *
 * The contract guard must compare OpenAPI against what the application really
 * serves, not against the route registry alone - otherwise a route mounted
 * directly on the app would stay invisible.
 *
 * Two shapes must be recognised, and only one of them is obvious:
 *
 *  1. `app.get('/x', h)` / `router.get('/x', h)` - the layer carries `.route`;
 *  2. `app.use('/x', h)` - the layer carries NO `.route` and its handle has no
 *     `.stack`, so a walker that only looks for those two contributes nothing
 *     and the mounted surface disappears. `GET /x` is nevertheless served.
 *
 * Express 5 does not expose a layer's mount path statically (`layer.path` is
 * only populated during matching), but it does expose `layer.matchers`. A
 * PATHLESS `use` matches '/', a PATH-MOUNTED one does not - which is exactly
 * the discriminator needed to tell global middleware from a mounted surface.
 * Anything mounted at a path is reported, so it cannot pass unnoticed.
 */

export interface ObservedRoute {
  readonly method: string;
  readonly path: string;
}

/** Reported for a surface mounted with `app.use(path, ...)`. */
export const MOUNTED_SURFACE_METHOD = 'use';
/** Reported when a mount path exists but cannot be recovered statically. */
export const UNKNOWN_MOUNT_PATH = '<mounted-at-unknown-path>';

interface RouteLike {
  readonly path?: unknown;
  readonly methods?: Record<string, unknown>;
}

interface LayerLike {
  readonly route?: RouteLike;
  readonly name?: unknown;
  readonly handle?: { readonly stack?: unknown };
  readonly matchers?: unknown;
}

/** True when the layer is mounted without a path (ordinary global middleware). */
function isPathlessMount(layer: LayerLike): boolean {
  const matchers = layer.matchers;
  if (!Array.isArray(matchers) || matchers.length === 0) {
    // No matcher information: treat as pathless so that ordinary middleware is
    // not reported. Path-mounted layers always carry matchers in Express 5.
    return true;
  }
  try {
    return matchers.some((matcher) =>
      typeof matcher === 'function' ? Boolean((matcher as (p: string) => unknown)('/')) : true,
    );
  } catch {
    return false;
  }
}

function walk(stack: unknown, collected: ObservedRoute[]): ObservedRoute[] {
  if (!Array.isArray(stack)) {
    return collected;
  }
  for (const rawLayer of stack) {
    const layer = rawLayer as LayerLike;

    if (layer.route !== undefined && layer.route !== null) {
      const path = typeof layer.route.path === 'string' ? layer.route.path : '';
      const methods = Object.entries(layer.route.methods ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([method]) => method.toLowerCase());
      for (const method of methods) {
        collected.push({ method, path });
      }
      continue;
    }

    const nestedStack = layer.handle?.stack;
    const pathless = isPathlessMount(layer);

    if (Array.isArray(nestedStack)) {
      if (!pathless) {
        // A router mounted under a prefix. Report the mount itself so the
        // prefix cannot vanish, then descend for the routes underneath.
        collected.push({ method: MOUNTED_SURFACE_METHOD, path: UNKNOWN_MOUNT_PATH });
      }
      walk(nestedStack, collected);
      continue;
    }

    if (!pathless) {
      // A plain handler mounted at a path: a served surface with no `.route`.
      collected.push({ method: MOUNTED_SURFACE_METHOD, path: UNKNOWN_MOUNT_PATH });
    }
  }
  return collected;
}

/** Every (method, path) pair the application actually serves. */
export function listServedRoutes(app: Express): ObservedRoute[] {
  const router = (app as unknown as { router?: { stack?: unknown } }).router;
  const routes = walk(router?.stack, []);
  return routes.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
}

export function routeKey(route: ObservedRoute): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
