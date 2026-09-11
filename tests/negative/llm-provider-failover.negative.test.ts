import { describe, expect, it } from 'vitest';

import { generateNarrativeFromPlan } from '../../src/adapters/llm/llm-narrative-provider.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import { NarrativeProviderError } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildNarrativePrompt } from '../../src/application/interpretation/prompt-policy.js';
import { structuralHashOfCanonicalText } from '../../src/domain/structural-hash.js';
import {
  FIXTURE_LLM_ENV,
  answerAsProviderText,
  completionBody,
  fakeTransport,
  validKnownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type {
  FakeTransport,
  RecordedRequest,
  ScriptedReply,
} from '../support/llmNarrativeFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B AC5 + AC6 — what failover is allowed to do, and what it is not.
 *
 * A multi-provider fallback chain is the easiest place in this slice to build
 * something that looks like resilience and behaves like provider shopping. The
 * two are separated by one question: WHAT made the run move on. This file
 * answers it mechanically, because the difference is invisible in a passing
 * end-to-end run — a reading obtained by asking four providers until one wrote
 * something acceptable is indistinguishable, from the outside, from a reading
 * obtained after two rate limits.
 *
 * FOUR PROPERTIES ARE PROVEN HERE, each against recorded bytes rather than
 * against the adapter's own account of itself:
 *
 *  AC5.a THE SAME IMMUTABLE BRIEF REACHES EVERY ROUTE. The assertion compares
 *        the `messages` array the fake transport RECORDED for route 1 with the
 *        one it recorded for the next route. A claim that the prompt was built
 *        once is not evidence; two identical recorded request bodies are. The
 *        recorded messages are additionally compared against the prompt built
 *        independently in this test from the same brief, so "identical" cannot
 *        be satisfied by two copies of something else.
 *
 *  AC5.b FAILOVER IS ONLY FOR TRANSIENT TECHNICAL FAILURES, and every refusal
 *        that is not transient costs EXACTLY ONE REQUEST. That request count is
 *        the whole assertion: an adapter that fails closed and an adapter that
 *        quietly tried three more providers before giving up raise the same
 *        error. Only the transport knows which happened.
 *
 *  AC6   A CONTENT FAILURE NEVER TRIGGERS PROVIDER SHOPPING. Every content
 *        test below scripts a PERFECTLY VALID answer as the second reply. If
 *        the adapter advanced, it would succeed — and the test would see a
 *        resolved run instead of a refusal. The fallback answer sitting there
 *        unread is what makes `requests.length === 1` mean something.
 *
 *  AC5.c THE COST CAP IS A PROPERTY OF EVERY ATTEMPT, not only of the accepted
 *        one, and a plan with no eligible route refuses BEFORE any request.
 *
 * Every negative case starts from the verified baseline in
 * `tests/support/llmNarrativeFixture.ts` — `validKnownTimeAnswer()`, which is
 * asserted elsewhere to pass the structural gate and the semantic QA — and
 * changes exactly one thing: the HTTP status, the `finish_reason`, or the
 * answer text. Nothing here needs a network, a credential or a model.
 *
 * A NOTE ON THE FIXTURE'S DELIBERATE GAP: `FIXTURE_LLM_ENV` configures all four
 * approved routes but gives `gemini` a model id with no zero-price marker, so
 * the cost gate refuses it. That makes "the NEXT ELIGIBLE route" a different
 * thing from "the next route", which is exactly the case a failover test should
 * be run against: route 1 must fail over to route 3, never to route 2.
 */

const CHAIN = buildNarrativeChain(knownTimeModel());

/** The one prompt, built here independently of the adapter, from the one brief. */
const PROMPT = buildNarrativePrompt(CHAIN.brief);

const PLAN = buildLlmRoutePlan(FIXTURE_LLM_ENV);

/** The verified-good answer, as a provider would put it on the wire. */
const VALID_ANSWER_TEXT = answerAsProviderText(validKnownTimeAnswer());

/** Re-derived here, so the attempt record's hash is checked and not copied. */
const VALID_ANSWER_HASH = structuralHashOfCanonicalText(VALID_ANSWER_TEXT);

/** The endpoints of the three ELIGIBLE routes, in the Product Owner's order. */
const ROUTE_1_URL = 'https://provider.invalid/one/v1/chat/completions';
const ROUTE_3_URL = 'https://provider.invalid/three/v1/chat/completions';
const ROUTE_4_URL = 'https://provider.invalid/four/v1/chat/completions';

/**
 * The base URL of the route the COST GATE refused.
 *
 * No request may ever carry it. Asserted as a substring rather than as a full
 * endpoint so that a call to any path under that provider is caught, not just a
 * call to the one path the adapter happens to use today.
 */
const REFUSED_ROUTE_URL_FRAGMENT = 'provider.invalid/two/';

function validReply(): ScriptedReply {
  return { status: 200, body: completionBody(VALID_ANSWER_TEXT) };
}

function statusReply(status: number): ScriptedReply {
  // A body a real provider would send with an error status. Never read by the
  // adapter — the status alone decides — and present so the fixture is not
  // quietly testing "no body" as well as "this status".
  return { status, body: { error: { message: 'scripted provider failure' } } };
}

/** The valid answer with exactly ONE field changed. */
function replyWithContent(content: string): ScriptedReply {
  return { status: 200, body: completionBody(content) };
}

/** The valid answer, unchanged, stopped at the token limit. */
function truncatedReply(): ScriptedReply {
  return {
    status: 200,
    body: completionBody(VALID_ANSWER_TEXT, {
      choices: [{ message: { content: VALID_ANSWER_TEXT }, finish_reason: 'length' }],
    }),
  };
}

/**
 * The request at `index`, or a loud failure.
 *
 * `noUncheckedIndexedAccess` makes the index access optional; throwing here
 * rather than asserting non-null keeps a missing request an explicit test
 * failure that names what was missing.
 */
function requestAt(transport: FakeTransport, index: number): RecordedRequest {
  const request = transport.requests[index];
  if (request === undefined) {
    throw new Error(
      `expected a recorded request at index ${String(index)}, but the transport recorded ${String(
        transport.requests.length,
      )}`,
    );
  }
  return request;
}

function urlsOf(transport: FakeTransport): string[] {
  return transport.requests.map((request) => request.url);
}

/** The chat messages exactly as they went onto the wire. */
function messagesOf(request: RecordedRequest): unknown {
  return request.body['messages'];
}

/** Every field of the request body except the route's own model id. */
function bodyWithoutModel(request: RecordedRequest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request.body).filter(([key]) => key !== 'model'));
}

/**
 * Runs the adapter and returns the refusal it raised.
 *
 * A run that RESOLVES fails the test with a message naming that, because a
 * resolved run is the precise defect these tests exist to catch: the adapter
 * kept asking until someone answered.
 */
async function refusalOf(run: Promise<unknown>): Promise<NarrativeProviderError> {
  try {
    await run;
  } catch (error: unknown) {
    if (error instanceof NarrativeProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error('the run resolved, but the contract requires it to be refused');
}

describe('ETBZ-25B F0: the premise these tests rest on', () => {
  it('offers three ELIGIBLE routes and refuses the one whose model is not marked no-charge', () => {
    // Stated first because every request-count assertion below is read against
    // it: "one request" is meaningful only because three routes were available,
    // and "the next eligible route" is meaningful only because the next route
    // in the Product Owner's order was refused by the cost gate.
    expect(PLAN.routes.map((route) => route.routeId)).toEqual([
      'tokenrouter',
      'opencode',
      'openrouter',
    ]);
    expect(PLAN.routes.map((route) => route.order)).toEqual([1, 3, 4]);
    expect(
      PLAN.eligibility.filter((entry) => !entry.eligible).map((entry) => ({
        routeId: entry.routeId,
        reason: entry.ineligibleReason,
      })),
    ).toEqual([{ routeId: 'gemini', reason: 'model_not_marked_no_charge' }]);
  });

  it('pins the cost cap at zero with no paid path in the plan the runs below use', () => {
    expect(PLAN.approvedCostCapEur).toBe(0);
    expect(PLAN.allowPaid).toBe(false);
  });

  it('addresses each eligible route at the endpoint this file asserts against', () => {
    expect(PLAN.routes.map((route) => `${route.baseUrl}/chat/completions`)).toEqual([
      ROUTE_1_URL,
      ROUTE_3_URL,
      ROUTE_4_URL,
    ]);
  });
});

describe('ETBZ-25B AC5 F1: a transient failure advances to the next ELIGIBLE route with the same brief', () => {
  it('accepts route 1 and stops there when route 1 answers (positive control)', async () => {
    // The control for every "exactly one request" assertion in this file: one
    // request here is caused by SUCCESS, and the transport would gladly have
    // served the second scripted reply.
    const transport = fakeTransport([validReply(), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.acceptedRouteId).toBe('tokenrouter');
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL]);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(['accepted']);
  });

  it('moves a 429 to the next ELIGIBLE route, never to the route the cost gate refused', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    // Route 2 is the next route; route 3 is the next ELIGIBLE route. The
    // recorded URLs are what distinguish the two readings of the contract.
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL, ROUTE_3_URL]);
    expect(urlsOf(transport).some((url) => url.includes(REFUSED_ROUTE_URL_FRAGMENT))).toBe(false);
    expect(result.acceptedRouteId).toBe('opencode');
    expect(result.attempts.map((attempt) => attempt.order)).toEqual([1, 3]);
  });

  it('hands the second route a byte-identical message array', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    const first = requestAt(transport, 0);
    const second = requestAt(transport, 1);
    expect(messagesOf(second)).toEqual(messagesOf(first));
    // Structural equality is not quite the claim. "Byte-identical" is, so the
    // serialised forms are compared too: a re-ordered or re-encoded prompt
    // would survive toEqual and fail here.
    expect(JSON.stringify(messagesOf(second))).toBe(JSON.stringify(messagesOf(first)));
  });

  it('sends the ONE prompt built from the ONE brief, not merely two copies of something', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    // Built in this test from `CHAIN.brief`, independently of the adapter. The
    // two recorded bodies are identical to each other AND to this — which is
    // what rules out "identical, but not the brief's prompt".
    const expectedMessages = [
      { role: 'system', content: PROMPT.system },
      { role: 'user', content: PROMPT.user },
    ];
    expect(messagesOf(requestAt(transport, 0))).toEqual(expectedMessages);
    expect(messagesOf(requestAt(transport, 1))).toEqual(expectedMessages);
  });

  it('changes nothing between the two requests except the route’s own model id', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    const first = requestAt(transport, 0);
    const second = requestAt(transport, 1);
    // The strongest form of the immutability claim: not only the prompt, but
    // max_tokens, temperature and the JSON-mode hint are the same. The model id
    // is the only field that MUST differ, because it identifies the route.
    expect(bodyWithoutModel(second)).toEqual(bodyWithoutModel(first));
    expect(first.body['model']).toBe('vendor/model-a-free');
    expect(second.body['model']).toBe('model-c-free');
  });

  it('states one and the same briefStructuralHash for the whole run', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.prompt.briefStructuralHash).toBe(CHAIN.brief.structuralHash);
    expect(result.prompt.briefStructuralHash).toBe(PROMPT.briefStructuralHash);
    // The value that reaches the report carries the same binding, so the
    // failover cannot detach the answer from the brief it was written for.
    expect(result.providerOutput.briefStructuralHash).toBe(CHAIN.brief.structuralHash);
    expect(result.prompt.briefStructuralHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records the 429 as an authorised transient failure and the answer as accepted', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.attempts).toEqual([
      {
        order: 1,
        routeId: 'tokenrouter',
        // The route's CONFIGURED model: no provider answered, so there is no
        // provider-reported model to record.
        model: 'vendor/model-a-free',
        outcome: 'transient_failure',
        errorCode: 'LLM_RATE_LIMITED',
        failureDetailCode: 'HTTP_STATUS_NOT_OK',
        httpStatus: 429,
        failoverAuthorized: true,
        usage: null,
        responseId: null,
        responseHash: null,
        finishReason: null,
        // The 429 attempt never received a body, so no provider reported
        // anything about cost. Null, never zero.
        reportedCost: null,
      },
      {
        order: 3,
        routeId: 'opencode',
        // The model the PROVIDER says answered, which is deliberately not the
        // configured `model-c-free`: the evidence records what happened.
        model: 'fixture-model-free',
        outcome: 'accepted',
        errorCode: null,
        failureDetailCode: null,
        httpStatus: 200,
        failoverAuthorized: false,
        usage: { promptTokens: 1200, completionTokens: 800, totalTokens: 2000 },
        responseId: 'cmpl-fixture',
        responseHash: VALID_ANSWER_HASH,
        finishReason: 'stop',
        // The fixture answers with an OpenAI-shaped usage block that carries
        // token counts and no cost field — like three of the four real routes.
        // "Not reported" is the honest record of that.
        reportedCost: null,
      },
    ]);
  });

  it('authorises failover on the 429 attempt and on no other attempt of the run', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.attempts.map((attempt) => attempt.failoverAuthorized)).toEqual([true, false]);
  });

  it('presents each route its own credential, so the second call is a route change', async () => {
    const transport = fakeTransport([statusReply(429), validReply()]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    // Fixture values only. A retry of route 1 would repeat the first header;
    // these differ, which is independent evidence that a DIFFERENT approved
    // route answered rather than the same one being asked twice.
    expect(requestAt(transport, 0).authorization).toBe('Bearer fixture-key-one');
    expect(requestAt(transport, 1).authorization).toBe('Bearer fixture-key-three');
  });

  it('fails over a connection failure too, since it is transient by the same rule', async () => {
    const transport = fakeTransport([
      { status: 0, body: null, throws: new TypeError('fetch failed') },
      validReply(),
    ]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.acceptedRouteId).toBe('opencode');
    expect(result.attempts[0]?.errorCode).toBe('LLM_NETWORK_ERROR');
    expect(result.attempts[0]?.outcome).toBe('transient_failure');
    // No status: nothing answered. The record says so rather than inventing one.
    expect(result.attempts[0]?.httpStatus).toBe(null);
    expect(messagesOf(requestAt(transport, 1))).toEqual(messagesOf(requestAt(transport, 0)));
  });
});

describe('ETBZ-25B AC5 F2: a terminal transport failure fails closed after exactly ONE request', () => {
  it('does make a second request when the first failure IS transient (positive control)', async () => {
    // The control that gives every `toHaveLength(1)` below its meaning: with
    // the identical two-reply script, an authorised failover consumes reply
    // two. A single request in the terminal cases is therefore the adapter's
    // decision, not the script running dry.
    const transport = fakeTransport([statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(transport.requests).toHaveLength(2);
    expect(result.acceptedRouteId).toBe('opencode');
  });

  it('refuses a rejected credential (401) without asking another provider', async () => {
    const transport = fakeTransport([statusReply(401), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    // The crux: a valid answer was one route away and was never requested.
    expect(transport.requests).toHaveLength(1);
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL]);
    // The classification, not merely the outcome, is what stopped the run.
    expect(error.message).toContain('LLM_AUTH_FAILED');
    expect(error.message).toContain('failover is not authorised');
  });

  it('refuses a vanished model (404) without asking another provider', async () => {
    const transport = fakeTransport([statusReply(404), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    expect(transport.requests).toHaveLength(1);
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL]);
    // A 404 reads like an availability problem and is a configuration fact.
    // Moving on would hide exactly the drift this refusal exists to surface.
    expect(error.message).toContain('LLM_ROUTE_REJECTED');
  });

  it.each([
    [400, 'LLM_ROUTE_REJECTED'],
    [403, 'LLM_AUTH_FAILED'],
    [422, 'LLM_ROUTE_REJECTED'],
  ] as const)('refuses HTTP %i as %s after exactly one request', async (status, code) => {
    const transport = fakeTransport([statusReply(status), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    expect(error.message).toContain(code);
    expect(transport.requests).toHaveLength(1);
  });

  it('treats an UNCLASSIFIED status as terminal, so new provider behaviour earns no failover', async () => {
    // 418 is in no list. The allowlist reading of the contract makes it
    // terminal; a denylist reading would let any unforeseen status open the
    // door to provider shopping.
    const transport = fakeTransport([statusReply(418), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    expect(error.message).toContain('LLM_CONTRACT_ERROR');
    expect(transport.requests).toHaveLength(1);
  });

  it('refuses an EMPTY answer as a contract failure, not as an availability failure', async () => {
    // The route responded; it simply said nothing usable. Classing that
    // transient would let an empty answer trigger provider shopping.
    const transport = fakeTransport([replyWithContent(''), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    expect(error.message).toContain('LLM_CONTRACT_ERROR');
    expect(transport.requests).toHaveLength(1);
  });

  it.each([
    [408, 'LLM_SERVER_ERROR'],
    [429, 'LLM_RATE_LIMITED'],
    [500, 'LLM_SERVER_ERROR'],
    [502, 'LLM_SERVER_ERROR'],
    [503, 'LLM_SERVER_ERROR'],
    [504, 'LLM_SERVER_ERROR'],
  ] as const)('does advance past HTTP %i, recorded as %s', async (status, code) => {
    // The other half of the line: the enumerated transient statuses, each
    // proven to advance with the same script shape the terminal cases refuse.
    const transport = fakeTransport([statusReply(status), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(transport.requests).toHaveLength(2);
    expect(result.acceptedRouteId).toBe('opencode');
    expect(result.attempts[0]?.errorCode).toBe(code);
    expect(result.attempts[0]?.failoverAuthorized).toBe(true);
  });
});

describe('ETBZ-25B AC6 F3: a CONTENT failure never triggers provider shopping', () => {
  it('consumes the second scripted answer when advancing IS authorised (positive control)', async () => {
    // Every content test below scripts the same second reply: a perfectly
    // valid answer. This control proves that reply is reachable, so an unread
    // second reply in the refusals is a decision and not an empty script.
    const transport = fakeTransport([statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(transport.requests).toHaveLength(2);
    expect(result.acceptedRouteId).toBe('opencode');
  });

  it('refuses prose instead of JSON, with the fallback answer left unread', async () => {
    const transport = fakeTransport([
      replyWithContent('Gern! Hier ist deine Deutung in Prosa, ohne JSON.'),
      validReply(),
    ]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_OUTPUT_NOT_JSON');
    expect(transport.requests).toHaveLength(1);
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL]);
  });

  it('refuses JSON of the wrong shape, with the fallback answer left unread', async () => {
    // Exactly one thing changed against the baseline: `sections` is a string
    // instead of the array of sections the schema requires.
    const transport = fakeTransport([
      replyWithContent(JSON.stringify({ sections: 'vier Abschnitte' })),
      validReply(),
    ]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
    expect(transport.requests).toHaveLength(1);
  });

  it('refuses an extra top-level key the contract does not define', async () => {
    // The baseline answer with ONE addition. A model inventing a channel is a
    // contract failure, and it is still not a reason to ask someone else.
    const withExtraKey = JSON.stringify({
      ...validKnownTimeAnswer(),
      confidence: 'high',
    });
    const transport = fakeTransport([replyWithContent(withExtraKey), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
    expect(error.message).toContain('unrecognized_keys');
    expect(transport.requests).toHaveLength(1);
  });

  it('refuses a TRUNCATED answer instead of continuing it on another provider', async () => {
    // The baseline answer, unchanged, with `finish_reason: "length"` — the one
    // mutation. Continuing a cut-off reading elsewhere would blend two models'
    // output into one artefact, which the contract forbids outright.
    const transport = fakeTransport([truncatedReply(), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
    expect(error.message).toContain('stopped at the token limit');
    expect(error.message).toContain('never continued on another provider');
    expect(transport.requests).toHaveLength(1);
  });

  it('accepts the SAME answer when only the finish reason is ordinary', async () => {
    // The counterpart of the case above, and the proof that the truncation
    // refusal is about `finish_reason` alone: identical content, one field
    // back to "stop", and the run succeeds on the first route.
    const transport = fakeTransport([validReply(), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.attempts[0]?.finishReason).toBe('stop');
    expect(result.acceptedRouteId).toBe('tokenrouter');
    expect(transport.requests).toHaveLength(1);
  });

  it('accepts a fenced answer, so the refusals above are about content and not formatting', async () => {
    // A model wrapping its JSON in a code fence has followed the contract in
    // every way that matters. Refusing it would spend the run's one shot on a
    // formatting tic — and would make the refusals above look stricter than
    // the rule they enforce.
    const fenced = `\`\`\`json\n${VALID_ANSWER_TEXT}\n\`\`\``;
    const transport = fakeTransport([replyWithContent(fenced), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.acceptedRouteId).toBe('tokenrouter');
    expect(transport.requests).toHaveLength(1);
  });
});

describe('ETBZ-25B AC5 F4: when every eligible route fails transiently the run ends exhausted', () => {
  it('accepts the LAST eligible route when only the earlier ones fail (positive control)', async () => {
    const transport = fakeTransport([statusReply(429), statusReply(429), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.acceptedRouteId).toBe('openrouter');
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL, ROUTE_3_URL, ROUTE_4_URL]);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      'transient_failure',
      'transient_failure',
      'accepted',
    ]);
  });

  it('ends with PROVIDER_ALL_ROUTES_EXHAUSTED when every eligible route is rate limited', async () => {
    // One scripted reply, replayed: every route answers 429.
    const transport = fakeTransport([statusReply(429)]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_ALL_ROUTES_EXHAUSTED');
    expect(transport.requests).toHaveLength(PLAN.routes.length);
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL, ROUTE_3_URL, ROUTE_4_URL]);
  });

  it('leaves one transient attempt record per eligible route and none for the refused route', async () => {
    const transport = fakeTransport([statusReply(429)]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    // `NarrativeProviderError` carries no `attempts` array, so the attempt
    // history of an EXHAUSTED run is observable only through the message the
    // adapter renders from it. That message is built by mapping the attempts,
    // so requiring it to enumerate exactly the three eligible routes with the
    // transient code is the available reading of the array's contents — and
    // the request count above confirms the arity independently.
    expect(error.message).toContain('tokenrouter=LLM_RATE_LIMITED');
    expect(error.message).toContain('opencode=LLM_RATE_LIMITED');
    expect(error.message).toContain('openrouter=LLM_RATE_LIMITED');
    expect(error.message).not.toContain('gemini');
    expect(error.message).toContain('transient availability failure');
  });

  it('asks each route once and never re-tries a route it already used', async () => {
    const transport = fakeTransport([statusReply(429)]);

    await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    // Failover is not a retry loop: three requests, three distinct endpoints.
    expect(new Set(urlsOf(transport)).size).toBe(3);
  });

  it('gives all three exhausted attempts the identical immutable brief', async () => {
    const transport = fakeTransport([statusReply(429)]);

    await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    const expectedMessages = [
      { role: 'system', content: PROMPT.system },
      { role: 'user', content: PROMPT.user },
    ];
    for (let index = 0; index < 3; index += 1) {
      expect(messagesOf(requestAt(transport, index)), `request ${String(index)}`).toEqual(
        expectedMessages,
      );
    }
  });

  it('stops on the first TERMINAL failure even in the middle of a transient chain', async () => {
    // Route 1 is rate limited (advance), route 3 rejects the credential (stop).
    // A valid answer waits on route 4 and must never be requested: one
    // authorised failover does not license the next one.
    const transport = fakeTransport([statusReply(429), statusReply(401), validReply()]);

    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, PLAN, transport));

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    expect(urlsOf(transport)).toEqual([ROUTE_1_URL, ROUTE_3_URL]);
  });
});

describe('ETBZ-25B AC5 F5: a plan with no eligible route refuses before any request', () => {
  it('refuses an unconfigured environment with PROVIDER_NO_ELIGIBLE_ROUTE', async () => {
    const emptyPlan = buildLlmRoutePlan({ LLM_ALLOW_PAID: 'false', LLM_PAID_COST_CAP_USD: '0' });
    const transport = fakeTransport([validReply()]);

    expect(emptyPlan.routes).toHaveLength(0);
    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, emptyPlan, transport));

    expect(error.code).toBe('PROVIDER_NO_ELIGIBLE_ROUTE');
    // Not a single call was attempted: the refusal happens before the loop, so
    // an unconfigured deployment cannot reach a provider at all.
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a fully configured environment whose models are not marked no-charge', async () => {
    // The same four routes as the working fixture, with exactly one thing
    // changed per route: the zero-price marker is gone from the model id.
    const paidPlan = buildLlmRoutePlan({
      ...FIXTURE_LLM_ENV,
      TOKENROUTER_MODEL: 'vendor/model-a',
      OPENCODE_PRIMARY_MODEL: 'model-c',
      OPENROUTER_MODEL: 'vendor/model-d',
    });
    const transport = fakeTransport([validReply()]);

    expect(paidPlan.routes).toHaveLength(0);
    const error = await refusalOf(generateNarrativeFromPlan(CHAIN.brief, paidPlan, transport));

    expect(error.code).toBe('PROVIDER_NO_ELIGIBLE_ROUTE');
    expect(error.message).toContain('model_not_marked_no_charge');
    expect(error.message).toContain('0.00 EUR');
    expect(transport.requests).toHaveLength(0);
  });

  it('runs as soon as ONE eligible route exists in the same shape of environment (positive control)', async () => {
    const singleRoutePlan = buildLlmRoutePlan({
      OPENROUTER_BASE_URL: 'https://provider.invalid/four/v1',
      OPENROUTER_MODEL: 'vendor/model-d:free',
      OPENROUTER_API_KEY: 'fixture-key-four',
    });
    const transport = fakeTransport([validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, singleRoutePlan, transport);

    // So the two refusals above are caused by the emptiness of the plan, not by
    // anything else in the call.
    expect(singleRoutePlan.routes).toHaveLength(1);
    expect(result.acceptedRouteId).toBe('openrouter');
    expect(urlsOf(transport)).toEqual([ROUTE_4_URL]);
  });
});

describe('ETBZ-25B AC5 F6: every attempt records what the provider reported, not a zero', () => {
  it('records no observed cost on the single attempt of an accepted run', async () => {
    const transport = fakeTransport([validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    // The arity is asserted first so `every` below cannot pass vacuously over
    // an empty array.
    expect(result.attempts).toHaveLength(1);
    // NOT `toEqual([0])`. The provider reported no cost, and a zero here would
    // be a measurement nobody took — the precise confusion this field was split
    // apart to end. The 0.00 EUR cap is POLICY and lives on the route plan.
    expect(result.attempts.map((attempt) => attempt.reportedCost)).toEqual([null]);
  });

  it('records no observed cost on the FAILED attempts of a failover run either', async () => {
    const transport = fakeTransport([statusReply(429), statusReply(503), validReply()]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      'transient_failure',
      'transient_failure',
      'accepted',
    ]);
    expect(result.attempts.map((attempt) => attempt.reportedCost)).toEqual([null, null, null]);
    // Stated as a separate property so a future fixture that DOES report a cost
    // fails loudly here rather than quietly widening what "free" means.
    expect(result.attempts.every((attempt) => attempt.reportedCost === null)).toBe(true);
  });
});
