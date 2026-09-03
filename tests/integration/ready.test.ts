import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, VALID_ENVIRONMENT } from '../support/testRuntime.js';

describe('AC3 positive: GET /ready reflects the configuration capability', () => {
  it('answers 200 for a valid foundation configuration', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      capabilities: [{ name: 'configuration', status: 'ok' }],
    });
  });

  it('answers 200 when only the optional ETBZ_PORT is omitted', async () => {
    const { app } = createTestApp({ ETBZ_ENV: 'local', LOG_LEVEL: 'debug' });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready' });
  });

  it('reports exactly one capability', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/ready');
    const body = response.body as { capabilities: unknown[] };

    expect(body.capabilities).toHaveLength(1);
  });
});

describe('foundation 404 handling', () => {
  it('returns a constant, non-reflective 404 body', async () => {
    const { app } = createTestApp(VALID_ENVIRONMENT);

    const response = await request(app).get('/does-not-exist-<script>');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { code: 'not_found', message: 'Resource not found.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('script');
  });
});
