import { describe, expect, it } from 'vitest';
import { CHAT_COMPLETIONS_PATH } from '../../src/adapters/llm/openai-compatible-client.js';
import type { EnvironmentRecord } from '../../src/app/configuration/config.js';
import {
  APPROVED_LLM_ROUTES,
  DEFAULT_LLM_TIMEOUT_MS,
  LlmPaidPathError,
  ZAI_FREE_MODEL_ALLOWLIST,
  assertNoPaidPathAuthorized,
  buildLlmRoutePlan,
  isModelInFreeAllowlist,
  isNoChargeModelId,
  isNoChargeRouteModel,
} from '../../src/app/configuration/llm-routes.js';
import type {
  ApprovedRouteDefinition,
  LlmRouteConfig,
  LlmRouteId,
  LlmRoutePlan,
  RouteEligibility,
} from '../../src/app/configuration/llm-routes.js';
import { FIXTURE_LLM_ENV } from '../support/llmNarrativeFixture.js';

/**
 * ETBZ-25B — the route plan is the place where "a synthetic run costs
 * 0.00 EUR" stops being a promise and becomes a decision a machine makes.
 *
 * Everything downstream of `buildLlmRoutePlan` (the adapter, the failover
 * ladder, the evidence record) trusts the plan: whatever is in `routes` WILL be
 * called with a real credential. So the plan's two claims have to be measured,
 * not assumed:
 *
 *   1. NO ROUTE IS CALLED UNLESS ITS ZERO PRICE IS DECIDABLE FROM THE MODEL ID.
 *      The whole cap rests on `isNoChargeModelId`, a four-character suffix
 *      test. A marker that is merely CONTAINED rather than terminal (a paid
 *      `…/freeform-7b`) would silently authorize a billable call, so the anchor
 *      is swept from both sides here: ids that must pass, and near-miss ids that
 *      must not.
 *   2. A REFUSED ROUTE IS VISIBLE, NOT ABSENT. `eligibility` carries every
 *      approved route with its verdict, including the skipped ones — an
 *      operator must be able to read WHY a provider was not tried instead of
 *      inferring it from a shorter list. The fixture environment configures
 *      gemini with a model that carries no marker precisely so this suite can
 *      prove a skip is reported rather than swallowed.
 *
 * The credential boundary is proven the same way: `RouteEligibility` is the
 * record that travels into reports and evidence, so this suite asserts its
 * exact field set and then scans it for every configured key value — with a
 * positive control showing the same scan DOES find those values inside
 * `routes`, where they legitimately live. A leak detector that has never fired
 * is not a detector.
 *
 * Negative cases below all start from `FIXTURE_LLM_ENV` — an environment
 * verified in the positive blocks to yield three eligible routes — and change
 * exactly one variable, so a red assertion names one cause.
 */

/** The five approved routes in the Product Owner's declared preference order. */
const PREFERENCE_ORDER: readonly LlmRouteId[] = [
  'tokenrouter',
  'gemini',
  'opencode',
  'openrouter',
  'zai',
];

/**
 * The complete, non-secret field set of a `RouteEligibility` record.
 *
 * Written out literally rather than derived from a sample object: deriving the
 * expectation from the value under test would make this assertion tautological,
 * and an `apiKey` sneaking into the record is exactly what it must catch.
 */
const ELIGIBILITY_FIELDS: readonly string[] = [
  'routeId',
  'order',
  'eligible',
  'ineligibleReason',
  'baseUrl',
  'model',
  'noChargeBasis',
  'statement',
];

function definitionFor(routeId: LlmRouteId): ApprovedRouteDefinition {
  const definition = APPROVED_LLM_ROUTES.find((candidate) => candidate.routeId === routeId);
  if (definition === undefined) {
    throw new Error(`no approved route definition for ${routeId}`);
  }
  return definition;
}

function eligibilityFor(plan: LlmRoutePlan, routeId: LlmRouteId): RouteEligibility {
  const entry = plan.eligibility.find((candidate) => candidate.routeId === routeId);
  if (entry === undefined) {
    throw new Error(`no eligibility entry for ${routeId}`);
  }
  return entry;
}

function routeFor(plan: LlmRoutePlan, routeId: LlmRouteId): LlmRouteConfig {
  const route = plan.routes.find((candidate) => candidate.routeId === routeId);
  if (route === undefined) {
    throw new Error(`no route config for ${routeId}`);
  }
  return route;
}

/** Reads a variable the fixture environment is expected to configure. */
function fixtureValue(variable: string): string {
  const value = FIXTURE_LLM_ENV[variable];
  if (value === undefined) {
    throw new Error(`the fixture environment does not configure ${variable}`);
  }
  return value;
}

/** The valid baseline with exactly the supplied variables replaced. */
function environmentWith(overrides: Readonly<Record<string, string>>): EnvironmentRecord {
  return { ...FIXTURE_LLM_ENV, ...overrides };
}

/** The valid baseline with exactly one variable removed. */
function environmentWithout(variable: string): EnvironmentRecord {
  const next: Record<string, string> = { ...FIXTURE_LLM_ENV };
  delete next[variable];
  return next;
}

const TOKENROUTER = definitionFor('tokenrouter');
const GEMINI = definitionFor('gemini');
const ZAI = definitionFor('zai');

/** Every credential the fixture environment configures, read from the declarations. */
const CONFIGURED_API_KEYS: readonly string[] = APPROVED_LLM_ROUTES.map((definition) =>
  fixtureValue(definition.apiKeyVariable),
);

describe('ETBZ-25B: the no-charge marker is anchored at the END of the model id', () => {
  it.each([
    ['vendor hyphen form', 'a/b-free'],
    ['vendor colon form', 'a/b:free'],
    ['bare hyphen form', 'model-c-free'],
    ['the fixture tokenrouter model', fixtureValue(TOKENROUTER.modelVariable)],
    ['the fixture openrouter model', fixtureValue(definitionFor('openrouter').modelVariable)],
  ])('accepts %s as checkably zero-price', (_label, modelId) => {
    expect(isNoChargeModelId(modelId)).toBe(true);
  });

  it.each([
    ['no marker at all', 'a/b'],
    ['the word only as a prefix of the id', 'freeform-7b'],
    ['the word only as a vendor segment', 'free/model'],
    ['the marker followed by more id', 'a-free-b'],
    ['the colon marker followed by more id', 'a:free-b'],
    ['the marker inside a path segment', 'free-tier/model-7b'],
    ['a marker separated by the wrong character', 'a/b_free'],
    ['a marker separated by a space', 'a/b free'],
    ['the bare word, which names no model', 'free'],
    ['the fixture gemini model', fixtureValue(GEMINI.modelVariable)],
    ['an empty id', ''],
    ['a whitespace-only id', '   '],
  ])('refuses %s', (_label, modelId) => {
    expect(isNoChargeModelId(modelId)).toBe(false);
  });

  it('ignores surrounding whitespace, because an env value carries it', () => {
    // `readPresentValue` trims before the marker is tested; asserting the
    // predicate itself trims keeps the two from drifting apart.
    expect(isNoChargeModelId('  a/b-free  ')).toBe(true);
    expect(isNoChargeModelId('\ta/b:free\n')).toBe(true);
  });

  it('matches the marker case-insensitively, as providers publish it', () => {
    expect(isNoChargeModelId('a/b-FREE')).toBe(true);
    expect(isNoChargeModelId('a/b:Free')).toBe(true);
  });

  it('separates ids that differ only in the trailing marker', () => {
    // The single-character difference that decides whether money moves.
    expect(isNoChargeModelId('vendor/model-a-free')).toBe(true);
    expect(isNoChargeModelId('vendor/model-a-freex')).toBe(false);
  });
});

describe('ETBZ-25B: APPROVED_LLM_ROUTES is reviewable product truth', () => {
  it('declares exactly five approved routes', () => {
    expect(APPROVED_LLM_ROUTES).toHaveLength(5);
  });

  it('assigns the orders 1 to 5 with no gap, duplicate or renumbering', () => {
    expect(APPROVED_LLM_ROUTES.map((definition) => definition.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('appends the newest route last and leaves the historical order untouched', () => {
    // Adding a route must not silently re-rank the four that were approved
    // first: that is a separate product decision. The new route takes the next
    // free order, and the first four keep the numbers they had.
    expect(APPROVED_LLM_ROUTES.slice(0, 4).map((definition) => definition.routeId)).toEqual([
      'tokenrouter',
      'gemini',
      'opencode',
      'openrouter',
    ]);
    expect(definitionFor('zai').order).toBe(5);
  });

  it('names each route once, in the Product Owner preference order', () => {
    const routeIds = APPROVED_LLM_ROUTES.map((definition) => definition.routeId);
    expect(routeIds).toEqual(PREFERENCE_ORDER);
    expect(new Set(routeIds).size).toBe(routeIds.length);
  });

  it('binds every route to its own three environment variables', () => {
    // A copy-pasted variable name would make two routes share a credential and
    // silently call the wrong provider with the wrong key.
    const variables = APPROVED_LLM_ROUTES.flatMap((definition) => [
      definition.baseUrlVariable,
      definition.modelVariable,
      definition.apiKeyVariable,
    ]);
    expect(variables).toHaveLength(15);
    expect(new Set(variables).size).toBe(15);
  });

  it('states a checkable no-charge basis and a published reason for each route', () => {
    for (const definition of APPROVED_LLM_ROUTES) {
      expect(
        ['provider_free_model_tier', 'provider_exact_free_model_allowlist'],
        definition.routeId,
      ).toContain(definition.noChargeBasis);
      expect(definition.statement.length, definition.routeId).toBeGreaterThan(0);
    }
  });

  it('gives an allowlist-based route a non-empty allowlist, and a marker-based route none', () => {
    // The two bases are not interchangeable decorations. An allowlist route with
    // no list admits nothing (see `isNoChargeRouteModel`), so an empty one would
    // be a silently dead route; a marker route with a list would be carrying a
    // rule that nothing reads.
    for (const definition of APPROVED_LLM_ROUTES) {
      if (definition.noChargeBasis === 'provider_exact_free_model_allowlist') {
        expect(definition.freeModelAllowlist, definition.routeId).toBeDefined();
        expect((definition.freeModelAllowlist ?? []).length, definition.routeId).toBeGreaterThan(0);
      } else {
        expect(definition.freeModelAllowlist, definition.routeId).toBeUndefined();
      }
    }
  });

  it('uses the allowlist basis for exactly one route, and names its two reviewed ids', () => {
    const allowlisted = APPROVED_LLM_ROUTES.filter(
      (definition) => definition.noChargeBasis === 'provider_exact_free_model_allowlist',
    );

    expect(allowlisted.map((definition) => definition.routeId)).toEqual(['zai']);
    expect(ZAI_FREE_MODEL_ALLOWLIST).toEqual(['glm-4.7-flash', 'glm-4.5-flash']);
    expect(ZAI.freeModelAllowlist).toBe(ZAI_FREE_MODEL_ALLOWLIST);
  });
});

describe('ETBZ-25B: the plan over a fully configured environment', () => {
  const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);

  it('offers the callable routes in Product Owner preference order', () => {
    expect(plan.routes.map((route) => route.routeId)).toEqual([
      'tokenrouter',
      'opencode',
      'openrouter',
    ]);
    // The declared order survives into the plan: gemini's order 2 is skipped,
    // not renumbered, so the remaining routes keep their product identity.
    expect(plan.routes.map((route) => route.order)).toEqual([1, 3, 4]);
  });

  it('refuses gemini because its configured model carries no zero-price marker', () => {
    const gemini = eligibilityFor(plan, 'gemini');
    expect(gemini.eligible).toBe(false);
    expect(gemini.ineligibleReason).toBe('model_not_marked_no_charge');
    // The refusal is about the MODEL, not about missing configuration: the
    // fixture configures all three gemini variables.
    expect(gemini.baseUrl).toBe(fixtureValue(GEMINI.baseUrlVariable));
    expect(gemini.model).toBe(fixtureValue(GEMINI.modelVariable));
    expect(isNoChargeModelId(fixtureValue(GEMINI.modelVariable))).toBe(false);
  });

  it('marks the other three routes eligible with no refusal reason', () => {
    // Positive control for the refusal above: the guard is not always red.
    for (const routeId of ['tokenrouter', 'opencode', 'openrouter'] as const) {
      const entry = eligibilityFor(plan, routeId);
      expect(entry.eligible, routeId).toBe(true);
      expect(entry.ineligibleReason, routeId).toBeNull();
    }
  });

  it('lists every approved route in eligibility, so a skip is visible not absent', () => {
    expect(plan.eligibility.map((entry) => entry.routeId)).toEqual(PREFERENCE_ORDER);
    expect(plan.eligibility).toHaveLength(APPROVED_LLM_ROUTES.length);
    expect(plan.eligibility.map((entry) => entry.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps routes and eligibility in agreement', () => {
    expect(plan.routes.map((route) => route.routeId)).toEqual(
      plan.eligibility.filter((entry) => entry.eligible).map((entry) => entry.routeId),
    );
    for (const entry of plan.eligibility) {
      // Eligible iff no reason: never both, never neither.
      expect(entry.eligible, entry.routeId).toBe(entry.ineligibleReason === null);
    }
  });

  it('exposes exactly the non-secret eligibility fields and no credential field', () => {
    for (const entry of plan.eligibility) {
      expect([...Object.keys(entry)].sort(), entry.routeId).toEqual(
        [...ELIGIBILITY_FIELDS].sort(),
      );
      expect(Object.hasOwn(entry, 'apiKey'), entry.routeId).toBe(false);
      expect(Object.hasOwn(entry, 'timeoutMs'), entry.routeId).toBe(false);
    }
  });

  it('places no configured credential value anywhere in the eligibility record', () => {
    const serializedEligibility = JSON.stringify(plan.eligibility);
    expect(CONFIGURED_API_KEYS).toHaveLength(5);
    for (const apiKey of CONFIGURED_API_KEYS) {
      expect(serializedEligibility.includes(apiKey), apiKey).toBe(false);
    }
  });

  it('finds those same credential values in routes, proving the scan can detect one', () => {
    // Positive control for the leak scan above: `routes` is where a credential
    // legitimately lives, so the identical search must succeed there.
    const serializedRoutes = JSON.stringify(plan.routes);
    expect(serializedRoutes.includes(fixtureValue(TOKENROUTER.apiKeyVariable))).toBe(true);
    expect(routeFor(plan, 'tokenrouter').apiKey).toBe(
      fixtureValue(TOKENROUTER.apiKeyVariable),
    );
  });

  it('carries the configured model and basis into each callable route', () => {
    for (const route of plan.routes) {
      const definition = definitionFor(route.routeId);
      expect(route.model, route.routeId).toBe(fixtureValue(definition.modelVariable));
      expect(route.apiKey, route.routeId).toBe(fixtureValue(definition.apiKeyVariable));
      expect(route.noChargeBasis, route.routeId).toBe(definition.noChargeBasis);
    }
  });

  it('never places an unmarked model into a callable route', () => {
    // The cost invariant restated over the plan's own output: whatever survives
    // into `routes` must satisfy the predicate the cap is built on.
    for (const route of plan.routes) {
      expect(isNoChargeModelId(route.model), route.routeId).toBe(true);
    }
  });

  it('applies the default timeout, and the supplied one when given', () => {
    // The PROPERTY, not the number: the default must leave a slow reasoning
    // model room to answer. Pinning the literal here would turn a measured
    // change to the ceiling into a test failure that says nothing.
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    for (const route of plan.routes) {
      expect(route.timeoutMs, route.routeId).toBe(DEFAULT_LLM_TIMEOUT_MS);
    }
    const shortPlan = buildLlmRoutePlan(FIXTURE_LLM_ENV, 1_234);
    expect(shortPlan.routes.map((route) => route.timeoutMs)).toEqual([1_234, 1_234, 1_234]);
  });

  it('trims surrounding whitespace off a configured value', () => {
    const padded = buildLlmRoutePlan(
      environmentWith({
        [TOKENROUTER.modelVariable]: `  ${fixtureValue(TOKENROUTER.modelVariable)}  `,
      }),
    );
    expect(routeFor(padded, 'tokenrouter').model).toBe(
      fixtureValue(TOKENROUTER.modelVariable),
    );
  });

  it('is a pure function: identical input yields deeply equal output', () => {
    expect(buildLlmRoutePlan(FIXTURE_LLM_ENV)).toEqual(buildLlmRoutePlan(FIXTURE_LLM_ENV));
  });
});

describe('ETBZ-25B: eligibility is decided by the model id, uniformly per route', () => {
  it('admits gemini once its configured model carries the marker', () => {
    // Positive control AND the proof that gemini is not hardcoded out: only the
    // model id changes, and the route becomes callable.
    const plan = buildLlmRoutePlan(
      environmentWith({ [GEMINI.modelVariable]: 'vendor-model-b:free' }),
    );
    expect(plan.routes.map((route) => route.routeId)).toEqual([
      'tokenrouter',
      'gemini',
      'opencode',
      'openrouter',
    ]);
    expect(eligibilityFor(plan, 'gemini').eligible).toBe(true);
    expect(eligibilityFor(plan, 'gemini').ineligibleReason).toBeNull();
  });

  it('refuses tokenrouter once its configured model loses the marker', () => {
    const plan = buildLlmRoutePlan(
      environmentWith({ [TOKENROUTER.modelVariable]: 'vendor/model-a' }),
    );
    const entry = eligibilityFor(plan, 'tokenrouter');
    expect(entry.eligible).toBe(false);
    expect(entry.ineligibleReason).toBe('model_not_marked_no_charge');
    expect(plan.routes.map((route) => route.routeId)).toEqual(['opencode', 'openrouter']);
  });

  it('refuses a near-miss model that only contains the word free', () => {
    const plan = buildLlmRoutePlan(
      environmentWith({ [TOKENROUTER.modelVariable]: 'vendor/freeform-7b' }),
    );
    expect(eligibilityFor(plan, 'tokenrouter').ineligibleReason).toBe(
      'model_not_marked_no_charge',
    );
  });

  it('reports the refused model id, so the operator can see what was configured', () => {
    const plan = buildLlmRoutePlan(
      environmentWith({ [TOKENROUTER.modelVariable]: 'vendor/model-a' }),
    );
    expect(eligibilityFor(plan, 'tokenrouter').model).toBe('vendor/model-a');
  });
});

describe('ETBZ-25B: a route missing configuration is skipped, never guessed', () => {
  it('keeps tokenrouter callable while all three of its variables are set', () => {
    // Positive control: the baseline this block mutates is genuinely valid.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    expect(eligibilityFor(plan, 'tokenrouter').eligible).toBe(true);
    expect(routeFor(plan, 'tokenrouter').routeId).toBe('tokenrouter');
  });

  it.each([
    ['base URL', TOKENROUTER.baseUrlVariable],
    ['model', TOKENROUTER.modelVariable],
    ['api key', TOKENROUTER.apiKeyVariable],
  ])('refuses tokenrouter when its %s is unset', (_label, variable) => {
    const plan = buildLlmRoutePlan(environmentWithout(variable));
    const entry = eligibilityFor(plan, 'tokenrouter');
    expect(entry.eligible).toBe(false);
    expect(entry.ineligibleReason).toBe('missing_configuration');
    expect(plan.routes.map((route) => route.routeId)).toEqual(['opencode', 'openrouter']);
  });

  it.each([
    ['base URL', TOKENROUTER.baseUrlVariable],
    ['model', TOKENROUTER.modelVariable],
    ['api key', TOKENROUTER.apiKeyVariable],
  ])('treats a whitespace-only %s exactly like an unset one', (_label, variable) => {
    const plan = buildLlmRoutePlan(environmentWith({ [variable]: '   ' }));
    expect(eligibilityFor(plan, 'tokenrouter').ineligibleReason).toBe('missing_configuration');
  });

  it.each([
    ['base URL', TOKENROUTER.baseUrlVariable],
    ['model', TOKENROUTER.modelVariable],
    ['api key', TOKENROUTER.apiKeyVariable],
  ])('treats an empty %s exactly like an unset one', (_label, variable) => {
    const plan = buildLlmRoutePlan(environmentWith({ [variable]: '' }));
    expect(eligibilityFor(plan, 'tokenrouter').ineligibleReason).toBe('missing_configuration');
  });

  it('reports null for the missing non-secret field and keeps the present one', () => {
    const plan = buildLlmRoutePlan(environmentWithout(TOKENROUTER.baseUrlVariable));
    const entry = eligibilityFor(plan, 'tokenrouter');
    expect(entry.baseUrl).toBeNull();
    expect(entry.model).toBe(fixtureValue(TOKENROUTER.modelVariable));
  });

  it('reports null for both non-secret fields when the credential alone is missing', () => {
    // The absent value is the API key, which the record never carries anyway —
    // so the two reported fields still show what WAS configured.
    const plan = buildLlmRoutePlan(environmentWithout(TOKENROUTER.apiKeyVariable));
    const entry = eligibilityFor(plan, 'tokenrouter');
    expect(entry.baseUrl).toBe(fixtureValue(TOKENROUTER.baseUrlVariable));
    expect(entry.model).toBe(fixtureValue(TOKENROUTER.modelVariable));
    expect(Object.hasOwn(entry, 'apiKey')).toBe(false);
  });

  it('still lists all five routes when the environment configures none of them', () => {
    const plan = buildLlmRoutePlan({});
    expect(plan.routes).toEqual([]);
    expect(plan.eligibility.map((entry) => entry.routeId)).toEqual(PREFERENCE_ORDER);
    for (const entry of plan.eligibility) {
      expect(entry.eligible, entry.routeId).toBe(false);
      expect(entry.ineligibleReason, entry.routeId).toBe('missing_configuration');
      expect(entry.baseUrl, entry.routeId).toBeNull();
      expect(entry.model, entry.routeId).toBeNull();
    }
  });
});

describe('ETBZ-25B: base URL normalisation cannot produce a double slash', () => {
  it('passes a clean base URL through unchanged', () => {
    // Positive control: normalisation is a trailing-slash trim, not a rewrite.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    expect(routeFor(plan, 'tokenrouter').baseUrl).toBe(
      fixtureValue(TOKENROUTER.baseUrlVariable),
    );
  });

  it.each([
    ['one trailing slash', 'https://provider.invalid/one/v1/'],
    ['several trailing slashes', 'https://provider.invalid/one/v1///'],
  ])('strips %s from the callable base URL', (_label, configured) => {
    const plan = buildLlmRoutePlan(
      environmentWith({ [TOKENROUTER.baseUrlVariable]: configured }),
    );
    expect(routeFor(plan, 'tokenrouter').baseUrl).toBe('https://provider.invalid/one/v1');
  });

  it('yields a chat-completions URL with no empty path segment', () => {
    // The failure this prevents: `…/v1//chat/completions`, which at least one
    // approved provider answers with a 404 that reads like a missing model.
    const plan = buildLlmRoutePlan(
      environmentWith({ [TOKENROUTER.baseUrlVariable]: 'https://provider.invalid/one/v1/' }),
    );
    const url = `${routeFor(plan, 'tokenrouter').baseUrl}${CHAT_COMPLETIONS_PATH}`;
    expect(url).toBe('https://provider.invalid/one/v1/chat/completions');
    expect(url.replace(/^https?:\/\//, '')).not.toContain('//');
  });

  it('leaves no callable base URL ending in a slash', () => {
    const plan = buildLlmRoutePlan(
      environmentWith({
        [TOKENROUTER.baseUrlVariable]: `${fixtureValue(TOKENROUTER.baseUrlVariable)}/`,
        [definitionFor('opencode').baseUrlVariable]: 'https://provider.invalid/three/v1//',
      }),
    );
    expect(plan.routes).toHaveLength(3);
    for (const route of plan.routes) {
      expect(route.baseUrl.endsWith('/'), route.routeId).toBe(false);
    }
  });

  it('reports the configured base URL verbatim in the eligibility record', () => {
    // The eligibility record describes CONFIGURATION, not a callable endpoint:
    // it mirrors what the operator set (the fixture gemini URL ends in a
    // slash), while the trim is applied where a URL is actually built.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    expect(fixtureValue(GEMINI.baseUrlVariable).endsWith('/')).toBe(true);
    expect(eligibilityFor(plan, 'gemini').baseUrl).toBe(
      fixtureValue(GEMINI.baseUrlVariable),
    );
  });
});

describe('ETBZ-25B: the plan carries the 0.00 EUR cap as a constant, not a setting', () => {
  it('declares a zero cap, a refused paid path and its plan version', () => {
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    expect(plan.approvedCostCapEur).toBe(0);
    expect(plan.allowPaid).toBe(false);
    expect(plan.planVersion).toBe('etbz-25b.llm-route-plan.v2');
  });

  it('moved the plan version when the eligibility MECHANISM changed, not just the list', () => {
    // v1 meant "eligible == the model id ends in a free marker". v2 means the
    // verdict came from one of two rules, and the refusal vocabulary grew. A
    // reader of an old record must be able to tell which rule produced it.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    expect(plan.planVersion).not.toBe('etbz-25b.llm-route-plan.v1');
    expect(new Set(APPROVED_LLM_ROUTES.map((definition) => definition.noChargeBasis)).size).toBe(2);
  });

  it('keeps the cap when no route is eligible at all', () => {
    const plan = buildLlmRoutePlan({});
    expect(plan.approvedCostCapEur).toBe(0);
    expect(plan.allowPaid).toBe(false);
  });

  it('keeps the cap when every route is eligible', () => {
    // Positive control from the other extreme: the cap is not an artefact of a
    // partially configured environment. Both deliberately-refused routes are
    // admitted here, each through its OWN rule.
    const plan = buildLlmRoutePlan(
      environmentWith({
        [GEMINI.modelVariable]: 'vendor-model-b:free',
        [ZAI.modelVariable]: 'glm-4.7-flash',
      }),
    );
    expect(plan.routes).toHaveLength(5);
    expect(plan.approvedCostCapEur).toBe(0);
    expect(plan.allowPaid).toBe(false);
  });
});

describe('ETBZ-25B: no environment variable can authorize a paid path', () => {
  it('accepts the baseline environment, which asks for nothing billable', () => {
    // Positive control: the guard passes configuration that stays within cap.
    expect(() => {
      assertNoPaidPathAuthorized(FIXTURE_LLM_ENV);
    }).not.toThrow();
    expect(() => buildLlmRoutePlan(FIXTURE_LLM_ENV)).not.toThrow();
  });

  it('refuses an environment that asks for a paid path, before building any route', () => {
    const environment = environmentWith({ LLM_ALLOW_PAID: 'true' });
    let caught: unknown;
    try {
      buildLlmRoutePlan(environment);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmPaidPathError);
    if (!(caught instanceof LlmPaidPathError)) return;
    expect(caught.code).toBe('LLM_PAID_PATH_NOT_AUTHORIZED');
    expect(caught.issues.map((issue) => issue.variable)).toEqual(['LLM_ALLOW_PAID']);
    expect(caught.issues.map((issue) => issue.code)).toEqual(['paid_path_not_authorized']);
  });

  it('refuses a non-zero cost cap and a cap that is not a number at all', () => {
    for (const cap of ['0.01', '1', 'unlimited']) {
      expect(() => buildLlmRoutePlan(environmentWith({ LLM_PAID_COST_CAP_USD: cap })), cap)
        .toThrow(LlmPaidPathError);
    }
  });

  it('accepts the cap values that still mean zero', () => {
    // Positive control for the cap check: it refuses a REQUEST for budget, not
    // every spelling of nothing.
    for (const cap of ['0', '0.00', ' 0 ']) {
      expect(() => buildLlmRoutePlan(environmentWith({ LLM_PAID_COST_CAP_USD: cap })), cap)
        .not.toThrow();
    }
  });

  it('reports both violations when the environment asks for both', () => {
    const environment = environmentWith({
      LLM_ALLOW_PAID: 'true',
      LLM_PAID_COST_CAP_USD: '5',
    });
    let caught: unknown;
    try {
      assertNoPaidPathAuthorized(environment);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmPaidPathError);
    if (!(caught instanceof LlmPaidPathError)) return;
    expect(caught.issues.map((issue) => issue.variable)).toEqual([
      'LLM_ALLOW_PAID',
      'LLM_PAID_COST_CAP_USD',
    ]);
  });

  it('states the expectation without echoing the received value', () => {
    // A refusal that quotes what it received turns an error path into a
    // disclosure path; the sentinel below must not survive into the issues.
    const sentinel = 'sentinel-please-bill-me';
    const environment = environmentWith({ LLM_ALLOW_PAID: sentinel });
    expect(environment['LLM_ALLOW_PAID']).toBe(sentinel);
    let caught: unknown;
    try {
      assertNoPaidPathAuthorized(environment);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmPaidPathError);
    if (!(caught instanceof LlmPaidPathError)) return;
    expect(JSON.stringify(caught.issues).includes(sentinel)).toBe(false);
    expect(caught.message.includes(sentinel)).toBe(false);
    expect(caught.issues.map((issue) => issue.expectation.length > 0)).toEqual([true]);
  });

  it('treats an explicit "false" as the absence of a request for budget', () => {
    expect(() => {
      assertNoPaidPathAuthorized(environmentWith({ LLM_ALLOW_PAID: 'FALSE' }));
    }).not.toThrow();
    expect(() => {
      assertNoPaidPathAuthorized(environmentWithout('LLM_ALLOW_PAID'));
    }).not.toThrow();
  });
});

/**
 * The direct Z.ai route: the second no-charge basis, and why it is narrow.
 *
 * This provider publishes a price of Free for ids that carry NO marker, whose
 * shape is indistinguishable from the paid models beside them on the same price
 * table. The marker rule cannot decide them, and the tempting repair — treating
 * `-flash` as a free marker — would have authorised `glm-4.7-flashx`, a PAID
 * model one character away from a free one.
 *
 * So the tests below sweep the boundary from BOTH sides, the same discipline the
 * marker block at the top of this file applies: the two reviewed ids must pass,
 * and every near-miss that a prefix, suffix or substring rule would have let
 * through must fail. The fixture environment configures this route with
 * `glm-4.7-flashx` on purpose, so the default state of the whole suite is the
 * trap being refused.
 */
describe('ETBZ-25B: the Z.ai route is decided by an EXACT free-model allowlist', () => {
  it('is absent from the plan as missing_configuration when nothing configures it', () => {
    // The first thing to establish: a route nobody configured is skipped and
    // REPORTED, never assumed free and never silently absent.
    const plan = buildLlmRoutePlan({ LLM_ALLOW_PAID: 'false', LLM_PAID_COST_CAP_USD: '0' });
    const entry = eligibilityFor(plan, 'zai');

    expect(entry.eligible).toBe(false);
    expect(entry.ineligibleReason).toBe('missing_configuration');
    expect(entry.baseUrl).toBeNull();
    expect(entry.model).toBeNull();
    expect(plan.routes.map((route) => route.routeId)).not.toContain('zai');
  });

  it.each([
    ['the primary reviewed id', 'glm-4.7-flash'],
    ['the backup reviewed id', 'glm-4.5-flash'],
  ])('admits %s, and reports the allowlist basis with it', (_label, model) => {
    const plan = buildLlmRoutePlan(environmentWith({ [ZAI.modelVariable]: model }));
    const entry = eligibilityFor(plan, 'zai');

    expect(entry.eligible).toBe(true);
    expect(entry.ineligibleReason).toBeNull();
    expect(entry.model).toBe(model);
    expect(entry.noChargeBasis).toBe('provider_exact_free_model_allowlist');
    expect(routeFor(plan, 'zai').model).toBe(model);
    expect(routeFor(plan, 'zai').order).toBe(5);
  });

  it.each([
    ['the paid base model', 'glm-4.7'],
    ['the paid FlashX variant, one character away from free', 'glm-4.7-flashx'],
    ['the other paid base model', 'glm-4.5'],
    ['a paid Air variant', 'glm-4.5-air'],
    ['a paid AirX variant', 'glm-4.5-airx'],
    ['an arbitrary model merely ending in -flash', 'foo-flash'],
    ['a newer flash model nobody reviewed', 'glm-5.3-flash'],
    ['a free id with something appended', 'glm-4.7-flash-turbo'],
    ['a free id with a vendor prefix, as another gateway spells it', 'z-ai/glm-4.7-flash'],
    ['a free id carrying the other providers’ marker', 'glm-4.7-flash:free'],
    ['an unrecognised id', 'not-a-model'],
  ])('refuses %s', (_label, model) => {
    const plan = buildLlmRoutePlan(environmentWith({ [ZAI.modelVariable]: model }));
    const entry = eligibilityFor(plan, 'zai');

    expect(entry.eligible).toBe(false);
    expect(entry.ineligibleReason).toBe('model_not_in_free_allowlist');
    // Reported verbatim, so an operator can see WHICH id was refused.
    expect(entry.model).toBe(model);
    expect(plan.routes.map((route) => route.routeId)).not.toContain('zai');
  });

  it('refuses the model the fixture configures, so the suite runs against the trap', () => {
    // Not a restatement of the table above: it pins the DEFAULT state of every
    // other test in this repository. If the fixture were ever changed to an
    // allowlisted id, route 5 would quietly become callable in dozens of tests.
    expect(FIXTURE_LLM_ENV[ZAI.modelVariable]).toBe('glm-4.7-flashx');
    expect(eligibilityFor(buildLlmRoutePlan(FIXTURE_LLM_ENV), 'zai').ineligibleReason).toBe(
      'model_not_in_free_allowlist',
    );
  });

  it('names the rule that refused, distinguishing the two bases in the verdict', () => {
    // The two refusals are different facts and lead to different operator
    // actions, so they must not share one reason string.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);

    expect(eligibilityFor(plan, 'gemini').ineligibleReason).toBe('model_not_marked_no_charge');
    expect(eligibilityFor(plan, 'zai').ineligibleReason).toBe('model_not_in_free_allowlist');
  });

  it('does NOT teach the marker rule that a flash model is free', () => {
    // The counterexample that proves the allowlist was added INSTEAD OF widening
    // the marker. If `isNoChargeModelId` had learned `-flash`, every one of
    // these would be true and routes 1 to 4 would have been opened up with it.
    for (const model of ['glm-4.7-flash', 'glm-4.5-flash', 'foo-flash', 'glm-4.7-flashx']) {
      expect(isNoChargeModelId(model), model).toBe(false);
    }
    // And the marker rule still decides the marker routes, unchanged.
    expect(isNoChargeModelId('vendor/model-a-free')).toBe(true);
  });

  it('keeps the two rules bound to their own routes', () => {
    // A free-marker id must not become callable on the allowlist route, and an
    // allowlisted id must not become callable on a marker route. Each rule
    // governs the routes it was approved for and no others.
    expect(isNoChargeRouteModel('zai', 'glm-4.7-flash')).toBe(true);
    expect(isNoChargeRouteModel('zai', 'vendor/model-a-free')).toBe(false);
    expect(isNoChargeRouteModel('tokenrouter', 'vendor/model-a-free')).toBe(true);
    expect(isNoChargeRouteModel('tokenrouter', 'glm-4.7-flash')).toBe(false);
  });

  it('folds case and surrounding whitespace without widening the set', () => {
    expect(isModelInFreeAllowlist('  glm-4.7-flash  ', ZAI_FREE_MODEL_ALLOWLIST)).toBe(true);
    expect(isModelInFreeAllowlist('GLM-4.7-Flash', ZAI_FREE_MODEL_ALLOWLIST)).toBe(true);
    // Still exact equality against a fixed list: folding decides nothing else.
    expect(isModelInFreeAllowlist('glm-4.7-flashx', ZAI_FREE_MODEL_ALLOWLIST)).toBe(false);
    expect(isModelInFreeAllowlist('', ZAI_FREE_MODEL_ALLOWLIST)).toBe(false);
    expect(isModelInFreeAllowlist('   ', ZAI_FREE_MODEL_ALLOWLIST)).toBe(false);
  });

  it('admits nothing when the allowlist is empty, rather than everything', () => {
    // The fail-closed direction of the same function. An allowlist route whose
    // list went missing must become unusable, not unguarded.
    expect(isModelInFreeAllowlist('glm-4.7-flash', [])).toBe(false);
  });

  it('admits nothing for a route this module never approved', () => {
    // `isNoChargeRouteModel` resolves the basis from APPROVED_LLM_ROUTES, so an
    // id nobody approved has no permissive default to fall back on.
    expect(isNoChargeRouteModel('unknown-route' as LlmRouteId, 'glm-4.7-flash')).toBe(false);
    expect(isNoChargeRouteModel('unknown-route' as LlmRouteId, 'vendor/model-a-free')).toBe(false);
  });

  it.each([
    ['a plaintext endpoint', 'http://api.provider.invalid/v4'],
    ['an endpoint carrying inline credentials', 'https://user:secret@api.provider.invalid/v4'],
    ['a value that is not a URL at all', 'api.provider.invalid/v4'],
  ])('fails closed on %s, before the model is even considered', (_label, baseUrl) => {
    const plan = buildLlmRoutePlan(
      environmentWith({
        [ZAI.baseUrlVariable]: baseUrl,
        // An ALLOWLISTED model, so the refusal can only be about the URL.
        [ZAI.modelVariable]: 'glm-4.7-flash',
      }),
    );
    const entry = eligibilityFor(plan, 'zai');

    expect(entry.eligible).toBe(false);
    expect(entry.ineligibleReason).toBe('base_url_not_acceptable');
    // Withheld deliberately: a URL refused for carrying a credential must not be
    // republished in the verdict that refused it.
    expect(entry.baseUrl).toBeNull();
    expect(plan.routes.map((route) => route.routeId)).not.toContain('zai');
  });

  it('never places the Z.ai credential in the eligibility record, eligible or not', () => {
    const secret = fixtureValue(ZAI.apiKeyVariable);
    const refused = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    const admitted = buildLlmRoutePlan(
      environmentWith({ [ZAI.modelVariable]: 'glm-4.7-flash' }),
    );

    expect(secret.length).toBeGreaterThan(0);
    expect(JSON.stringify(refused.eligibility).includes(secret)).toBe(false);
    expect(JSON.stringify(admitted.eligibility).includes(secret)).toBe(false);
    // Positive control for the scan: the credential IS in `routes`, where it
    // legitimately lives, so the two assertions above are detecting something.
    expect(JSON.stringify(admitted.routes).includes(secret)).toBe(true);
    expect(routeFor(admitted, 'zai').apiKey).toBe(secret);
  });

  it.each([
    ['base URL', ZAI.baseUrlVariable],
    ['model', ZAI.modelVariable],
    ['api key', ZAI.apiKeyVariable],
  ])('refuses the route when its %s is unset, even with the others valid', (_label, variable) => {
    const environment = environmentWithout(variable);
    const plan = buildLlmRoutePlan({ ...environment, [ZAI.modelVariable]: 'glm-4.7-flash' });
    const entry = eligibilityFor(plan, 'zai');

    if (variable === ZAI.modelVariable) {
      // The override above re-supplies the model, so this one case is eligible.
      expect(entry.eligible).toBe(true);
      return;
    }
    expect(entry.eligible).toBe(false);
    expect(entry.ineligibleReason).toBe('missing_configuration');
  });

  it('keeps the cap and the refused paid path with the new route eligible', () => {
    const plan = buildLlmRoutePlan(environmentWith({ [ZAI.modelVariable]: 'glm-4.7-flash' }));

    expect(plan.approvedCostCapEur).toBe(0);
    expect(plan.allowPaid).toBe(false);
    expect(plan.planVersion).toBe('etbz-25b.llm-route-plan.v2');
  });

  it('cannot be switched to a paid model by any environment variable', () => {
    // The cap's own property, restated over the new basis: asking for budget is
    // refused before a single route is inspected, and an invented override does
    // not widen the allowlist.
    expect(() =>
      buildLlmRoutePlan(
        environmentWith({ [ZAI.modelVariable]: 'glm-4.7-flash', LLM_ALLOW_PAID: 'true' }),
      ),
    ).toThrow(LlmPaidPathError);

    const invented = buildLlmRoutePlan(
      environmentWith({
        [ZAI.modelVariable]: 'glm-4.7',
        ZAI_ALLOW_PAID_MODEL: 'true',
        ZAI_FREE_MODEL_ALLOWLIST: 'glm-4.7',
        LLM_FORCE_ROUTE: 'zai',
      }),
    );
    expect(eligibilityFor(invented, 'zai').ineligibleReason).toBe('model_not_in_free_allowlist');
    expect(invented.routes.map((route) => route.routeId)).not.toContain('zai');
  });

  it('leaves the four historical routes behaving exactly as before', () => {
    // The whole point of appending rather than reworking: the plan the rest of
    // the suite is read against is unchanged by this route's arrival.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);

    expect(plan.routes.map((route) => route.routeId)).toEqual([
      'tokenrouter',
      'opencode',
      'openrouter',
    ]);
    expect(plan.routes.map((route) => route.order)).toEqual([1, 3, 4]);
    for (const routeId of ['tokenrouter', 'opencode', 'openrouter'] as const) {
      expect(eligibilityFor(plan, routeId).eligible, routeId).toBe(true);
      expect(eligibilityFor(plan, routeId).noChargeBasis, routeId).toBe(
        'provider_free_model_tier',
      );
    }
    expect(eligibilityFor(plan, 'gemini').ineligibleReason).toBe('model_not_marked_no_charge');
  });
});
