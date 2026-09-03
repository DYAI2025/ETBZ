import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { BuildInfo } from './buildInfo.js';
import { resolveBuildInfo } from './buildInfo.js';
import type { ConfigLoadResult, EnvironmentRecord } from './configuration/index.js';
import {
  loadEtbzConfig,
  resolveBootstrapLogLevel,
  resolveBootstrapPort,
} from './configuration/index.js';
import type { Logger } from './logging/index.js';
import { createLogger } from './logging/index.js';
import { evaluateReadiness } from './readiness/index.js';
import { createEtbzApp } from '../http/app.js';

/**
 * Composition root.
 *
 * This is the ONLY place where environment, clock, randomness and the HTTP
 * driver are wired together. Everything below it is injected, which is why the
 * whole foundation is testable without touching `process.env`.
 *
 * Bootstrap is deliberately tolerant while readiness is strict: an invalid
 * configuration still produces a running listener that answers `/health` 200
 * and `/ready` 503, instead of an exited container that reports nothing.
 */

export const DEFAULT_BIND_HOST = '0.0.0.0';

export interface EtbzRuntime {
  readonly app: Express;
  readonly configResult: ConfigLoadResult;
  readonly logger: Logger;
  readonly port: number;
  readonly buildInfo: BuildInfo;
}

export interface RuntimeOverrides {
  readonly logSink?: (line: string) => void;
  readonly clock?: () => string;
  readonly generateCorrelationId?: () => string;
}

export function createEtbzRuntime(
  environment: EnvironmentRecord,
  overrides: RuntimeOverrides = {},
): EtbzRuntime {
  const configResult = loadEtbzConfig(environment);
  const buildInfo = resolveBuildInfo(environment);

  const logger = createLogger({
    level: configResult.ok
      ? configResult.config.logLevel
      : resolveBootstrapLogLevel(environment),
    ...(overrides.logSink !== undefined ? { sink: overrides.logSink } : {}),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    base: {
      service: 'etbz',
      buildRevision: buildInfo.revision,
      buildVersion: buildInfo.version,
    },
  });

  const app = createEtbzApp({
    evaluateReadiness: () => evaluateReadiness(loadEtbzConfig(environment)),
    logger,
    generateCorrelationId: overrides.generateCorrelationId ?? (() => randomUUID()),
  });

  return {
    app,
    configResult,
    logger,
    port: configResult.ok ? configResult.config.port : resolveBootstrapPort(environment),
    buildInfo,
  };
}

export interface RunningEtbzServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startEtbzServer(
  environment: EnvironmentRecord,
  overrides: RuntimeOverrides = {},
): Promise<RunningEtbzServer> {
  const runtime = createEtbzRuntime(environment, overrides);

  if (!runtime.configResult.ok) {
    runtime.logger.warn('etbz_configuration_invalid', {
      // Variable names and static expectations only - never values.
      issues: runtime.configResult.issues,
    });
  }

  // The HTTP server is created explicitly rather than via `app.listen(...)`.
  //
  // Express's `app.listen` registers the trailing callback as an ERROR handler
  // as well as the listening handler (`server.once('error', done)` in
  // express/lib/application.js). A callback that ignores its argument therefore
  // treats a FAILED BIND as success: the promise resolves, a later
  // `once('error')` lands on an already-settled promise and is a no-op, and the
  // process reports a server it does not own. `listening` and `error` are bound
  // separately here so a bind failure propagates as a rejection.
  const server: Server = await new Promise<Server>((resolve, reject) => {
    const listener = createServer(runtime.app);

    const onListening = (): void => {
      listener.removeListener('error', onError);
      resolve(listener);
    };
    function onError(error: Error): void {
      listener.removeListener('listening', onListening);
      reject(error);
    }

    listener.once('listening', onListening);
    listener.once('error', onError);
    listener.listen(runtime.port, DEFAULT_BIND_HOST);
  });

  // A post-bind error (for example the listener being closed underneath us)
  // would otherwise be an unhandled 'error' event and terminate the process
  // without a record. It is logged instead.
  server.on('error', (error: Error) => {
    runtime.logger.error('etbz_server_error', { error });
  });

  runtime.logger.info('etbz_server_started', {
    port: runtime.port,
    host: DEFAULT_BIND_HOST,
    readiness: runtime.configResult.ok ? 'ready' : 'not_ready',
  });

  return {
    port: runtime.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
