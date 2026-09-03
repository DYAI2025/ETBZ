import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startEtbzServer } from '../../src/app/server.js';

/**
 * AC1 negative - a FAILED BIND MUST FAIL.
 *
 * Regression guard for a defect that a fully green suite did not catch:
 * `app.listen(port, host, cb)` registers `cb` as an error handler too, so a
 * callback that ignores its argument turns EADDRINUSE into a resolved promise,
 * a log line claiming the server started, and exit code 0 with nothing
 * listening. The composition root binds `listening` and `error` separately; the
 * assertions below are what keep it that way.
 */

async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '0.0.0.0', () => resolve());
  });
  const address = blocker.address() as AddressInfo;
  return {
    port: address.port,
    release: () =>
      new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe('AC1 negative: a bind failure is never reported as success', () => {
  it('rejects with EADDRINUSE instead of resolving', async () => {
    const held = await occupyPort();
    try {
      await expect(
        startEtbzServer(
          { ETBZ_ENV: 'test', LOG_LEVEL: 'error', ETBZ_PORT: String(held.port) },
          { logSink: () => undefined },
        ),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await held.release();
    }
  });

  it('never emits etbz_server_started when the bind failed', async () => {
    const held = await occupyPort();
    const logLines: string[] = [];
    try {
      await startEtbzServer(
        { ETBZ_ENV: 'test', LOG_LEVEL: 'debug', ETBZ_PORT: String(held.port) },
        { logSink: (line) => logLines.push(line) },
      ).catch(() => undefined);

      expect(
        logLines.some((line) => line.includes('etbz_server_started')),
        'a failed bind must not produce a started record',
      ).toBe(false);
    } finally {
      await held.release();
    }
  });

  it('does not leave a usable server handle behind', async () => {
    const held = await occupyPort();
    try {
      const result = await startEtbzServer(
        { ETBZ_ENV: 'test', LOG_LEVEL: 'error', ETBZ_PORT: String(held.port) },
        { logSink: () => undefined },
      ).then(
        (server) => ({ resolved: true as const, server }),
        (error: unknown) => ({ resolved: false as const, error }),
      );

      expect(result.resolved).toBe(false);
      if (result.resolved) {
        // Defensive: if the promise ever resolves again, do not leak the handle.
        await result.server.close();
      }
    } finally {
      await held.release();
    }
  });
});
