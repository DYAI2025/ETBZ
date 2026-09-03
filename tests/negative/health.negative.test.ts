import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, VALID_ENVIRONMENT } from '../support/testRuntime.js';

/**
 * Terms that would constitute a dependency or production-readiness claim.
 * `/health` is liveness only and must never imply any of them.
 */
const FORBIDDEN_CLAIM_TERMS = [
  'fufire',
  'etsy',
  'database',
  'db',
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
  'production',
  'ready',
  'healthy',
  'degraded',
  'dependencies',
  'checks',
  'uptime',
  'version',
];

describe('AC3 negative: /health claims nothing beyond liveness', () => {
  it('returns no field other than `status`', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/health');

    expect(Object.keys(response.body as object)).toEqual(['status']);
    expect((response.body as { status: string }).status).toBe('alive');
  });

  it('mentions no dependency or production-readiness term', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/health');
    const serialised = JSON.stringify(response.body).toLowerCase();

    for (const term of FORBIDDEN_CLAIM_TERMS) {
      expect(serialised, `/health must not mention "${term}"`).not.toContain(term);
    }
  });

  it('makes the same minimal claim when the configuration is invalid', async () => {
    const { app } = createTestApp({});

    const response = await request(app).get('/health');
    const serialised = JSON.stringify(response.body).toLowerCase();

    expect(response.body).toEqual({ status: 'alive' });
    for (const term of FORBIDDEN_CLAIM_TERMS) {
      expect(serialised).not.toContain(term);
    }
  });

  it('does not turn liveness into readiness: 200 while /ready is 503', async () => {
    const { app } = createTestApp({ LOG_LEVEL: 'info' });

    const health = await request(app).get('/health');
    const ready = await request(app).get('/ready');

    expect(health.status).toBe(200);
    expect(ready.status).toBe(503);
  });

  it('rejects non-GET methods on the liveness path', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).post('/health');

    expect(response.status).toBe(404);
  });
});
