import { describe, expect, it } from 'vitest';
import {
  CONFIG_VARIABLE_NAMES,
  DEFAULT_ETBZ_PORT,
  loadEtbzConfig,
  resolveBootstrapLogLevel,
  resolveBootstrapPort,
} from '../../src/app/configuration/index.js';

describe('AC2 positive: configuration loads from an explicit environment record', () => {
  it('accepts a complete, valid foundation environment', () => {
    const result = loadEtbzConfig({
      ETBZ_ENV: 'staging',
      ETBZ_PORT: '9001',
      LOG_LEVEL: 'warn',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ env: 'staging', port: 9001, logLevel: 'warn' });
  });

  it('defaults ETBZ_PORT to 8120 when it is not supplied', () => {
    const result = loadEtbzConfig({ ETBZ_ENV: 'local', LOG_LEVEL: 'debug' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.port).toBe(DEFAULT_ETBZ_PORT);
    expect(DEFAULT_ETBZ_PORT).toBe(8120);
  });

  it('accepts every declared environment value explicitly', () => {
    for (const env of ['local', 'development', 'test', 'staging', 'production'] as const) {
      const result = loadEtbzConfig({ ETBZ_ENV: env, LOG_LEVEL: 'info' });
      expect(result.ok, `expected ${env} to be accepted`).toBe(true);
    }
  });

  it('trims surrounding whitespace before validating', () => {
    const result = loadEtbzConfig({
      ETBZ_ENV: '  test  ',
      LOG_LEVEL: ' error ',
      ETBZ_PORT: ' 8200 ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ env: 'test', port: 8200, logLevel: 'error' });
  });

  it('reads no environment variable outside the declared set', () => {
    expect([...CONFIG_VARIABLE_NAMES].sort()).toEqual([
      'ETBZ_ENV',
      'ETBZ_PORT',
      'LOG_LEVEL',
    ]);
  });

  it('is a pure function: identical input yields deeply equal output', () => {
    const environment = { ETBZ_ENV: 'test', LOG_LEVEL: 'info', ETBZ_PORT: '8120' };
    expect(loadEtbzConfig(environment)).toEqual(loadEtbzConfig(environment));
  });
});

describe('bootstrap resolution keeps liveness observable', () => {
  it('falls back to the default port when ETBZ_PORT is absent or malformed', () => {
    expect(resolveBootstrapPort({})).toBe(DEFAULT_ETBZ_PORT);
    expect(resolveBootstrapPort({ ETBZ_PORT: 'not-a-port' })).toBe(DEFAULT_ETBZ_PORT);
    expect(resolveBootstrapPort({ ETBZ_PORT: '0' })).toBe(DEFAULT_ETBZ_PORT);
    expect(resolveBootstrapPort({ ETBZ_PORT: '70000' })).toBe(DEFAULT_ETBZ_PORT);
    expect(resolveBootstrapPort({ ETBZ_PORT: '8300' })).toBe(8300);
  });

  it('falls back to a safe bootstrap log level', () => {
    expect(resolveBootstrapLogLevel({})).toBe('info');
    expect(resolveBootstrapLogLevel({ LOG_LEVEL: 'nonsense' })).toBe('info');
    expect(resolveBootstrapLogLevel({ LOG_LEVEL: 'error' })).toBe('error');
  });
});
