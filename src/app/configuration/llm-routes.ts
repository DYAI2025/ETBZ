/**
 * ETBZ-25B — the approved LLM route plan, and the guards that keep it free.
 *
 * The Product Owner approved FOUR development routes, in a fixed preference
 * order, under one hard condition: the billable LLM cost of a synthetic run is
 * `0.00 EUR`. This module is where that condition becomes mechanical.
 *
 * THE SPLIT between code and configuration, stated because it is the whole
 * design: WHICH routes are approved and in WHAT ORDER is product truth and
 * lives in `APPROVED_LLM_ROUTES` below, where it is versioned and reviewable.
 * Base URLs, model ids and credentials are CONFIGURATION and live in the
 * environment — the contract is explicit that "model IDs and base URLs are
 * configuration, not hard-coded product truth".
 *
 * HOW NO-CHARGE IS VERIFIED, and what that verification is worth. Every
 * approved route declares the BASIS on which its no-charge status can be
 * checked, and the check is a property of the configured MODEL ID, not a
 * promise in a comment:
 *
 *   provider_free_model_tier   the provider publishes its zero-price models
 *                              under an explicit marker in the model id
 *                              (`…-free`, `…:free`). A configured model without
 *                              that marker is refused.
 *
 * A route whose no-charge status cannot be decided from the configuration it
 * was given is INELIGIBLE and is skipped — it is never "probably free". That is
 * the fail-closed reading of the cost cap, and it is deliberately strict enough
 * to exclude a provider whose free tier exists but is not expressed in the
 * model id: ETBZ cannot check what the provider does not publish.
 *
 * WHY PAID CANNOT BE SWITCHED ON. `assertNoPaidPathAuthorized` refuses a paid
 * path unconditionally. There is no environment variable, flag or override that
 * enables it, because the contract requires a NEW explicit human approval for
 * any cost above `0.00 EUR`, and a human approval that an operator can grant to
 * themselves by exporting a variable is not an approval. Raising the cap is a
 * code change in a future slice, reviewed as one.
 *
 * Credentials are read here and never leave: they travel in `LlmRouteConfig`
 * into the adapter and nowhere else. No issue, no log line and no evidence
 * record in this slice carries a credential value — see
 * `narrative-evidence.ts`, which proves it rather than asserting it.
 */

import type { EnvironmentRecord } from './config.js';

export type LlmRouteId = 'tokenrouter' | 'gemini' | 'opencode' | 'openrouter';

/** The ways a route's zero price can be established from configuration alone. */
export type NoChargeBasis = 'provider_free_model_tier';

export interface ApprovedRouteDefinition {
  readonly routeId: LlmRouteId;
  /** The Product Owner's preference order. 1 is tried first. */
  readonly order: number;
  readonly baseUrlVariable: string;
  readonly modelVariable: string;
  readonly apiKeyVariable: string;
  readonly noChargeBasis: NoChargeBasis;
  /** Why this basis is checkable for this provider. Published with evidence. */
  readonly statement: string;
}

/**
 * The four approved routes, in the Product Owner's order.
 *
 * Adding a route here is the only way to widen the provider surface, and it is
 * a reviewed code change — exactly as a provider decision should be.
 */
export const APPROVED_LLM_ROUTES: readonly ApprovedRouteDefinition[] = [
  {
    routeId: 'tokenrouter',
    order: 1,
    baseUrlVariable: 'TOKENROUTER_BASE_URL',
    modelVariable: 'TOKENROUTER_MODEL',
    apiKeyVariable: 'TOKENROUTER_API_KEY',
    noChargeBasis: 'provider_free_model_tier',
    statement:
      'TokenRouter publishes its zero-price models with an explicit free marker in the model id; a model without that marker is a billable model.',
  },
  {
    routeId: 'gemini',
    order: 2,
    baseUrlVariable: 'GEMINI_BASE_URL',
    modelVariable: 'GEMINI_MODEL',
    apiKeyVariable: 'GEMINI_API_KEY',
    noChargeBasis: 'provider_free_model_tier',
    statement:
      'The Gemini OpenAI-compatible endpoint carries no per-model price marker in its model ids: whether a call is billed depends on the billing state of the key’s project, which the API does not report back. ETBZ cannot decide no-charge from configuration here, so this route stays ineligible under a 0.00 EUR cap.',
  },
  {
    routeId: 'opencode',
    order: 3,
    baseUrlVariable: 'OPENCODE_BASE_URL',
    modelVariable: 'OPENCODE_PRIMARY_MODEL',
    apiKeyVariable: 'OPENCODE_API_KEY',
    noChargeBasis: 'provider_free_model_tier',
    statement:
      'The OpenCode zen catalogue is published entirely under free markers in the model id.',
  },
  {
    routeId: 'openrouter',
    order: 4,
    baseUrlVariable: 'OPENROUTER_BASE_URL',
    modelVariable: 'OPENROUTER_MODEL',
    apiKeyVariable: 'OPENROUTER_API_KEY',
    noChargeBasis: 'provider_free_model_tier',
    statement:
      'OpenRouter publishes zero-price variants under the `:free` marker, and its model catalogue reports `pricing.prompt` and `pricing.completion` of "0" for exactly those ids.',
  },
] as const;

/**
 * The marker that makes a model id checkably zero-price.
 *
 * Anchored at the END of the id so that a paid model merely containing the word
 * (`…/freeform-7b`) cannot pass. Both separators the approved providers use are
 * accepted.
 */
const NO_CHARGE_MODEL_MARKER = /(?::free|-free)$/i;

/** True when the model id carries its provider's explicit zero-price marker. */
export function isNoChargeModelId(modelId: string): boolean {
  return NO_CHARGE_MODEL_MARKER.test(modelId.trim());
}

export type RouteIneligibilityReason =
  /** The route's base URL, model or credential is not configured. */
  | 'missing_configuration'
  /** The configured model carries no zero-price marker: it may be billable. */
  | 'model_not_marked_no_charge'
  /** The base URL is not a plain https endpoint, or carries inline credentials. */
  | 'base_url_not_acceptable';

/**
 * A base URL ETBZ is willing to send a credential to.
 *
 * Two refusals, both about where a secret can end up. A URL carrying userinfo
 * (`https://user:secret@host/v1`) puts a credential inside a string that this
 * slice publishes as NON-SECRET evidence — `RouteEligibility.baseUrl` is written
 * into the run record, and the sanitizer cannot recognise a password it was
 * never told about. A plaintext `http://` endpoint would send the bearer token
 * over the wire in the clear.
 */
export function isAcceptableBaseUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    // Loopback stays usable for a local provider during development; it is the
    // one case where plaintext does not put a credential on a network.
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!(url.protocol === 'http:' && loopback)) {
      return false;
    }
  }
  return url.username === '' && url.password === '';
}

export interface RouteEligibility {
  readonly routeId: LlmRouteId;
  readonly order: number;
  readonly eligible: boolean;
  /** Null when eligible; the refusal reason otherwise. */
  readonly ineligibleReason: RouteIneligibilityReason | null;
  /** Non-secret. Null when not configured. */
  readonly baseUrl: string | null;
  /** Non-secret. Null when not configured. */
  readonly model: string | null;
  readonly noChargeBasis: NoChargeBasis;
  readonly statement: string;
}

/**
 * A route ETBZ may actually call.
 *
 * `apiKey` is the ONLY secret in this module's output. It is consumed by the
 * adapter and by nothing else: it is never rendered, never hashed into an
 * artefact, never placed in an issue and never written to evidence.
 */
export interface LlmRouteConfig {
  readonly routeId: LlmRouteId;
  readonly order: number;
  /** Normalized: no trailing slash, so path concatenation cannot double it. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly noChargeBasis: NoChargeBasis;
  readonly timeoutMs: number;
}

export interface LlmRoutePlan {
  readonly planVersion: 'etbz-25b.llm-route-plan.v1';
  /** The approved development cap. Not configurable in this slice. */
  readonly billableCostCapEur: 0;
  readonly allowPaid: false;
  /** Every approved route with its verdict — including the refused ones. */
  readonly eligibility: readonly RouteEligibility[];
  /** The eligible routes, in preference order. May be empty. */
  readonly routes: readonly LlmRouteConfig[];
}

export type LlmConfigIssueCode = 'paid_path_not_authorized';

export interface LlmConfigIssue {
  readonly variable: string;
  readonly code: LlmConfigIssueCode;
  /** Static, value-free. A received value never leaves this module. */
  readonly expectation: string;
}

export class LlmPaidPathError extends Error {
  readonly code: 'LLM_PAID_PATH_NOT_AUTHORIZED';
  readonly issues: readonly LlmConfigIssue[];
  constructor(issues: readonly LlmConfigIssue[]) {
    super(
      'a billable LLM path is not authorized in ETBZ-25B; the approved development cost cap is 0.00 EUR and raising it requires a new explicit human approval, not a configuration change',
    );
    this.name = 'LlmPaidPathError';
    this.code = 'LLM_PAID_PATH_NOT_AUTHORIZED';
    this.issues = issues;
  }
}

/** Default per-request timeout. A reasoning model needs room to answer. */
export const DEFAULT_LLM_TIMEOUT_MS = 600_000;

function readPresentValue(environment: EnvironmentRecord, variable: string): string | undefined {
  const raw = environment[variable];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Refuses any configuration that asks for a billable call.
 *
 * Deliberately NOT parameterised: no argument, flag or variable makes this
 * return quietly when a paid path is requested. The only way to obtain a paid
 * path is to change this function, which is a reviewed code change — which is
 * what "a new explicit Human Approval" has to mean if it is to mean anything.
 */
export function assertNoPaidPathAuthorized(environment: EnvironmentRecord): void {
  const issues: LlmConfigIssue[] = [];
  const allowPaid = readPresentValue(environment, 'LLM_ALLOW_PAID');
  if (allowPaid !== undefined && allowPaid.toLowerCase() !== 'false') {
    issues.push({
      variable: 'LLM_ALLOW_PAID',
      code: 'paid_path_not_authorized',
      expectation: 'unset or exactly "false"; ETBZ-25B has no authorized paid provider path',
    });
  }
  const cap = readPresentValue(environment, 'LLM_PAID_COST_CAP_USD');
  // Matched as TEXT, not parsed as a number. `Number.parseFloat` stops at the
  // first character it cannot use, so `0x10`, `0abc` and the European `0,50`
  // all read back as zero and would have satisfied a numeric comparison — three
  // different ways to write a non-zero cap that a parser reports as free.
  if (cap !== undefined && !/^0(?:\.0+)?$/.test(cap)) {
    issues.push({
      variable: 'LLM_PAID_COST_CAP_USD',
      code: 'paid_path_not_authorized',
      expectation: 'unset or exactly 0; the approved ETBZ-25B development cost cap is 0.00 EUR',
    });
  }
  if (issues.length > 0) {
    throw new LlmPaidPathError(issues);
  }
}

/**
 * Builds the route plan from an explicitly supplied environment record.
 *
 * Pure over its argument in the same sense as `loadEtbzConfig`: it never reads
 * `process.env` itself and touches no file. It returns a plan even when every
 * route is ineligible — an empty `routes` list is a fact the caller must handle
 * and refuse on, not an exception thrown from a loader.
 */
export function buildLlmRoutePlan(
  environment: EnvironmentRecord,
  timeoutMs: number = DEFAULT_LLM_TIMEOUT_MS,
): LlmRoutePlan {
  assertNoPaidPathAuthorized(environment);

  const eligibility: RouteEligibility[] = [];
  const routes: LlmRouteConfig[] = [];

  for (const definition of [...APPROVED_LLM_ROUTES].sort((a, b) => a.order - b.order)) {
    const baseUrl = readPresentValue(environment, definition.baseUrlVariable);
    const model = readPresentValue(environment, definition.modelVariable);
    const apiKey = readPresentValue(environment, definition.apiKeyVariable);

    if (baseUrl === undefined || model === undefined || apiKey === undefined) {
      eligibility.push({
        routeId: definition.routeId,
        order: definition.order,
        eligible: false,
        ineligibleReason: 'missing_configuration',
        baseUrl: baseUrl ?? null,
        model: model ?? null,
        noChargeBasis: definition.noChargeBasis,
        statement: definition.statement,
      });
      continue;
    }

    if (!isAcceptableBaseUrl(baseUrl)) {
      eligibility.push({
        routeId: definition.routeId,
        order: definition.order,
        eligible: false,
        ineligibleReason: 'base_url_not_acceptable',
        // Deliberately withheld: a base URL refused for carrying inline
        // credentials must not then be published in the verdict that refused it.
        baseUrl: null,
        model,
        noChargeBasis: definition.noChargeBasis,
        statement: definition.statement,
      });
      continue;
    }

    if (!isNoChargeModelId(model)) {
      eligibility.push({
        routeId: definition.routeId,
        order: definition.order,
        eligible: false,
        ineligibleReason: 'model_not_marked_no_charge',
        baseUrl,
        model,
        noChargeBasis: definition.noChargeBasis,
        statement: definition.statement,
      });
      continue;
    }

    eligibility.push({
      routeId: definition.routeId,
      order: definition.order,
      eligible: true,
      ineligibleReason: null,
      baseUrl,
      model,
      noChargeBasis: definition.noChargeBasis,
      statement: definition.statement,
    });
    routes.push({
      routeId: definition.routeId,
      order: definition.order,
      // Trailing slash removed once, here. A base URL ending in `/` would
      // otherwise produce `…/openai//chat/completions`, which at least one
      // approved provider answers with a 404 that looks like a missing model.
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey,
      noChargeBasis: definition.noChargeBasis,
      timeoutMs,
    });
  }

  return {
    planVersion: 'etbz-25b.llm-route-plan.v1',
    billableCostCapEur: 0,
    allowPaid: false,
    eligibility,
    routes,
  };
}
