import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, isSecretKey, redact } from '../../src/app/logging/index.js';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('AC5 positive: structured JSON logging', () => {
  it('emits one parseable JSON object per record with the expected envelope', () => {
    const { lines, sink } = capture();
    const logger = createLogger({
      level: 'info',
      sink,
      clock: () => '2026-01-01T00:00:00.000Z',
    });

    logger.info('foundation_event', { correlationId: 'abc-123-def', route: '/health' });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'foundation_event',
      correlationId: 'abc-123-def',
      route: '/health',
    });
  });

  it('carries the correlation id through child loggers', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', sink, clock: () => 'T' }).child({
      correlationId: 'corr-0001',
    });

    logger.debug('one');
    logger.error('two', { extra: 1 });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.every((record) => record['correlationId'] === 'corr-0001')).toBe(true);
  });

  it('honours the configured level threshold', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'warn', sink, clock: () => 'T' });

    logger.debug('dropped');
    logger.info('dropped');
    logger.warn('kept');
    logger.error('kept');

    expect(lines).toHaveLength(2);
  });

  it('cannot be crashed by cyclic or unserialisable payloads', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', sink, clock: () => 'T' });
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic['self'] = cyclic;

    expect(() => logger.info('cyclic', { cyclic, fn: () => undefined })).not.toThrow();
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ msg: 'cyclic' });
  });
});

describe('AC5 negative: redaction', () => {
  it('redacts credential-shaped field names regardless of value', () => {
    const output = redact({
      password: 'hunter2',
      apiKey: 'plain-looking',
      AUTHORIZATION: 'Basic dXNlcjpwYXNz',
      client_secret: 'x',
      nested: { sessionId: 'sid', privateKey: 'pk' },
      safeField: 'visible',
    }) as Record<string, unknown>;

    expect(output['password']).toBe(REDACTED);
    expect(output['apiKey']).toBe(REDACTED);
    expect(output['AUTHORIZATION']).toBe(REDACTED);
    expect(output['client_secret']).toBe(REDACTED);
    expect(output['nested']).toEqual({ sessionId: REDACTED, privateKey: REDACTED });
    expect(output['safeField']).toBe('visible');
  });

  it('redacts credential-shaped VALUES even under an innocuous field name', () => {
    // Assembled at runtime: a committed literal of this shape would be a
    // finding for the repository secret scanner, and a test must not be the
    // reason an allowlist entry weakens that scanner.
    const awsShaped = `AKIA${'IOSFODNN7EXAMPL1'}`;
    const patShaped = `gh${'p'}_0123456789abcdefghijklmnopqrstuvwx`;
    const pemShaped = `-----BEGIN ${'RSA'} PRIVATE KEY-----`;
    const output = redact({
      note: awsShaped,
      other: patShaped,
      blob: pemShaped,
    }) as Record<string, unknown>;

    expect(output['note']).toBe(REDACTED);
    expect(output['other']).toBe(REDACTED);
    expect(output['blob']).toBe(REDACTED);
  });

  it('never lets a redacted value reach the emitted log line', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', sink, clock: () => 'T' });

    const tokenShaped = `gh${'p'}_secretvalue`;
    logger.info('attempt', { password: 'hunter2', token: tokenShaped });

    const line = lines[0] ?? '';
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain(tokenShaped);
    expect(line).toContain(REDACTED);
  });

  it('refuses to let payload fields overwrite the log envelope', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', sink, clock: () => 'REAL-TS' });

    logger.info('real message', { ts: 'FAKE-TS', level: 'debug', msg: 'spoofed' });

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      ts: 'REAL-TS',
      level: 'info',
      msg: 'real message',
    });
  });

  it('classifies key names deterministically', () => {
    expect(isSecretKey('accessKey')).toBe(true);
    expect(isSecretKey('X-Api-Key')).toBe(true);
    expect(isSecretKey('route')).toBe(false);
    expect(isSecretKey('status')).toBe(false);
  });
});
