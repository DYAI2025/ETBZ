import { describe, expect, it } from 'vitest';
import type { EnvironmentRecord } from '../../src/app/configuration/index.js';
import {
  APPROVED_LLM_ROUTES,
  LlmPaidPathError,
  assertNoPaidPathAuthorized,
  buildLlmRoutePlan,
} from '../../src/app/configuration/llm-routes.js';
import { FIXTURE_LLM_ENV } from '../support/llmNarrativeFixture.js';

/**
 * ETBZ-25B negative: the 0.00 EUR cost cap has no off switch.
 *
 * The Product Owner approved four development routes under one hard condition —
 * a synthetic run costs nothing. A cap that an operator can lift by exporting a
 * variable is not a cap, it is a suggestion, so the property under test here is
 * not "the default is free" but "free is the only reachable state": every
 * spelling of a paid request is refused, and no variable — approved, invented,
 * or plausibly named — turns the refusal off.
 *
 * Method. Every case starts from `FIXTURE_LLM_ENV`, which is a VALID, fully
 * configured, cap-respecting environment, and changes exactly ONE variable, so
 * a red assertion can only mean the guard reacted to that one change. Each
 * describe-block ends with (or contains) a positive control that runs the
 * unmutated baseline and requires a plan, because a guard that is always red
 * proves nothing about the guard.
 *
 * Two assertions deserve their reasoning spelled out:
 *
 *   The INVENTED variable names are the actual evidence for "unbypassable".
 *   Asserting that `LLM_ALLOW_PAID=true` is refused only proves the one named
 *   variable is handled. What proves the absence of a back door is that a
 *   plausible override set (`ETBZ_LLM_HUMAN_APPROVAL=granted`, `LLM_FORCE=1`,
 *   `ALLOW_BILLABLE=yes`, …) neither lifts the refusal when combined with the
 *   paid flag nor changes the produced plan by a single byte when added on its
 *   own. Inert names are the point: a name that did something would show up as
 *   a plan that differs from the baseline.
 *
 *   The credential assertions are checked against a SENTINEL key set, and the
 *   same describe-block also proves the sentinel reaches `routes[].apiKey`.
 *   Without that positive control, "the credential does not appear in the
 *   issues" would also pass for an environment that simply has no credentials.
 *
 * No network, no model, no real key: the whole slice's cost guarantee is a pure
 * function over an environment record, which is exactly why it can be proven
 * rather than asserted.
 */

/** Removes one variable, so an "absent" case is a real absence, not a blank. */
function withoutVariable(environment: EnvironmentRecord, variable: string): EnvironmentRecord {
  const copy: Record<string, string | undefined> = { ...environment };
  delete copy[variable];
  return copy;
}

/**
 * Runs the guard and returns the refusal it must raise.
 *
 * A plain `expect(...).toThrow()` proves that something was thrown; the tests
 * below also need the typed `issues`, and they must fail loudly — rather than
 * silently skipping their assertions — when nothing is thrown at all.
 */
function refusalFor(environment: EnvironmentRecord): LlmPaidPathError {
  try {
    assertNoPaidPathAuthorized(environment);
  } catch (error) {
    if (error instanceof LlmPaidPathError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected assertNoPaidPathAuthorized to refuse, but it returned normally');
}

/**
 * Variables that do not exist anywhere in ETBZ, named the way an operator in a
 * hurry would name them. They must all be inert.
 */
const INVENTED_OVERRIDES: Readonly<Record<string, string>> = {
  ETBZ_LLM_HUMAN_APPROVAL: 'granted',
  ETBZ_ALLOW_PAID: 'true',
  ETBZ_LLM_ALLOW_PAID: 'true',
  LLM_FORCE: '1',
  LLM_FORCE_PAID: 'true',
  LLM_PAID_OVERRIDE: 'approved-by-operator',
  ALLOW_BILLABLE: 'yes',
  BILLING_APPROVED: 'true',
  LLM_PAID_COST_CAP_EUR: '50',
  LLM_BUDGET_EUR: '50',
  // A lower-case twin of the real variable: the record is read by exact name.
  llm_allow_paid: 'true',
  NODE_ENV: 'production',
  ETBZ_ENV: 'production',
};

/** Sentinel credentials: fake, unique, and impossible to confuse with prose. */
const SENTINEL_CREDENTIALS: Readonly<Record<string, string>> = {
  TOKENROUTER_API_KEY: 'sentinel-credential-tokenrouter-must-not-leak',
  GEMINI_API_KEY: 'sentinel-credential-gemini-must-not-leak',
  OPENCODE_API_KEY: 'sentinel-credential-opencode-must-not-leak',
  OPENROUTER_API_KEY: 'sentinel-credential-openrouter-must-not-leak',
};

/** The credential values an environment actually carries, per approved route. */
function credentialValuesOf(environment: EnvironmentRecord): readonly string[] {
  return APPROVED_LLM_ROUTES.map((route) => environment[route.apiKeyVariable]).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

describe('ETBZ-25B negative: LLM_ALLOW_PAID cannot authorize a paid path', () => {
  it('refuses every truthy spelling of LLM_ALLOW_PAID', () => {
    for (const spelling of ['true', 'TRUE', 'True', ' true ', '1', 'yes', 'YES', 'y', 'on']) {
      const environment = { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: spelling };

      const refusal = refusalFor(environment);

      expect(refusal, `spelling ${JSON.stringify(spelling)} must be refused`).toBeInstanceOf(
        LlmPaidPathError,
      );
      expect(refusal.code).toBe('LLM_PAID_PATH_NOT_AUTHORIZED');
      expect(refusal.issues).toContainEqual(
        expect.objectContaining({
          variable: 'LLM_ALLOW_PAID',
          code: 'paid_path_not_authorized',
        }),
      );
    }
  });

  it('refuses a falsy-looking value that is not the exact word "false"', () => {
    // The guard is an allow-list of one word, not a truthiness test. `off` and
    // `no` are refused because a cap that guesses at intent is a cap that can
    // be argued with; only the spelling the contract names is accepted.
    for (const spelling of ['no', 'off', '0', 'disabled', 'nein', 'FALSCH']) {
      expect(
        () => { assertNoPaidPathAuthorized({ ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: spelling }); },
        `spelling ${JSON.stringify(spelling)} must be refused`,
      ).toThrow(LlmPaidPathError);
    }
  });

  it('raises exactly one issue when only LLM_ALLOW_PAID is wrong', () => {
    // Isolation check: the cap variable is untouched and valid, so the refusal
    // must name one variable. A second issue here would mean the guard reports
    // collateral noise rather than the single thing that changed.
    const refusal = refusalFor({ ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: 'true' });

    expect(refusal.issues).toHaveLength(1);
    expect(refusal.issues[0]?.variable).toBe('LLM_ALLOW_PAID');
  });

  it('positive control: an absent, blank or exactly-"false" LLM_ALLOW_PAID passes', () => {
    const accepted: readonly EnvironmentRecord[] = [
      withoutVariable(FIXTURE_LLM_ENV, 'LLM_ALLOW_PAID'),
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: '' },
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: '   ' },
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: 'false' },
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: 'FALSE' },
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: ' false ' },
    ];

    for (const environment of accepted) {
      expect(
        () => { assertNoPaidPathAuthorized(environment); },
        `${JSON.stringify(environment['LLM_ALLOW_PAID'])} must be accepted`,
      ).not.toThrow();
    }
  });
});

describe('ETBZ-25B negative: LLM_PAID_COST_CAP_USD cannot raise the cap', () => {
  it('refuses any non-zero cost cap', () => {
    for (const cap of ['0.01', '5', '100', '1', '0.5', '1e-3', '-1', '999999']) {
      const refusal = refusalFor({ ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: cap });

      expect(refusal.issues, `cap ${JSON.stringify(cap)} must be refused`).toContainEqual(
        expect.objectContaining({
          variable: 'LLM_PAID_COST_CAP_USD',
          code: 'paid_path_not_authorized',
        }),
      );
    }
  });

  it('refuses an unparseable cap instead of reading it as zero', () => {
    // A cap that cannot be understood is not evidence of a zero cap. Failing
    // closed here is what keeps a typo from being interpreted as approval.
    for (const cap of ['unlimited', 'none', 'abc', 'NaN', '€0']) {
      expect(
        () => { assertNoPaidPathAuthorized({ ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: cap }); },
        `cap ${JSON.stringify(cap)} must be refused`,
      ).toThrow(LlmPaidPathError);
    }
  });

  it('refuses both variables at once when both request a paid path', () => {
    const refusal = refusalFor({
      ...FIXTURE_LLM_ENV,
      LLM_ALLOW_PAID: 'true',
      LLM_PAID_COST_CAP_USD: '42',
    });

    expect(refusal.issues).toHaveLength(2);
    expect(refusal.issues.map((issue) => issue.variable).sort()).toEqual([
      'LLM_ALLOW_PAID',
      'LLM_PAID_COST_CAP_USD',
    ]);
  });

  it('refuses every cap that a lenient NUMBER PARSER would have read as zero', () => {
    // The guard matches the cap as TEXT against /^0(\.0+)?$/ rather than parsing
    // it. `Number.parseFloat` stops at the first character it cannot use, so
    // each value below reads back as exactly 0 and would have satisfied a
    // numeric comparison — three different ways to write a NON-zero cap that a
    // parser reports as free. A cost cap that can be bypassed by choosing a
    // notation is not a cost cap.
    for (const cap of ['0,50', '0abc', '0x10', '0e5', '0.5', '00.1']) {
      expect(
        () => buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: cap }),
        `cap ${JSON.stringify(cap)} must be refused`,
      ).toThrow(LlmPaidPathError);
    }
  });

  it('positive control: an absent or exactly-zero cap passes', () => {
    const accepted: readonly EnvironmentRecord[] = [
      withoutVariable(FIXTURE_LLM_ENV, 'LLM_PAID_COST_CAP_USD'),
      { ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: '' },
      { ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: '0' },
      { ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: '0.0' },
      { ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: '0.00' },
      { ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: ' 0 ' },
    ];

    for (const environment of accepted) {
      expect(
        () => { assertNoPaidPathAuthorized(environment); },
        `${JSON.stringify(environment['LLM_PAID_COST_CAP_USD'])} must be accepted`,
      ).not.toThrow();
    }
  });
});

describe('ETBZ-25B negative: buildLlmRoutePlan propagates the refusal', () => {
  it('never returns a plan for a paid-looking environment', () => {
    const paidLooking: readonly EnvironmentRecord[] = [
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: 'true' },
      { ...FIXTURE_LLM_ENV, LLM_PAID_COST_CAP_USD: '0.01' },
      { ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: '1', LLM_PAID_COST_CAP_USD: '250' },
    ];

    for (const environment of paidLooking) {
      expect(() => buildLlmRoutePlan(environment)).toThrow(LlmPaidPathError);
    }
  });

  it('refuses before it inspects a single route', () => {
    // Nothing is configured here, so the "no eligible route" path would be the
    // natural outcome of any ordering that planned first and checked later. The
    // refusal must win, which is what proves the check is the first statement
    // rather than a filter applied to an already-built plan.
    expect(() => buildLlmRoutePlan({ LLM_ALLOW_PAID: 'true' })).toThrow(LlmPaidPathError);
  });

  it('cannot be talked out of the refusal by the timeout argument', () => {
    // The only other parameter the function takes must not be an escape hatch.
    for (const timeoutMs of [1, 0, 180_000, Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, LLM_ALLOW_PAID: 'true' }, timeoutMs),
      ).toThrow(LlmPaidPathError);
    }
  });

  it('positive control: the same environment yields a plan once the paid flag is "false"', () => {
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);

    expect(plan.planVersion).toBe('etbz-25b.llm-route-plan.v1');
    expect(plan.billableCostCapEur).toBe(0);
    expect(plan.allowPaid).toBe(false);
    expect(plan.routes.length).toBeGreaterThan(0);
  });
});

describe('ETBZ-25B negative: no environment variable switches paid on', () => {
  it('refuses a full plausible override set layered on the paid flag', () => {
    const environment: EnvironmentRecord = {
      ...FIXTURE_LLM_ENV,
      ...INVENTED_OVERRIDES,
      LLM_ALLOW_PAID: 'true',
    };

    expect(() => { assertNoPaidPathAuthorized(environment); }).toThrow(LlmPaidPathError);
    expect(() => buildLlmRoutePlan(environment)).toThrow(LlmPaidPathError);
  });

  it('refuses when any single invented override accompanies the paid flag', () => {
    // One at a time, so a pass cannot be attributed to another key in the set:
    // no single name neutralises the refusal.
    for (const [variable, value] of Object.entries(INVENTED_OVERRIDES)) {
      expect(
        () =>
          buildLlmRoutePlan({
            ...FIXTURE_LLM_ENV,
            [variable]: value,
            LLM_ALLOW_PAID: 'true',
          }),
        `${variable}=${value} must not authorize a paid path`,
      ).toThrow(LlmPaidPathError);
    }
  });

  it('refuses when any single invented override accompanies a raised cap', () => {
    for (const [variable, value] of Object.entries(INVENTED_OVERRIDES)) {
      expect(
        () =>
          buildLlmRoutePlan({
            ...FIXTURE_LLM_ENV,
            [variable]: value,
            LLM_PAID_COST_CAP_USD: '100',
          }),
        `${variable}=${value} must not raise the cap`,
      ).toThrow(LlmPaidPathError);
    }
  });

  it('leaves the produced plan byte-identical when an invented override is added alone', () => {
    // The strongest available statement of "there is no hidden switch": if any
    // of these names were read anywhere in the planner, the serialized plan
    // would differ from the baseline. It does not.
    const baseline = JSON.stringify(buildLlmRoutePlan(FIXTURE_LLM_ENV));

    for (const [variable, value] of Object.entries(INVENTED_OVERRIDES)) {
      const plan = buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, [variable]: value });

      expect(JSON.stringify(plan), `${variable}=${value} must not change the plan`).toBe(baseline);
    }
  });

  it('pins allowPaid and the cap to their literal values under the whole override set', () => {
    // The override set minus the two real variables: accepted, and inert.
    const environment: EnvironmentRecord = { ...FIXTURE_LLM_ENV, ...INVENTED_OVERRIDES };

    const plan = buildLlmRoutePlan(environment);

    expect(plan.allowPaid).toBe(false);
    expect(plan.billableCostCapEur).toBe(0);
    expect(JSON.stringify(plan)).toBe(JSON.stringify(buildLlmRoutePlan(FIXTURE_LLM_ENV)));
  });

  it('positive control: the unmutated baseline environment is accepted', () => {
    expect(() => { assertNoPaidPathAuthorized(FIXTURE_LLM_ENV); }).not.toThrow();
    expect(buildLlmRoutePlan(FIXTURE_LLM_ENV).routes.length).toBeGreaterThan(0);
  });
});

describe('ETBZ-25B negative: the refusal carries no credential value', () => {
  const paidEnvironment: EnvironmentRecord = {
    ...FIXTURE_LLM_ENV,
    ...SENTINEL_CREDENTIALS,
    LLM_ALLOW_PAID: 'sentinel-allow-paid-received-value',
    LLM_PAID_COST_CAP_USD: '13.37',
  };

  it('names variables, never values', () => {
    const refusal = refusalFor(paidEnvironment);

    expect(refusal.issues).toHaveLength(2);
    for (const issue of refusal.issues) {
      expect(['LLM_ALLOW_PAID', 'LLM_PAID_COST_CAP_USD']).toContain(issue.variable);
      expect(issue.code).toBe('paid_path_not_authorized');
      expect(issue.expectation.length).toBeGreaterThan(0);
    }
  });

  it('keeps every configured credential out of every issue string', () => {
    const refusal = refusalFor(paidEnvironment);
    const credentials = credentialValuesOf(paidEnvironment);

    // Derived from APPROVED_LLM_ROUTES, so a fifth route added later is covered
    // by this test without anyone remembering to extend it.
    expect(credentials).toHaveLength(APPROVED_LLM_ROUTES.length);
    for (const credential of credentials) {
      for (const issue of refusal.issues) {
        expect(issue.variable, `issue.variable must not carry ${credential}`).not.toContain(
          credential,
        );
        expect(issue.expectation, `issue.expectation must not carry ${credential}`).not.toContain(
          credential,
        );
      }
      expect(refusal.message).not.toContain(credential);
      expect(JSON.stringify(refusal.issues)).not.toContain(credential);
    }
  });

  it('does not echo the received values that triggered the refusal', () => {
    const refusal = refusalFor(paidEnvironment);
    const serialized = `${refusal.message}${JSON.stringify(refusal.issues)}`;

    expect(serialized).not.toContain('sentinel-allow-paid-received-value');
    expect(serialized).not.toContain('13.37');
  });

  it('does not echo non-secret route configuration either', () => {
    const refusal = refusalFor(paidEnvironment);
    const serialized = `${refusal.message}${JSON.stringify(refusal.issues)}`;

    for (const route of APPROVED_LLM_ROUTES) {
      const baseUrl = paidEnvironment[route.baseUrlVariable];
      const model = paidEnvironment[route.modelVariable];
      expect(baseUrl).toBeDefined();
      expect(model).toBeDefined();
      if (baseUrl !== undefined) expect(serialized).not.toContain(baseUrl);
      if (model !== undefined) expect(serialized).not.toContain(model);
    }
  });

  it('positive control: the same sentinel credential does reach the route it configures', () => {
    // Without this, the absence assertions above would also hold for an
    // environment that simply carries no credentials — which would make them
    // vacuous. The credential exists, flows into `LlmRouteConfig.apiKey`, and
    // is absent only where it must be absent.
    const plan = buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, ...SENTINEL_CREDENTIALS });
    const tokenrouter = plan.routes.find((route) => route.routeId === 'tokenrouter');

    expect(tokenrouter).toBeDefined();
    expect(tokenrouter?.apiKey).toBe(SENTINEL_CREDENTIALS['TOKENROUTER_API_KEY']);
  });
});

describe('ETBZ-25B negative: a billable model cannot be forced into the plan', () => {
  it('keeps a model without a no-charge marker out of the executable route list', () => {
    // The fixture's Gemini model deliberately carries no free marker. The cap
    // is therefore enforced twice: once on the paid flags, once on what may be
    // called at all.
    const plan = buildLlmRoutePlan(FIXTURE_LLM_ENV);
    const verdict = plan.eligibility.find((candidate) => candidate.routeId === 'gemini');

    expect(verdict).toBeDefined();
    expect(verdict?.eligible).toBe(false);
    expect(verdict?.ineligibleReason).toBe('model_not_marked_no_charge');
    expect(plan.routes.map((route) => route.routeId)).not.toContain('gemini');
  });

  it('cannot be made eligible by any invented override', () => {
    for (const [variable, value] of Object.entries({
      ...INVENTED_OVERRIDES,
      GEMINI_ALLOW_BILLABLE: 'true',
      GEMINI_NO_CHARGE: 'true',
      LLM_FORCE_ROUTE: 'gemini',
      LLM_SKIP_NO_CHARGE_CHECK: '1',
    })) {
      const plan = buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, [variable]: value });

      expect(
        plan.routes.map((route) => route.routeId),
        `${variable}=${value} must not make an unmarked model callable`,
      ).not.toContain('gemini');
    }
  });

  it('positive control: the marker in the model id is the one thing that changes the verdict', () => {
    // Exactly one variable differs from the baseline, and it is the model id
    // itself — the only evidence of zero price the module accepts.
    const plan = buildLlmRoutePlan({
      ...FIXTURE_LLM_ENV,
      GEMINI_MODEL: `${FIXTURE_LLM_ENV['GEMINI_MODEL'] ?? ''}-free`,
    });
    const verdict = plan.eligibility.find((candidate) => candidate.routeId === 'gemini');

    expect(verdict?.eligible).toBe(true);
    expect(verdict?.ineligibleReason).toBeNull();
    expect(plan.routes.map((route) => route.routeId)).toContain('gemini');
  });
});
