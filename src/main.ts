import { startEtbzServer } from './app/server.js';

/**
 * Process entrypoint.
 *
 * Kept separate from `app/server.ts` so that importing the composition root in
 * tests never binds a socket. `process.env` is read exactly once, here, and
 * passed down explicitly - the configuration layer itself stays pure.
 */
async function main(): Promise<void> {
  const server = await startEtbzServer(process.env);

  const shutdown = (signal: NodeJS.Signals): void => {
    void server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'etbz_shutdown_signal', signal })}\n`,
    );
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'etbz_bootstrap_failed',
      error: error instanceof Error ? { name: error.name, message: error.message } : 'unknown_error',
    })}\n`,
  );
  process.exit(1);
});
