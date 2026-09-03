import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, VALID_ENVIRONMENT } from '../support/testRuntime.js';

describe('AC3 positive: GET /health is liveness only', () => {
  it('answers 200 with exactly {"status":"alive"}', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'alive' });
    expect(Object.keys(response.body as object)).toEqual(['status']);
  });

  it('still answers 200 while the configuration is INVALID', async () => {
    // Liveness must not depend on configuration: a misconfigured container has
    // to stay observable rather than be restarted in a loop by a liveness probe.
    const { app } = createTestApp({ LOG_LEVEL: 'info' });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'alive' });
  });

  it('answers 200 with a completely empty environment', async () => {
    const { app } = createTestApp({});

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'alive' });
  });
});

describe('AC5 positive: correlation id propagation', () => {
  it('reuses a safe inbound correlation id', async () => {
    const { app, logLines } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app)
      .get('/health')
      .set('x-correlation-id', 'inbound-correlation-1234');

    expect(response.headers['x-correlation-id']).toBe('inbound-correlation-1234');
    const record = JSON.parse(logLines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(record['correlationId']).toBe('inbound-correlation-1234');
    expect(record['route']).toBe('/health');
    expect(record['status']).toBe(200);
  });

  it('generates a correlation id when none is supplied', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/health');

    expect(response.headers['x-correlation-id']).toBe('test-correlation-1');
  });

  it('accepts x-request-id as a fallback source', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app)
      .get('/health')
      .set('x-request-id', 'request-id-abcdefgh');

    expect(response.headers['x-correlation-id']).toBe('request-id-abcdefgh');
  });
});
