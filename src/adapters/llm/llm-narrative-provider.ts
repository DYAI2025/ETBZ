/**
 * ETBZ-25B — the REAL narrative provider: routes, failover, and its limits.
 *
 * This is the concrete implementation behind the `NarrativeProvider` port that
 * ETBZ-25A shipped empty on purpose. It lives in `src/adapters` because it is
 * infrastructure: the application layer still knows only the port.
 *
 * THE FOUR FAILOVER RULES, each enforced by a specific line below rather than
 * by care:
 *
 *  1. THE SAME IMMUTABLE BRIEF REACHES EVERY ROUTE. The prompt is built ONCE,
 *     before the loop, from one brief. No route sees a re-derived, re-ordered or
 *     shortened version, and `prompt.briefStructuralHash` is the same value in
 *     every attempt record. This is a property of the control flow: there is no
 *     expression inside the loop that could produce a different prompt.
 *
 *  2. FAILOVER IS ONLY FOR TRANSIENT TECHNICAL FAILURES. The adapter asks
 *     `LlmProviderError.failureClass`, which is decided by the strict transient
 *     allowlist in `openai-compatible-client.ts`. A terminal failure — rejected
 *     credential, vanished model, malformed contract — stops the run.
 *
 *  3. A CONTENT FAILURE IS NEVER A REASON TO TRY ANOTHER PROVIDER. Output that
 *     is not JSON, or is JSON of the wrong shape, ends the run. The contract
 *     says such output is BLOCKED, "not a reason to shop for a more convenient
 *     answer", and the same holds downstream: everything the structural gate
 *     and the semantic QA refuse happens AFTER this adapter has returned, so no
 *     refusal of theirs can reach back in and start another call.
 *
 *  4. NO CONTINUATION AND NO BLENDING. A route either produces one complete
 *     accepted answer or contributes nothing at all. There is no buffer that
 *     survives an attempt, no partial output is retained, and the accepted
 *     answer is returned whole from the single route that produced it. A
 *     truncated answer (`finish_reason: "length"`) is refused rather than
 *     continued elsewhere.
 *
 * COST: POLICY AND OBSERVATION ARE TWO DIFFERENT RECORDS.
 *
 * The POLICY — an approved cap of 0.00 EUR and no authorised paid path — lives
 * in `llm-routes.ts` and is enforced before a credential leaves the process.
 * It is a decision ETBZ made, and it is true whatever a provider says.
 *
 * The OBSERVATION is what a provider actually reported this call cost, and each
 * attempt records it as `reportedCost` — `null` when the provider reported
 * nothing, which is the ordinary case for three of the four approved routes.
 *
 * These used to be the same field. Every attempt wrote `billableCostEur: 0`,
 * sourced from the free-model MARKER in the model id, and a reader could not
 * tell that zero from a measured one. A marker is a defensive eligibility guard
 * — it decides whether ETBZ is willing to call a route at all — and it is not an
 * invoice. Writing an unobserved cost as an observed zero is the single most
 * comfortable lie this record could tell, so the type no longer permits it:
 * `reportedCost` is nullable, and nothing in this module can synthesize one.
 */

import { structuralHashOfCanonicalText } from '../../domain/structural-hash.js';
import { isNoChargeModelId } from '../../app/configuration/llm-routes.js';
import type { LlmRouteConfig, LlmRoutePlan } from '../../app/configuration/llm-routes.js';
import { NarrativeProviderError } from '../../application/interpretation/errors.js';
import type {
  NarrativePromptIdentity,
  ProviderFailureDetailCode,
} from '../../application/interpretation/errors.js';
import {
  parseNarrativeDraft,
  toProviderOutput,
} from '../../application/interpretation/narrative-draft.js';
import type { NarrativeBrief } from '../../application/interpretation/narrative-brief.js';
import { buildNarrativePrompt } from '../../application/interpretation/prompt-policy.js';
import type { NarrativePrompt } from '../../application/interpretation/prompt-policy.js';
import type { NarrativeProviderOutput } from '../../application/ports/narrative-provider.js';
import {
  LlmProviderError,
  requestChatCompletion,
} from './openai-compatible-client.js';
import type {
  LlmReasoningEffort,
  LlmUsage,
  ReportedCost,
  Transport,
} from './openai-compatible-client.js';

/** The provider id recorded in the report's provenance, per route. */
export function providerIdFor(route: LlmRouteConfig): string {
  return `etbz-25b.openai-compatible.${route.routeId}.${route.model}`;
}

export type RouteAttemptOutcome =
  /** The route produced one complete, well-shaped answer. */
  | 'accepted'
  /** A bounded technical availability failure. Failover is authorised. */
  | 'transient_failure'
  /** A terminal transport failure. The run stops. */
  | 'terminal_failure'
  /** The route answered, but its CONTENT is unusable. The run stops. */
  | 'content_rejected';

/**
 * One attempt against one route.
 *
 * Everything here is non-secret by construction: a route id, a model id, an
 * error code, a status, token counts and a hash. No field can hold a credential
 * and none holds the answer text itself — the hash is what binds the evidence
 * to the answer.
 */
export interface RouteAttempt {
  readonly order: number;
  readonly routeId: string;
  readonly model: string;
  readonly outcome: RouteAttemptOutcome;
  readonly errorCode: string | null;
  /**
   * WHICH closed transport failure this was, when the transport refused the
   * attempt. `null` on an accepted attempt and on a content refusal, whose
   * `errorCode` is already specific.
   */
  readonly failureDetailCode: ProviderFailureDetailCode | null;
  readonly httpStatus: number | null;
  /** Whether the contract authorises moving to the next route after this. */
  readonly failoverAuthorized: boolean;
  readonly usage: LlmUsage | null;
  readonly responseId: string | null;
  /** sha256 of the raw answer text. Binds evidence to an exact answer. */
  readonly responseHash: string | null;
  readonly finishReason: string | null;
  /**
   * What the PROVIDER reported this attempt cost. `null` when it reported
   * nothing — which is not a zero, and must never be written as one.
   */
  readonly reportedCost: ReportedCost | null;
}

export interface LlmNarrativeResult {
  readonly providerOutput: NarrativeProviderOutput;
  /** The single prompt every attempt received. */
  readonly prompt: NarrativePrompt;
  readonly acceptedRouteId: string;
  readonly acceptedModel: string;
  /** Every attempt, in order, including the ones that failed. */
  readonly attempts: readonly RouteAttempt[];
}

export interface LlmNarrativeOptions {
  /**
   * Room for a reasoning model to think AND still answer.
   *
   * Measured on the approved free route against the real brief: the model spent
   * roughly twenty-two thousand tokens reasoning before emitting its first
   * content token. A budget that merely looks generous is not generous — at
   * twelve thousand the model exhausted the whole allowance on reasoning and
   * returned `finish_reason: "length"` with an empty message, which this slice
   * correctly refuses as a truncated reading. The ceiling is set from that
   * measurement rather than from a round number.
   */
  readonly maxTokens: number;
  readonly temperature: number;
  /** See `LlmChatRequest.stream`: a transport decision, not a product one. */
  readonly stream: boolean;
  /**
   * An explicit reasoning effort, passed through to the request only when set.
   *
   * Deliberately ABSENT from `DEFAULT_LLM_NARRATIVE_OPTIONS`: the default run
   * sends no `reasoning_effort`, exactly as before this option existed. A caller
   * that wants one says so, and its evidence records what it asked for.
   */
  readonly reasoningEffort?: LlmReasoningEffort;
}

export const DEFAULT_LLM_NARRATIVE_OPTIONS: LlmNarrativeOptions = {
  maxTokens: 32_000,
  temperature: 0.7,
  stream: true,
};

/**
 * Finish reasons that mean the answer STOPPED rather than ENDED.
 *
 * Compared case-insensitively with separators folded, because the same
 * condition is spelled `length`, `MAX_TOKENS` and `max_tokens` across the
 * OpenAI-compatible providers in scope. `content_filter` belongs here too: a
 * reading cut short by a provider's own filter is incomplete, whatever the
 * reason for the cut.
 */
export function isIncompleteFinishReason(finishReason: string | null): boolean {
  if (finishReason === null) {
    return false;
  }
  const normalized = finishReason.toLowerCase().replace(/[\s_-]+/gu, '');
  return ['length', 'maxtokens', 'contentfilter', 'toolcalls'].includes(normalized);
}

function failedAttempt(
  route: LlmRouteConfig,
  outcome: RouteAttemptOutcome,
  error: LlmProviderError,
  failoverAuthorized: boolean,
): RouteAttempt {
  // Only what the transport genuinely OBSERVED before refusing: a finish reason,
  // a usage block, a cost report. Each stays `null` when it was not observed —
  // writing 0 would be inventing a measurement for a call that never completed.
  const observed = error.observed;
  return {
    order: route.order,
    routeId: route.routeId,
    model: route.model,
    outcome,
    errorCode: error.code,
    failureDetailCode: error.detailCode,
    httpStatus: error.status ?? null,
    failoverAuthorized,
    usage: observed?.usage ?? null,
    responseId: null,
    // No answer was accepted, so there is nothing to bind a hash to.
    responseHash: null,
    finishReason: observed?.finishReason ?? null,
    reportedCost: observed?.reportedCost ?? null,
  };
}

/** The prompt's identity, without its text. Travels on every refusal. */
function promptIdentityOf(prompt: NarrativePrompt): NarrativePromptIdentity {
  return {
    briefStructuralHash: prompt.briefStructuralHash,
    promptStructuralHash: prompt.promptStructuralHash,
    promptVersion: prompt.promptVersion,
    policyVersion: prompt.policyVersion,
  };
}

/**
 * Obtains ONE narrative answer for ONE brief.
 *
 * Returns the accepted answer together with the full attempt history, so the
 * evidence record can state what was tried and why the run moved on — a
 * failover nobody can see is indistinguishable from a provider swap.
 */
export async function generateNarrativeFromPlan(
  brief: NarrativeBrief,
  plan: LlmRoutePlan,
  transport: Transport,
  options: LlmNarrativeOptions = DEFAULT_LLM_NARRATIVE_OPTIONS,
): Promise<LlmNarrativeResult> {
  // RULE 1. Built once, outside the loop, from one brief. Every route below
  // receives this exact object; nothing in the loop can rebuild it.
  //
  // Built BEFORE the eligibility refusal too, so that every refusal this
  // function raises carries the identity of the prompt the run was prepared to
  // send — and a run refused before its first request still leaves evidence
  // naming its brief and prompt. The attempt ledger shows nothing was sent.
  const prompt = buildNarrativePrompt(brief);
  const identity = promptIdentityOf(prompt);

  if (plan.routes.length === 0) {
    throw new NarrativeProviderError(
      'PROVIDER_NO_ELIGIBLE_ROUTE',
      `no approved route is eligible under the 0.00 EUR development cost cap; verdicts: ${plan.eligibility
        .map(
          (entry) =>
            `${entry.routeId}=${entry.eligible ? 'eligible' : (entry.ineligibleReason ?? 'ineligible')}`,
        )
        .join(', ')}`,
      [],
      identity,
    );
  }

  const attempts: RouteAttempt[] = [];

  for (const route of plan.routes) {
    // Re-checked HERE, immediately before the request, and not only when the
    // plan was built. The cost cap is the contract's hardest condition, and a
    // check that happens once at load time is a check that trusts every line of
    // code between load time and the call. This one sits on the last statement
    // before the credential goes out.
    if (!isNoChargeModelId(route.model)) {
      throw new NarrativeProviderError(
        'PROVIDER_NO_ELIGIBLE_ROUTE',
        `route "${route.routeId}" reached the call with model "${route.model}", which carries no zero-price marker; the 0.00 EUR cap refuses it`,
        attempts,
        identity,
      );
    }

    let completion;
    try {
      completion = await requestChatCompletion(
        route,
        {
          system: prompt.system,
          user: prompt.user,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          jsonObjectMode: true,
          stream: options.stream,
          // Absent unless the caller asked: the default request is unchanged.
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort }),
        },
        transport,
      );
    } catch (error) {
      if (error instanceof LlmProviderError) {
        const transient = error.failureClass === 'transient';
        attempts.push(
          failedAttempt(route, transient ? 'transient_failure' : 'terminal_failure', error, transient),
        );
        if (transient) {
          // RULE 4: nothing from this attempt is retained. The next route
          // starts from the same prompt and an empty hand.
          continue;
        }
        throw new NarrativeProviderError(
          'PROVIDER_TERMINAL_FAILURE',
          `route "${route.routeId}" failed terminally (${error.code}/${error.detailCode}); failover is not authorised for this failure class`,
          attempts,
          identity,
        );
      }
      throw error;
    }

    const responseHash = structuralHashOfCanonicalText(completion.content);

    // RULE 4: a truncated answer is refused, never continued on another route.
    //
    // Every spelling providers actually use, not just the OpenAI one: a guard
    // written against a single string literal silently accepts `MAX_TOKENS` and
    // `content_filter` as complete answers, and a half-written reading that
    // happens to parse is the worst possible thing to let through.
    if (isIncompleteFinishReason(completion.finishReason)) {
      attempts.push({
        order: route.order,
        routeId: route.routeId,
        model: completion.model,
        outcome: 'content_rejected',
        errorCode: 'PROVIDER_OUTPUT_TRUNCATED',
        failureDetailCode: null,
        httpStatus: 200,
        failoverAuthorized: false,
        usage: completion.usage,
        responseId: completion.responseId,
        responseHash,
        finishReason: completion.finishReason,
        reportedCost: completion.reportedCost,
      });
      throw new NarrativeProviderError(
        'PROVIDER_OUTPUT_SCHEMA_INVALID',
        `route "${route.routeId}" stopped at the token limit; a truncated reading is refused and is never continued on another provider`,
        attempts,
        identity,
      );
    }

    // RULE 3: a content failure ends the run. It is recorded as an attempt so
    // the evidence shows the route answered and WHAT was wrong with it.
    let providerOutput: NarrativeProviderOutput;
    try {
      providerOutput = toProviderOutput(
        parseNarrativeDraft(completion.content),
        providerIdFor(route),
        prompt.briefStructuralHash,
      );
    } catch (error) {
      attempts.push({
        order: route.order,
        routeId: route.routeId,
        model: completion.model,
        outcome: 'content_rejected',
        errorCode: error instanceof NarrativeProviderError ? error.code : 'PROVIDER_OUTPUT_NOT_JSON',
        failureDetailCode: null,
        httpStatus: 200,
        failoverAuthorized: false,
        usage: completion.usage,
        responseId: completion.responseId,
        responseHash,
        finishReason: completion.finishReason,
        reportedCost: completion.reportedCost,
      });
      if (error instanceof NarrativeProviderError) {
        // Re-raised carrying the attempt ledger. The parser that threw the
        // original has no idea a route history exists, and a refusal is exactly
        // the run whose history a reviewer needs.
        throw new NarrativeProviderError(error.code, error.message, attempts, identity);
      }
      throw error;
    }

    attempts.push({
      order: route.order,
      routeId: route.routeId,
      model: completion.model,
      outcome: 'accepted',
      errorCode: null,
      failureDetailCode: null,
      httpStatus: 200,
      failoverAuthorized: false,
      usage: completion.usage,
      responseId: completion.responseId,
      responseHash,
      finishReason: completion.finishReason,
      reportedCost: completion.reportedCost,
    });

    return {
      providerOutput,
      prompt,
      acceptedRouteId: route.routeId,
      acceptedModel: completion.model,
      attempts,
    };
  }

  throw new NarrativeProviderError(
    'PROVIDER_ALL_ROUTES_EXHAUSTED',
    `every eligible route failed with a transient availability failure: ${attempts
      .map((attempt) => `${attempt.routeId}=${attempt.errorCode ?? 'unknown'}`)
      .join(', ')}`,
    attempts,
    identity,
  );
}
