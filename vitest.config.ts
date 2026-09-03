import { defineConfig } from 'vitest/config';

/**
 * ETBZ-9 test contract.
 *
 * Every suite directory is a distinct verification obligation and is listed
 * explicitly so that a silently-empty run is impossible: `scripts/ci-verify.sh`
 * asserts a minimum executed-test count against the JSON reporter output.
 */
export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/negative/**/*.test.ts',
      'tests/contract/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    passWithNoTests: false,
    reporters: ['default'],
  },
});
