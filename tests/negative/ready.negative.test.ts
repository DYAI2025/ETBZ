import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, VALID_ENVIRONMENT } from '../support/testRuntime.js';

/** Capabilities ETBZ-9 must never claim readiness for. */
const FORBIDDEN_CAPABILITY_TERMS = [
  'fufire',
  'etsy',
  'database',
  'sqlite',
  'postgres',
  'pdf',
  'weasyprint',
  'chromium',
  'delivery',
  'webhook',
  'receipt',
  'order',
  'bazi',
  'render',
  'gelato',
  'nginx',
  'queue',
  'job',
  'idempotency',
];

/**
 * A secret-SHAPED value, assembled at runtime from inert fragments.
 *
 * Written this way on purpose: a static high-entropy literal next to a
 * `SECRET`-ish identifier is exactly what the repository secret scanner is
 * built to flag, and a test fixture must not force an allowlist entry that
 * would weaken that scanner for real code.
 */
const SECRET_LOOKING_VALUE = ['sk', 'live', 'must', 'never', 'be', 'echoed'].join('-');

describe('AC3 negative: /ready fails closed on missing configuration', () => {
  it('answers 503 when ETBZ_ENV is missing', async () => {
    const { app } = createTestApp({ LOG_LEVEL: 'info' });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      capabilities: [{ name: 'configuration', status: 'fail' }],
    });
  });

  it('answers 503 when LOG_LEVEL is missing', async () => {
    const { app } = createTestApp({ ETBZ_ENV: 'test' });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
  });

  it('answers 503 when ETBZ_ENV is malformed', async () => {
    const { app } = createTestApp({ ETBZ_ENV: 'prod', LOG_LEVEL: 'info' });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
  });

  it('answers 503 for a completely empty environment', async () => {
    const { app } = createTestApp({});

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
  });
});

describe('AC3 negative: /ready claims no capability ETBZ-9 does not have', () => {
  it('mentions no out-of-scope dependency in the ready response', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const serialised = JSON.stringify((await request(app).get('/ready')).body).toLowerCase();

    for (const term of FORBIDDEN_CAPABILITY_TERMS) {
      expect(serialised, `/ready must not claim "${term}"`).not.toContain(term);
    }
  });

  it('mentions no out-of-scope dependency in the not-ready response', async () => {
    const { app } = createTestApp({});

    const serialised = JSON.stringify((await request(app).get('/ready')).body).toLowerCase();

    for (const term of FORBIDDEN_CAPABILITY_TERMS) {
      expect(serialised, `/ready must not claim "${term}"`).not.toContain(term);
    }
  });

  it('lists exactly the `configuration` capability in both states', async () => {
    const ready = createTestApp(VALID_ENVIRONMENT);
    const notReady = createTestApp({});

    const readyBody = (await request(ready.app).get('/ready')).body as {
      capabilities: { name: string }[];
    };
    const notReadyBody = (await request(notReady.app).get('/ready')).body as {
      capabilities: { name: string }[];
    };

    expect(readyBody.capabilities.map((c) => c.name)).toEqual(['configuration']);
    expect(notReadyBody.capabilities.map((c) => c.name)).toEqual(['configuration']);
  });
});

describe('AC3 negative: /ready never emits a configuration value', () => {
  it('does not echo a secret-looking invalid value', async () => {
    const { app } = createTestApp({
      ETBZ_ENV: SECRET_LOOKING_VALUE,
      LOG_LEVEL: SECRET_LOOKING_VALUE,
      ETBZ_PORT: SECRET_LOOKING_VALUE,
    });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain(SECRET_LOOKING_VALUE);
    expect(response.text).not.toContain(SECRET_LOOKING_VALUE);
  });

  it('does not echo a VALID configuration value', async () => {
    const { app } = createTestApp({
      ETBZ_ENV: 'staging',
      LOG_LEVEL: 'warn',
      ETBZ_PORT: '54321',
    });

    const response = await request(app).get('/ready');

    expect(response.text).not.toContain('54321');
    expect(response.text).not.toContain('staging');
  });

  it('does not echo an unrelated secret-bearing environment variable', async () => {
    const { app } = createTestApp({
      LOG_LEVEL: 'info',
      ETBZ_FUFIRE_API_KEY: SECRET_LOOKING_VALUE,
      DATABASE_PASSWORD: SECRET_LOOKING_VALUE,
    });

    const response = await request(app).get('/ready');

    expect(response.text).not.toContain(SECRET_LOOKING_VALUE);
  });
});

describe('AC5 negative: no configuration value reaches the log stream', () => {
  it('logs the invalid-configuration path without values', async () => {
    const { app, logLines } = createTestApp({
      ETBZ_ENV: SECRET_LOOKING_VALUE,
      LOG_LEVEL: 'info',
    });

    await request(app).get('/ready');

    const joined = logLines.join('\n');
    expect(joined).not.toContain(SECRET_LOOKING_VALUE);
    for (const line of logLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});
