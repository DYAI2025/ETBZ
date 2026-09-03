import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** AC4 - the declared architecture boundaries must physically exist. */

const REQUIRED_DIRECTORIES = [
  'src/domain',
  'src/application',
  'src/application/ports',
  'src/adapters',
  'src/http',
  'contracts',
  'tests',
  'docs/adr',
] as const;

const REQUIRED_TEST_SUITES = [
  'tests/unit',
  'tests/integration',
  'tests/negative',
  'tests/contract',
  'tests/architecture',
] as const;

const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'Dockerfile',
  '.dockerignore',
  '.gitignore',
  '.editorconfig',
  '.env.example',
  'README.md',
  'openapi/etbz.openapi.yaml',
  'contracts/README.md',
  'src/domain/README.md',
  'src/application/README.md',
  'src/adapters/README.md',
  'scripts/ci-verify.sh',
  'scripts/verify-guards.sh',
  '.github/workflows/ci.yml',
] as const;

function isDirectory(relativePath: string): boolean {
  const absolute = resolve(process.cwd(), relativePath);
  return existsSync(absolute) && statSync(absolute).isDirectory();
}

describe('AC4 positive: required architecture boundaries exist', () => {
  it.each(REQUIRED_DIRECTORIES)('%s exists as a directory', (directory) => {
    expect(isDirectory(directory)).toBe(true);
  });

  it.each(REQUIRED_TEST_SUITES)('%s exists and contains at least one test', (suite) => {
    expect(isDirectory(suite)).toBe(true);
    const entries = readdirSync(resolve(process.cwd(), suite));
    expect(
      entries.filter((entry) => entry.endsWith('.test.ts')).length,
      `${suite} must not be an empty suite (no CI false green)`,
    ).toBeGreaterThan(0);
  });

  it.each(REQUIRED_FILES)('%s exists', (file) => {
    expect(existsSync(resolve(process.cwd(), file))).toBe(true);
  });

  it('documents at least four architecture decisions', () => {
    const adrs = readdirSync(resolve(process.cwd(), 'docs/adr')).filter((entry) =>
      /^\d{4}-.*\.md$/.test(entry),
    );
    expect(adrs.length).toBeGreaterThanOrEqual(4);
  });
});
