import type { Express } from 'express';
import type { EnvironmentRecord } from '../../src/app/configuration/index.js';
import { createEtbzRuntime } from '../../src/app/server.js';

/**
 * Builds an app from an EXPLICIT environment record.
 *
 * No test ever mutates `process.env`: the configuration boundary is a pure
 * function, so every scenario - including the invalid ones - is expressed as
 * data. This is also what proves the "no implicit host filesystem
 * configuration" requirement at the test level.
 */

export const VALID_ENVIRONMENT: EnvironmentRecord = Object.freeze({
  ETBZ_ENV: 'test',
  ETBZ_PORT: '8120',
  LOG_LEVEL: 'info',
});

export interface TestApp {
  readonly app: Express;
  readonly logLines: readonly string[];
}

export function createTestApp(environment: EnvironmentRecord): TestApp {
  const logLines: string[] = [];
  let counter = 0;
  const runtime = createEtbzRuntime(environment, {
    logSink: (line) => logLines.push(line),
    clock: () => '2026-01-01T00:00:00.000Z',
    generateCorrelationId: () => `test-correlation-${(counter += 1)}`,
  });
  return { app: runtime.app, logLines };
}
