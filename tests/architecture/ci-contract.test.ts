import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * AC8 - the CI job must actually run the verification contract.
 *
 * Asserting that `.github/workflows/ci.yml` and `scripts/ci-verify.sh` merely
 * EXIST proves nothing about what CI runs: the workflow could be edited to
 * `npm test`, or to pass `--skip-mutations --skip-docker`, and every local
 * guard would stay green while the required remote check silently verified far
 * less than it claims. This suite guards the shared-contract claim itself.
 */

const REPO_ROOT = process.cwd();

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
}
interface WorkflowJob {
  readonly name?: string;
  readonly steps?: WorkflowStep[];
}
interface Workflow {
  readonly on?: unknown;
  readonly jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(): Workflow {
  return yaml.load(
    readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'),
  ) as Workflow;
}

function ciVerifySource(): string {
  return readFileSync(resolve(REPO_ROOT, 'scripts/ci-verify.sh'), 'utf8');
}

describe('AC8: the blocking CI job runs the shared verification contract', () => {
  it('defines a job named `verify`', () => {
    expect(Object.keys(loadWorkflow().jobs ?? {})).toContain('verify');
  });

  it('triggers on push to main', () => {
    // `on` is parsed as the boolean true by YAML 1.1, so both keys are checked.
    const workflow = loadWorkflow() as Record<string, unknown>;
    const triggers = (workflow['on'] ?? workflow['true']) as
      | { push?: { branches?: string[] } }
      | undefined;

    expect(triggers?.push?.branches).toContain('main');
  });

  it('invokes scripts/ci-verify.sh', () => {
    const steps = loadWorkflow().jobs?.['verify']?.steps ?? [];
    const runs = steps.map((step) => step.run ?? '').join('\n');

    expect(runs).toMatch(/scripts\/ci-verify\.sh/);
  });

  it('does NOT weaken the contract with skip flags', () => {
    const steps = loadWorkflow().jobs?.['verify']?.steps ?? [];
    const verifyInvocation = steps
      .map((step) => step.run ?? '')
      .find((run) => run.includes('scripts/ci-verify.sh'));

    expect(verifyInvocation).toBeDefined();
    expect(verifyInvocation).not.toMatch(/--skip-docker/);
    expect(verifyInvocation).not.toMatch(/--skip-mutations/);
  });

  it('installs the secret scanner with a pinned, checksum-verified version', () => {
    const runs = (loadWorkflow().jobs?.['verify']?.steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');

    expect(runs).toMatch(/gitleaks/);
    expect(runs, 'the scanner download must be checksum verified').toMatch(/sha256sum -c/);
  });

  it('supplies a real revision so the provenance gate can pass', () => {
    const raw = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

    expect(raw).toMatch(/ETBZ_REVISION:\s*\$\{\{\s*github\.sha\s*\}\}/);
  });
});

describe('AC8: the verification contract still contains every mandatory gate', () => {
  it.each([
    ['install gate', /npm ci/],
    ['typecheck', /typecheck/],
    ['lint', /npm run --silent lint|run_lint/],
    ['tests', /vitest run/],
    ['build', /npm run --silent build|run_build/],
    ['guard mutation proofs', /verify-guards\.sh/],
    ['secret scan', /secret-scan\.sh/],
    ['dependency risk scan', /npm audit/],
    ['container build dry run', /build-dry-run\.sh/],
  ])('still runs the %s', (_label, pattern) => {
    expect(ciVerifySource()).toMatch(pattern);
  });

  it('asserts a minimum executed-test count that cannot be lowered', () => {
    const source = ciVerifySource();

    expect(source).toMatch(/MINIMUM_TEST_COUNT/);
    // The floor may be raised from the environment but never lowered, so an
    // env var cannot turn the anti-false-green assertion into a no-op.
    expect(source, 'the test-count floor must not be lowerable').toMatch(
      /ETBZ_MINIMUM_TEST_COUNT_FLOOR|floor|-lt/,
    );
  });

  it('asserts every test suite contributed at least one executed file', () => {
    const source = ciVerifySource();

    for (const suite of ['unit', 'integration', 'negative', 'contract', 'architecture']) {
      expect(source).toContain(`"${suite}"`);
    }
  });
});
