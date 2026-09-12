/**
 * ETBZ-25B — the example environment must document the variables the LOADER READS.
 *
 * This file exists because a 12-variable name drift shipped green. `.env.example`
 * documented `ETBZ_EXAMPLE_TOKENROUTER_BASE_URL` and eleven siblings, while
 * `llm-routes.ts` has only ever read `TOKENROUTER_BASE_URL`. An operator who did
 * exactly what the file says — copy it, fill it in — configured nothing: every
 * route reported `missing_configuration` and no message anywhere said why.
 *
 * The guard that was in place tested the wrong property. `boundaries.test.ts`
 * asserts `.env.example` EXISTS; nothing had ever read its CONTENT. Existence is
 * not a contract.
 *
 * WHY THE EXPECTATION IS DERIVED, NOT TYPED. Every name below comes from
 * `APPROVED_LLM_ROUTES` itself. A hardcoded list of the twelve names would be a
 * SECOND copy of the same truth, free to drift from the loader in precisely the
 * way the first copy did — a test that reproduces the defect it is meant to
 * catch. Because the expectation is read out of the module, renaming a variable
 * in `llm-routes.ts` without touching `.env.example` fails here, and there is no
 * edit to this file that can make the two agree while they actually differ.
 *
 * It checks BOTH directions. Forward: every consumed variable is documented.
 * Inverse: every documented route variable is consumed — which is what catches a
 * half-applied rename, where the real name is added and the stale one is left
 * behind for the next operator to copy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVED_LLM_ROUTES } from '../../src/app/configuration/llm-routes.js';

const REPO_ROOT = process.cwd();

function exampleEnvText(): string {
  return readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
}

/** Every variable `buildLlmRoutePlan` actually reads, straight from the module. */
const CONSUMED_ROUTE_VARIABLES: readonly string[] = APPROVED_LLM_ROUTES.flatMap((route) => [
  route.baseUrlVariable,
  route.modelVariable,
  route.apiKeyVariable,
]);

/**
 * The provider namespaces a route variable can live in, derived from the
 * consumed names.
 *
 * Used only by the INVERSE check, to decide which assignment lines in the file
 * are claiming to configure a route at all. Deriving it means adding a fifth
 * provider needs no edit here.
 */
const ROUTE_NAMESPACES: readonly string[] = [
  ...new Set(CONSUMED_ROUTE_VARIABLES.map((name) => name.split('_')[0] ?? name)),
];

/**
 * Does this name CLAIM to configure one of the approved routes?
 *
 * Matched on underscore-delimited TOKENS, not on a leading prefix, and the
 * distinction is the entire value of the inverse check. The exact drift this
 * file exists to catch was named `ETBZ_EXAMPLE_TOKENROUTER_BASE_URL` — a prefix
 * test reads its namespace as `ETBZ`, finds no route called that, and waves the
 * stale line through. A token test sees `TOKENROUTER` in the middle and catches
 * it. Measured: with the prefix form, a half-applied rename that left all twelve
 * original names in place passed this suite 5/5 green.
 */
function claimsARoute(name: string): boolean {
  const tokens = new Set(name.split('_'));
  return ROUTE_NAMESPACES.some((namespace) => tokens.has(namespace));
}

/** `NAME=value` at the start of a line. A commented line is not documentation. */
interface Assignment {
  readonly name: string;
  readonly value: string;
}

function uncommentedAssignments(text: string): readonly Assignment[] {
  const found: Assignment[] = [];
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      found.push({ name: match[1], value: match[2] ?? '' });
    }
  }
  return found;
}

describe('ETBZ-25B .env.example documents the variables the loader reads', () => {
  it('derives its expectation from a non-empty route plan (guard self-check)', () => {
    // Anti-vacuous positive control, the house standard in llm-boundary.test.ts.
    // Three of the checks below compare a computed list to []. If
    // APPROVED_LLM_ROUTES were ever empty or filtered — a later slice gating
    // providers by environment, say — every one of them would pass over nothing
    // and this file would certify a `.env.example` documenting no route at all.
    expect(APPROVED_LLM_ROUTES.length).toBeGreaterThanOrEqual(4);
    expect(CONSUMED_ROUTE_VARIABLES.length).toBe(APPROVED_LLM_ROUTES.length * 3);
    expect(ROUTE_NAMESPACES.length).toBeGreaterThanOrEqual(4);
    // And the token matcher recognises BOTH spellings of the drift it guards.
    expect(claimsARoute('TOKENROUTER_BASE_URL')).toBe(true);
    expect(claimsARoute('ETBZ_EXAMPLE_TOKENROUTER_BASE_URL')).toBe(true);
    expect(claimsARoute('ETBZ_ENV')).toBe(false);
  });

  it('documents EVERY variable APPROVED_LLM_ROUTES consumes, uncommented', () => {
    const documented = new Set(uncommentedAssignments(exampleEnvText()).map((a) => a.name));

    const missing = CONSUMED_ROUTE_VARIABLES.filter((name) => !documented.has(name));

    // Named rather than counted: a reader of a red run needs to know WHICH.
    expect(missing).toEqual([]);
  });

  it('documents no route variable that the loader does not read', () => {
    const assignments = uncommentedAssignments(exampleEnvText());
    const consumed = new Set(CONSUMED_ROUTE_VARIABLES);

    // Anything in a provider namespace is claiming to configure that route.
    const orphaned = assignments
      .map((a) => a.name)
      .filter(claimsARoute)
      .filter((name) => !consumed.has(name));

    expect(orphaned).toEqual([]);
  });

  it('documents the two cost-cap variables assertNoPaidPathAuthorized reads', () => {
    // Not part of a route, but read by the same module and load-bearing for the
    // 0.00 EUR cap: an operator who cannot see them cannot set them correctly.
    const documented = new Set(uncommentedAssignments(exampleEnvText()).map((a) => a.name));

    expect(documented.has('LLM_ALLOW_PAID')).toBe(true);
    expect(documented.has('LLM_PAID_COST_CAP_USD')).toBe(true);
  });

  it('carries no credential value for any route', () => {
    // The file is committed. A placeholder that merely LOOKS like a key is the
    // shape `gitleaks` refuses, and a real one is the thing it exists to stop.
    const apiKeyVariables = new Set(APPROVED_LLM_ROUTES.map((route) => route.apiKeyVariable));
    const filled = uncommentedAssignments(exampleEnvText())
      .filter((a) => apiKeyVariables.has(a.name))
      .filter((a) => a.value.trim().length > 0)
      .map((a) => a.name);

    expect(filled).toEqual([]);
  });

  it('keeps the documented cap values the ONLY ones the loader accepts', () => {
    // `.env.example` is copied verbatim more often than it is read. If the two
    // cap lines shipped a value the loader refuses, the documented starting
    // point would be a configuration that throws LlmPaidPathError on boot.
    const byName = new Map(uncommentedAssignments(exampleEnvText()).map((a) => [a.name, a.value]));

    expect(byName.get('LLM_ALLOW_PAID')).toBe('false');
    expect(byName.get('LLM_PAID_COST_CAP_USD')).toBe('0');
  });
});
