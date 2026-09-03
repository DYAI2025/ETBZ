import { describe, expect, it } from 'vitest';
import { loadEtbzConfig } from '../../src/app/configuration/index.js';

/** A value that must never appear in any result, error or log. */
const SENTINEL = 'sentinel-configuration-value-must-not-leak';

describe('AC2 negative: ETBZ_ENV fails closed', () => {
  it('fails when ETBZ_ENV is missing entirely', () => {
    const result = loadEtbzConfig({ LOG_LEVEL: 'info' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ variable: 'ETBZ_ENV', code: 'missing' }),
    );
  });

  it('fails when ETBZ_ENV is present but blank', () => {
    for (const blank of ['', '   ', '\t']) {
      const result = loadEtbzConfig({ ETBZ_ENV: blank, LOG_LEVEL: 'info' });
      expect(result.ok, `blank value ${JSON.stringify(blank)} must fail`).toBe(false);
    }
  });

  it('fails when ETBZ_ENV is malformed', () => {
    const result = loadEtbzConfig({ ETBZ_ENV: 'prod-ish', LOG_LEVEL: 'info' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ variable: 'ETBZ_ENV', code: 'invalid' }),
    );
  });

  it('never defaults ETBZ_ENV - least of all to production', () => {
    const result = loadEtbzConfig({ LOG_LEVEL: 'info', ETBZ_PORT: '8120' });

    // The assertion is on the RESOLVED shape, not on substring presence: the
    // allowed-value list legitimately names `production`, and asserting that
    // the word is absent would only test the documentation string. What must
    // never happen is that a value is resolved at all.
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('config');
    expect(JSON.stringify(result)).not.toContain('"env"');
  });

  it('resolves no environment for any input that omits ETBZ_ENV', () => {
    for (const environment of [
      {},
      { LOG_LEVEL: 'info' },
      { LOG_LEVEL: 'info', ETBZ_PORT: '8120' },
      { LOG_LEVEL: 'info', NODE_ENV: 'production' },
      { LOG_LEVEL: 'info', ETBZ_ENV: '' },
    ]) {
      const result = loadEtbzConfig(environment);
      expect(result.ok, `${JSON.stringify(environment)} must not resolve`).toBe(false);
      expect(result).not.toHaveProperty('config');
    }
  });

  it('fails when LOG_LEVEL is missing or malformed', () => {
    expect(loadEtbzConfig({ ETBZ_ENV: 'test' }).ok).toBe(false);
    expect(loadEtbzConfig({ ETBZ_ENV: 'test', LOG_LEVEL: 'verbose' }).ok).toBe(false);
  });

  it('fails when ETBZ_PORT is malformed', () => {
    for (const port of ['abc', '-1', '0', '70000', '80.5', '8120; rm -rf /']) {
      const result = loadEtbzConfig({ ETBZ_ENV: 'test', LOG_LEVEL: 'info', ETBZ_PORT: port });
      expect(result.ok, `port ${port} must be rejected`).toBe(false);
    }
  });
});

describe('AC2 negative: configuration values must not leak', () => {
  it('does not echo the received value of an invalid ETBZ_ENV', () => {
    const result = loadEtbzConfig({ ETBZ_ENV: SENTINEL, LOG_LEVEL: 'info' });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('does not echo the received value of an invalid ETBZ_PORT or LOG_LEVEL', () => {
    const portResult = loadEtbzConfig({
      ETBZ_ENV: 'test',
      LOG_LEVEL: 'info',
      ETBZ_PORT: SENTINEL,
    });
    const levelResult = loadEtbzConfig({ ETBZ_ENV: 'test', LOG_LEVEL: SENTINEL });

    expect(JSON.stringify(portResult)).not.toContain(SENTINEL);
    expect(JSON.stringify(levelResult)).not.toContain(SENTINEL);
  });

  it('does not echo a valid configuration value into an unrelated issue', () => {
    // ETBZ_PORT is valid here; the failure is on ETBZ_ENV. The port value must
    // still not appear anywhere in the issue set.
    const result = loadEtbzConfig({ LOG_LEVEL: 'info', ETBZ_PORT: '54321' });

    expect(JSON.stringify(result)).not.toContain('54321');
  });
});

describe('AC2 negative: unknown variables cannot mutate EtbzConfig', () => {
  it('produces a byte-identical config when unknown variables are added', () => {
    const base = { ETBZ_ENV: 'test', LOG_LEVEL: 'info', ETBZ_PORT: '8120' };
    const polluted = {
      ...base,
      ETBZ_UNKNOWN: 'value',
      ETBZ_ENVIRONMENT: 'production',
      etbz_env: 'production',
      ETBZ_PORT_OVERRIDE: '1',
      NODE_ENV: 'production',
      PORT: '9999',
      ETBZ_FUFIRE_BASE_URL: 'http://example.invalid',
      ETBZ_DATABASE_URL: 'postgres://example.invalid/db',
    };

    expect(JSON.stringify(loadEtbzConfig(polluted))).toBe(
      JSON.stringify(loadEtbzConfig(base)),
    );
  });

  it('cannot be satisfied by a future-slice variable alone', () => {
    // Names documented in .env.example for later slices must not be able to
    // stand in for a mandatory ETBZ-9 variable.
    const result = loadEtbzConfig({
      LOG_LEVEL: 'info',
      ETBZ_FUFIRE_BASE_URL: 'http://example.invalid',
      ETBZ_ETSY_SHOP_ID: '1',
      ETBZ_DELIVERY_MODE: 'auto',
    });

    expect(result.ok).toBe(false);
  });

  it('ignores a prototype-polluting environment key', () => {
    const hostile = JSON.parse(
      '{"ETBZ_ENV":"test","LOG_LEVEL":"info","__proto__":{"port":31337}}',
    ) as Record<string, string | undefined>;

    const result = loadEtbzConfig(hostile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.port).toBe(8120);
  });
});

describe('AC2 negative: no implicit host filesystem configuration', () => {
  it('is unaffected by process.env - only the supplied record is read', () => {
    const result = loadEtbzConfig({});

    expect(result.ok).toBe(false);
    // Even though the test process has a populated process.env, the loader saw
    // an empty record and failed closed.
    expect(Object.keys(process.env).length).toBeGreaterThan(0);
  });
});
