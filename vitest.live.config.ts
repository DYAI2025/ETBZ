import { defineConfig } from 'vitest/config';

/**
 * ETBZ-25B — the LIVE provider harness, deliberately kept OUT of the CI gate.
 *
 * `vitest.config.ts` enumerates the five suite directories that constitute the
 * verification contract, and `tests/live` is not among them. That is the whole
 * point: the CI gate must be reproducible from source alone, and a suite that
 * needs a network, a credential and a third-party's availability is none of
 * those things. A red live run would then mean "a provider had a bad minute",
 * which is not information about the commit.
 *
 * So the live harness gets its own config and its own command
 * (`npm run golden-reading`). It is still TYPECHECKED and LINTED with everything
 * else — `tsconfig.json` includes `tests/**` — so it cannot rot quietly while
 * being excluded from the gate.
 *
 * The evidence a live run produces is bound to an exact candidate SHA and is
 * reviewed as evidence, never as a passing gate.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    globals: false,
    passWithNoTests: false,
    // A real reasoning model over a long prompt needs minutes, not seconds. An
    // implicit 5s timeout here would report a provider's latency as a failure
    // of the reading — and a timed-out test still logs, so the numbers would
    // look real while being stale.
    //
    // This deadline is deliberately FAR ABOVE the route deadline the harness
    // passes to `buildLlmRoutePlan`. When the two are equal the runner's timeout
    // wins the race, the test is reported as timed out, and the adapter's own
    // abort — the thing under test, and the thing that would have produced a
    // clean `LLM_TIMEOUT` attempt record — never gets to fire. Measured: with
    // both at ten minutes, a run reported "Test timed out" and left the request
    // in flight for hours. The runner must be the outer bound, never the
    // deciding one.
    testTimeout: 2_400_000,
    hookTimeout: 2_400_000,
    reporters: ['default'],
  },
});
