import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startEtbzServer } from '../../src/app/server.js';
import type { RunningEtbzServer } from '../../src/app/server.js';

/**
 * Bind-path coverage.
 *
 * The rest of the suite drives `createEtbzApp` in-process through supertest and
 * therefore never binds a socket. That gap is precisely how a swallowed bind
 * failure can pass a fully green test run, so these tests exercise the real
 * listener.
 */

const started: RunningEtbzServer[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const server = started.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
});

/** Reserves a port by holding it, so a collision is deterministic. */
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

async function freePort(): Promise<number> {
  const held = await occupyPort();
  await held.release();
  return held.port;
}

describe('AC1 positive: the server actually binds and serves', () => {
  it('starts, answers /health over a real socket, and closes', async () => {
    const port = await freePort();
    const logLines: string[] = [];

    const server = await startEtbzServer(
      { ETBZ_ENV: 'test', LOG_LEVEL: 'info', ETBZ_PORT: String(port) },
      { logSink: (line) => logLines.push(line) },
    );
    started.push(server);

    expect(server.port).toBe(port);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'alive' });

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);

    expect(logLines.some((line) => line.includes('etbz_server_started'))).toBe(true);
  });

  it('serves /health 200 and /ready 503 over a real socket with invalid config', async () => {
    const port = await freePort();

    const server = await startEtbzServer(
      { LOG_LEVEL: 'info', ETBZ_PORT: String(port) },
      { logSink: () => undefined },
    );
    started.push(server);

    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
  });
});
