/**
 * ETBZ-25B — a PROVIDER REFUSAL leaves a complete, sanitized record.
 *
 * Measured on candidate 54d7e30: one TokenRouter-only live run took about 700
 * seconds and ended HTTP 200 / `LLM_CONTRACT_ERROR` / no message content. The
 * harness printed the attempt ledger and filed nothing. The ledger itself had
 * already dropped the finish reason and usage the stream reported, and most
 * transport refusals shared that one error code, so "which failure was it?"
 * had no answer anywhere. This file pins the repair:
 *
 *   R1  every transport refusal names one member of a CLOSED detail set, and
 *       the set has no member that no refusal produces;
 *   R2  STREAM_NO_MESSAGE_CONTENT stays distinguishable from STREAM_NO_BODY,
 *       end to end, into the filed record;
 *   R3  the record is bound to candidate SHA, brief hash and prompt identity;
 *   R4  nothing that did not run is reported as having run;
 *   R5  finish reason, usage and reported cost survive when observed, and stay
 *       null when not;
 *   R6  credentials, raw provider text and reasoning text cannot reach it;
 *   R7  EVERY refusal that observed something files it, no record implies a
 *       provider request that never happened, and a cost reported inside an
 *       in-band error frame still fails the cap.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_NARRATIVE_OPTIONS,
  generateNarrativeFromPlan,
} from '../../src/adapters/llm/llm-narrative-provider.js';
import { LlmProviderError, requestChatCompletion } from '../../src/adapters/llm/openai-compatible-client.js';
import type { LlmChatRequest, Transport } from '../../src/adapters/llm/openai-compatible-client.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import type { LlmRouteConfig, LlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import {
  NarrativeProviderError,
  PROVIDER_FAILURE_DETAIL_CODES,
} from '../../src/application/interpretation/errors.js';
import type { ProviderFailureDetailCode } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import {
  EvidenceLeakError,
  ObservedCostExceedsCapError,
  RefusalEvidenceNotBindableError,
  assertEvidenceSanitized,
  assertObservedCostWithinCap,
  buildProviderRefusalEvidence,
} from '../../src/application/interpretation/narrative-evidence.js';
import type {
  BuildProviderRefusalEvidenceInput,
  EvidenceRouteVerdict,
  NarrativeRunEvidence,
} from '../../src/application/interpretation/narrative-evidence.js';
import {
  INTERPRETATION_POLICY_VERSION,
  PROMPT_VERSION,
  buildNarrativePrompt,
} from '../../src/application/interpretation/prompt-policy.js';
import { NARRATIVE_QA_VERSION } from '../../src/application/interpretation/semantic-qa.js';
import { structuralHashOfCanonicalText } from '../../src/domain/structural-hash.js';
import { FIXTURE_LLM_ENV, asEventStream, completionBody } from '../support/llmNarrativeFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

// ---------------------------------------------------------------------------
// The run shape: TokenRouter ONLY, as the authorised live run is.
// ---------------------------------------------------------------------------

const MODEL = knownTimeModel();
const CHAIN = buildNarrativeChain(MODEL);
const PROMPT = buildNarrativePrompt(CHAIN.brief);

const TOKENROUTER_ONLY_ENV: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FIXTURE_LLM_ENV).filter(([name]) => name.startsWith('TOKENROUTER_')),
);

const PLAN = buildLlmRoutePlan(TOKENROUTER_ONLY_ENV, 5_000);

function onlyRoute(plan: LlmRoutePlan): LlmRouteConfig {
  const [route] = plan.routes;
  if (route === undefined || plan.routes.length !== 1) {
    throw new Error('fixture defect: the TokenRouter-only plan must hold exactly one route');
  }
  return route;
}

const ROUTE = onlyRoute(PLAN);
/** Short deadline, for the two timeout shapes only. */
const FAST_ROUTE = onlyRoute(buildLlmRoutePlan(TOKENROUTER_ONLY_ENV, 60));

/** A plausible commit id with no credential shape. */
const CANDIDATE_SHA = 'c0ffee'.repeat(6) + 'c0ff';

const STREAMED: LlmChatRequest = {
  system: 's',
  user: 'u',
  maxTokens: 64,
  temperature: 0,
  jsonObjectMode: true,
  stream: true,
};
const BUFFERED: LlmChatRequest = { ...STREAMED, stream: false };

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

/** One SSE body from the given frames, each serialised unless already a string. */
function sse(...frames: readonly unknown[]): string {
  return (
    frames
      .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
      .join('') + 'data: [DONE]\n\n'
  );
}

function serving(body: string | null, status = 200): Transport {
  return {
    fetch(): Promise<Response> {
      return Promise.resolve(new Response(body, { status }));
    },
  };
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** Never answers; rejects only when the route deadline aborts the request. */
function silent(): Transport {
  return {
    fetch(_url: string, init: RequestInit): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(abortError());
        });
      });
    },
  };
}

const FIRST_FRAME = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n');

/** Answers 200, streams one frame, then stalls until the deadline aborts it. */
function stalling(): Transport {
  return {
    fetch(_url: string, init: RequestInit): Promise<Response> {
      const signal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(FIRST_FRAME);
          signal?.addEventListener('abort', () => {
            controller.error(abortError());
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  };
}

/** Answers 200, streams one frame, then the connection breaks. */
function breaking(): Transport {
  return {
    fetch(): Promise<Response> {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(FIRST_FRAME);
          controller.error(new Error('connection reset by peer'));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  };
}

/** The stream a reasoning model sends when it spends its budget thinking. */
const NO_CONTENT_STREAM = sse(
  { id: 'x', choices: [{ delta: {}, finish_reason: 'length' }] },
  {
    id: 'x',
    choices: [],
    usage: {
      prompt_tokens: 5000,
      completion_tokens: 32000,
      total_tokens: 37000,
      completion_tokens_details: { reasoning_tokens: 32000 },
    },
  },
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function transportRefusal(promise: Promise<unknown>): Promise<LlmProviderError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(caught instanceof LlmProviderError)) {
    throw new Error(`expected an LlmProviderError, got ${String(caught)}`);
  }
  return caught;
}

async function providerRefusal(
  transport: Transport,
  plan: LlmRoutePlan = PLAN,
): Promise<NarrativeProviderError> {
  const caught = await generateNarrativeFromPlan(CHAIN.brief, plan, transport, {
    ...DEFAULT_LLM_NARRATIVE_OPTIONS,
    reasoningEffort: 'low',
  }).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(caught instanceof NarrativeProviderError)) {
    throw new Error(`expected a NarrativeProviderError, got ${String(caught)}`);
  }
  return caught;
}

function verdictsOf(plan: LlmRoutePlan): readonly EvidenceRouteVerdict[] {
  return plan.eligibility.map((entry) => ({
    routeId: entry.routeId,
    order: entry.order,
    eligible: entry.eligible,
    ineligibleReason: entry.ineligibleReason,
    baseUrl: entry.baseUrl,
    model: entry.model,
    noChargeBasis: entry.noChargeBasis,
    statement: entry.statement,
  }));
}

const COST_BASIS = 'Not observed unless an attempt below reports a per-call cost.';

function refusalRecord(
  error: NarrativeProviderError,
  overrides: Partial<BuildProviderRefusalEvidenceInput> = {},
): NarrativeRunEvidence {
  return buildProviderRefusalEvidence({
    candidateSha: CANDIDATE_SHA,
    briefStructuralHash: CHAIN.brief.structuralHash,
    qaVersion: NARRATIVE_QA_VERSION,
    routeVerdicts: verdictsOf(PLAN),
    requestedReasoningEffort: 'low',
    observedCostBasis: COST_BASIS,
    refusal: error,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// R1 — a closed detail set, every member reachable.
// ---------------------------------------------------------------------------

interface DetailScenario {
  readonly expected: ProviderFailureDetailCode;
  readonly route: LlmRouteConfig;
  readonly request: LlmChatRequest;
  readonly transport: () => Transport;
}

const SCENARIOS: readonly DetailScenario[] = [
  { expected: 'REQUEST_TIMEOUT', route: FAST_ROUTE, request: STREAMED, transport: silent },
  {
    expected: 'NETWORK_FAILURE',
    route: ROUTE,
    request: STREAMED,
    transport: () => ({ fetch: () => Promise.reject(new TypeError('fetch failed')) }),
  },
  {
    expected: 'HTTP_STATUS_NOT_OK',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving('{"error":{"message":"overloaded"}}', 503),
  },
  { expected: 'BUFFERED_BODY_NOT_JSON', route: ROUTE, request: BUFFERED, transport: () => serving('not json') },
  { expected: 'BUFFERED_BODY_NOT_OBJECT', route: ROUTE, request: BUFFERED, transport: () => serving('42') },
  {
    expected: 'BUFFERED_NO_CHOICES',
    route: ROUTE,
    request: BUFFERED,
    transport: () => serving(JSON.stringify({ id: 'x', choices: [] })),
  },
  {
    expected: 'BUFFERED_EMPTY_MESSAGE',
    route: ROUTE,
    request: BUFFERED,
    transport: () => serving(JSON.stringify(completionBody(''))),
  },
  { expected: 'STREAM_NO_BODY', route: ROUTE, request: STREAMED, transport: () => serving(null) },
  {
    expected: 'MALFORMED_SSE_CHUNK',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving('data: {not json\n\n'),
  },
  {
    expected: 'STREAM_CLOSED_MID_FRAME',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choi'),
  },
  {
    expected: 'IN_BAND_PROVIDER_ERROR',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving(sse({ error: { message: 'upstream failed' } })),
  },
  { expected: 'STREAM_TIMEOUT', route: FAST_ROUTE, request: STREAMED, transport: stalling },
  { expected: 'STREAM_INTERRUPTED', route: ROUTE, request: STREAMED, transport: breaking },
  {
    expected: 'STREAM_NO_MESSAGE_CONTENT',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving(NO_CONTENT_STREAM),
  },
];

describe('ETBZ-25B refusal R1: every transport refusal names one member of a closed set', () => {
  it.each(SCENARIOS)('raises $expected for its shape', async ({ expected, route, request, transport }) => {
    const error = await transportRefusal(requestChatCompletion(route, request, transport()));

    expect(error.detailCode).toBe(expected);
  });

  it('has no member that no refusal produces, and no refusal outside the set', () => {
    // Both directions. A code added to the set without a shape that raises it
    // fails here, and so does a scenario naming a code the set does not hold.
    expect(SCENARIOS.map((scenario) => scenario.expected).sort()).toEqual(
      [...PROVIDER_FAILURE_DETAIL_CODES].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// R2 — the two failures the last live run could not tell apart.
// ---------------------------------------------------------------------------

describe('ETBZ-25B refusal R2: STREAM_NO_MESSAGE_CONTENT stays distinct from STREAM_NO_BODY', () => {
  it('distinguishes them at the transport although both are terminal LLM_CONTRACT_ERROR', async () => {
    const noContent = await transportRefusal(
      requestChatCompletion(ROUTE, STREAMED, serving(NO_CONTENT_STREAM)),
    );
    const noBody = await transportRefusal(requestChatCompletion(ROUTE, STREAMED, serving(null)));

    expect([noContent.code, noBody.code]).toEqual(['LLM_CONTRACT_ERROR', 'LLM_CONTRACT_ERROR']);
    expect([noContent.failureClass, noBody.failureClass]).toEqual(['terminal', 'terminal']);
    expect([noContent.detailCode, noBody.detailCode]).toEqual([
      'STREAM_NO_MESSAGE_CONTENT',
      'STREAM_NO_BODY',
    ]);
  });

  it('files them apart in the refusal record', async () => {
    const records = [
      refusalRecord(await providerRefusal(serving(NO_CONTENT_STREAM))),
      refusalRecord(await providerRefusal(serving(null))),
    ];

    expect(records.map((record) => record.attempts[0]?.errorCode)).toEqual([
      'LLM_CONTRACT_ERROR',
      'LLM_CONTRACT_ERROR',
    ]);
    expect(records.map((record) => record.attempts[0]?.failureDetailCode)).toEqual([
      'STREAM_NO_MESSAGE_CONTENT',
      'STREAM_NO_BODY',
    ]);
    expect(records[0]?.structuralHash).not.toBe(records[1]?.structuralHash);
  });
});

// ---------------------------------------------------------------------------
// R3 — bound to the exact candidate, brief and prompt.
// ---------------------------------------------------------------------------

describe('ETBZ-25B refusal R3: the record is bound to candidate SHA, brief hash and prompt identity', () => {
  it('names the candidate, the brief and the exact prompt, re-derived independently', async () => {
    const error = await providerRefusal(serving(NO_CONTENT_STREAM));
    const record = refusalRecord(error);

    expect(error.code).toBe('PROVIDER_TERMINAL_FAILURE');
    expect(record.candidateSha).toBe(CANDIDATE_SHA);
    expect(record.briefStructuralHash).toBe(CHAIN.brief.structuralHash);
    expect(record.promptStructuralHash).toBe(PROMPT.promptStructuralHash);
    expect(record.promptVersion).toBe(PROMPT_VERSION);
    expect(record.policyVersion).toBe(INTERPRETATION_POLICY_VERSION);
    expect(record.qaVersion).toBe(NARRATIVE_QA_VERSION);
    expect(record.requestedReasoningEffort).toBe('low');
    expect(record.providerRefusalCode).toBe('PROVIDER_TERMINAL_FAILURE');
    // This slice does not touch the prompt; a refusal record naming another
    // version would be naming a candidate nobody built.
    expect(PROMPT_VERSION).toBe('etbz-25b.narrative-prompt.v3');
  });

  it('files the whole attempt, with its route, model and order', async () => {
    const record = refusalRecord(await providerRefusal(serving(NO_CONTENT_STREAM)));

    expect(record.attempts).toEqual([
      {
        order: 1,
        routeId: 'tokenrouter',
        model: ROUTE.model,
        outcome: 'terminal_failure',
        errorCode: 'LLM_CONTRACT_ERROR',
        failureDetailCode: 'STREAM_NO_MESSAGE_CONTENT',
        httpStatus: 200,
        failoverAuthorized: false,
        usage: { promptTokens: 5000, completionTokens: 32000, totalTokens: 37000 },
        responseId: null,
        responseHash: null,
        finishReason: 'length',
        reportedCost: null,
      },
    ]);
    expect(record.routeVerdicts.map((verdict) => [verdict.routeId, verdict.eligible])).toEqual([
      ['tokenrouter', true],
      ['gemini', false],
      ['opencode', false],
      ['openrouter', false],
    ]);
  });

  it('anchors the record in its own canonical text', async () => {
    const record = refusalRecord(await providerRefusal(serving(NO_CONTENT_STREAM)));

    expect(record.structuralHash).toBe(structuralHashOfCanonicalText(record.canonicalJson));
    expect(JSON.parse(record.canonicalJson)).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      briefStructuralHash: CHAIN.brief.structuralHash,
      promptStructuralHash: PROMPT.promptStructuralHash,
      providerRefusalCode: 'PROVIDER_TERMINAL_FAILURE',
    });
  });

  it('leaves a bound record even when the run was refused before its first request', async () => {
    const emptyPlan = buildLlmRoutePlan({});
    const error = await providerRefusal(serving(NO_CONTENT_STREAM), emptyPlan);
    const record = refusalRecord(error, { routeVerdicts: verdictsOf(emptyPlan) });

    expect(error.code).toBe('PROVIDER_NO_ELIGIBLE_ROUTE');
    expect(record.attempts).toEqual([]);
    expect(record.promptStructuralHash).toBe(PROMPT.promptStructuralHash);
    expect(record.observedBillableCostEur).toBeNull();
  });

  it('refuses to build a record for a refusal that carries no prompt identity', () => {
    const orphan = new NarrativeProviderError('PROVIDER_OUTPUT_NOT_JSON', 'parser refusal', []);

    expect(() => refusalRecord(orphan)).toThrow(RefusalEvidenceNotBindableError);
  });

  it('refuses to bind a refusal to a brief it was not raised for', async () => {
    const error = await providerRefusal(serving(NO_CONTENT_STREAM));

    expect(() => refusalRecord(error, { briefStructuralHash: `sha256:${'0'.repeat(64)}` })).toThrow(
      RefusalEvidenceNotBindableError,
    );
  });
});

// ---------------------------------------------------------------------------
// R4 — nothing that did not run is reported as having run.
// ---------------------------------------------------------------------------

describe('ETBZ-25B refusal R4: no gate that did not run is reported as a pass', () => {
  it('records both gates NOT_RUN, the reading NOT_PRODUCED and every absent artefact as null', async () => {
    const record = refusalRecord(await providerRefusal(serving(NO_CONTENT_STREAM)));

    expect(record).toMatchObject({
      structuralGate: 'NOT_RUN',
      semanticQaStatus: 'NOT_RUN',
      semanticQaFindings: [],
      goldenReadingStatus: 'NOT_PRODUCED',
      goldenReadingHash: null,
      reportStructuralHash: null,
      acceptedRouteId: null,
      acceptedModel: null,
    });
    expect(record.canonicalJson).not.toContain('"PASS"');
    expect(record.canonicalJson).not.toContain('CANDIDATE_READY_FOR_HUMAN_REVIEW');
  });

  it('does the same for a CONTENT refusal, whose answer was received and rejected', async () => {
    const error = await providerRefusal(
      serving(asEventStream(completionBody('Das ist Prosa und kein JSON-Objekt.'))),
    );
    const record = refusalRecord(error);

    expect(error.code).toBe('PROVIDER_OUTPUT_NOT_JSON');
    expect(record.structuralGate).toBe('NOT_RUN');
    expect(record.semanticQaStatus).toBe('NOT_RUN');
    expect(record.goldenReadingStatus).toBe('NOT_PRODUCED');
    expect(record.attempts[0]?.outcome).toBe('content_rejected');
  });

  it('offers the caller no field through which a verdict could enter', () => {
    const error = new NarrativeProviderError('PROVIDER_ALL_ROUTES_EXHAUSTED', 'x', [], {
      briefStructuralHash: CHAIN.brief.structuralHash,
      promptStructuralHash: PROMPT.promptStructuralHash,
      promptVersion: PROMPT.promptVersion,
      policyVersion: PROMPT.policyVersion,
    });
    const input: BuildProviderRefusalEvidenceInput = {
      candidateSha: CANDIDATE_SHA,
      briefStructuralHash: CHAIN.brief.structuralHash,
      qaVersion: NARRATIVE_QA_VERSION,
      routeVerdicts: verdictsOf(PLAN),
      requestedReasoningEffort: null,
      observedCostBasis: COST_BASIS,
      refusal: error,
      // @ts-expect-error -- a refusal record takes no gate verdict from its caller.
      structuralGate: 'PASS',
    };

    // And at runtime: a verdict smuggled past the type is not copied either.
    const record = buildProviderRefusalEvidence(input);
    expect(record.structuralGate).toBe('NOT_RUN');
    expect(record.semanticQaStatus).toBe('NOT_RUN');
    expect(record.goldenReadingStatus).toBe('NOT_PRODUCED');
  });

  it('refuses a ledger that claims an accepted attempt', async () => {
    const error = await providerRefusal(serving(NO_CONTENT_STREAM));
    const forged = new NarrativeProviderError(
      error.code,
      error.message,
      error.attempts.map((attempt) => ({ ...attempt, outcome: 'accepted' as const })),
      error.prompt,
    );

    expect(() => refusalRecord(forged)).toThrow(RefusalEvidenceNotBindableError);
  });
});

// ---------------------------------------------------------------------------
// R5 — observations survive; absences stay absences.
// ---------------------------------------------------------------------------

describe('ETBZ-25B refusal R5: what was observed is kept, what was not stays null', () => {
  it('keeps the finish reason, usage and reported zero cost a refused stream reported', async () => {
    const error = await providerRefusal(
      serving(
        sse(
          { choices: [{ delta: {}, finish_reason: 'length' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0 } },
        ),
      ),
    );
    const record = refusalRecord(error);
    const [attempt] = record.attempts;

    expect(attempt?.finishReason).toBe('length');
    expect(attempt?.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(attempt?.reportedCost).toEqual({ amount: 0, currency: null, source: 'usage.cost' });
    // Derived from the attempt, by the same function a completed run uses.
    expect(record.observedBillableCostEur).toBe(0);
    expect(() => {
      assertObservedCostWithinCap(record);
    }).not.toThrow();
  });

  it('keeps them on a buffered empty message too', async () => {
    const error = await transportRefusal(
      requestChatCompletion(
        ROUTE,
        BUFFERED,
        serving(
          JSON.stringify(
            completionBody('', {
              choices: [{ message: { content: '' }, finish_reason: 'length' }],
            }),
          ),
        ),
      ),
    );

    expect(error.detailCode).toBe('BUFFERED_EMPTY_MESSAGE');
    expect(error.observed).toEqual({
      finishReason: 'length',
      usage: { promptTokens: 1200, completionTokens: 800, totalTokens: 2000 },
      reportedCost: null,
    });
  });

  it('writes null, never zero, when a stream reported nothing', async () => {
    const record = refusalRecord(await providerRefusal(serving(sse({ choices: [{ delta: {} }] }))));
    const [attempt] = record.attempts;

    expect(attempt?.failureDetailCode).toBe('STREAM_NO_MESSAGE_CONTENT');
    expect(attempt?.finishReason).toBeNull();
    expect(attempt?.usage).toBeNull();
    expect(attempt?.reportedCost).toBeNull();
    expect(record.observedBillableCostEur).toBeNull();
  });

  it('records no HTTP status for a failure that happened before any response', async () => {
    const error = await providerRefusal({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const record = refusalRecord(error);

    // Transient, so the one route is exhausted rather than refused terminally.
    expect(record.providerRefusalCode).toBe('PROVIDER_ALL_ROUTES_EXHAUSTED');
    expect(record.attempts[0]).toMatchObject({
      outcome: 'transient_failure',
      failureDetailCode: 'NETWORK_FAILURE',
      httpStatus: null,
      usage: null,
      finishReason: null,
    });
  });

  it('refuses a refused run whose provider reported a charge', async () => {
    const record = refusalRecord(
      await providerRefusal(
        serving(sse({ choices: [], usage: { total_tokens: 30, cost: '0.0042', cost_currency: 'USD' } })),
      ),
    );

    expect(record.attempts[0]?.reportedCost).toEqual({
      amount: 0.0042,
      currency: 'USD',
      source: 'usage.cost',
    });
    expect(() => {
      assertObservedCostWithinCap(record);
    }).toThrow(ObservedCostExceedsCapError);
  });
});

// ---------------------------------------------------------------------------
// R6 — no credential, no raw provider text, no reasoning text.
// ---------------------------------------------------------------------------

/** Assembled at runtime: a credential-shaped literal would trip the secret scan. */
const SECRET_SHAPED = ['sk', 'refusalprobe'.repeat(2)].join('-');
const RAW_PROVIDER_TEXT = 'RAW-PROVIDER-ERROR-BODY-MARKER';
const REASONING_TEXT = 'PRIVATE-REASONING-TEXT-MARKER';

function surfacesOf(error: NarrativeProviderError, record: NarrativeRunEvidence): readonly string[] {
  return [record.canonicalJson, error.message, JSON.stringify(error.attempts)];
}

describe('ETBZ-25B refusal R6: credentials, raw provider text and reasoning never reach the record', () => {
  it('files nothing of an in-band error frame except its detail code', async () => {
    const error = await providerRefusal(
      serving(sse({ error: { message: `${RAW_PROVIDER_TEXT} ${SECRET_SHAPED}`, type: 'upstream' } })),
    );
    const record = refusalRecord(error);

    expect(record.attempts[0]?.failureDetailCode).toBe('IN_BAND_PROVIDER_ERROR');
    for (const surface of surfacesOf(error, record)) {
      expect(surface).not.toContain(RAW_PROVIDER_TEXT);
      expect(surface).not.toContain(SECRET_SHAPED);
    }
    expect(() => {
      assertEvidenceSanitized(record, [ROUTE.apiKey], [MODEL.displayName, MODEL.birth.date]);
    }).not.toThrow();

    // And one layer down. The transport's own refusal travels on the error
    // object into anything that logs it; the frame's text must not ride along
    // there either, nor inside what it says it observed.
    const transportError = await transportRefusal(
      requestChatCompletion(
        ROUTE,
        STREAMED,
        serving(sse({ error: { message: `${RAW_PROVIDER_TEXT} ${SECRET_SHAPED}` } })),
      ),
    );
    expect(transportError.detailCode).toBe('IN_BAND_PROVIDER_ERROR');
    for (const surface of [transportError.message, JSON.stringify(transportError.observed)]) {
      expect(surface).not.toContain(RAW_PROVIDER_TEXT);
      expect(surface).not.toContain(SECRET_SHAPED);
    }
  });

  it('files nothing of a non-200 error body', async () => {
    const error = await providerRefusal(
      serving(JSON.stringify({ error: { message: `${RAW_PROVIDER_TEXT} ${SECRET_SHAPED}` } }), 500),
    );
    const record = refusalRecord(error);

    expect(record.attempts[0]).toMatchObject({ failureDetailCode: 'HTTP_STATUS_NOT_OK', httpStatus: 500 });
    for (const surface of surfacesOf(error, record)) {
      expect(surface).not.toContain(RAW_PROVIDER_TEXT);
      expect(surface).not.toContain(SECRET_SHAPED);
    }
  });

  it('files no reasoning text from a stream that only reasoned', async () => {
    const error = await providerRefusal(
      serving(
        sse(
          { choices: [{ delta: { reasoning_content: REASONING_TEXT } }] },
          { choices: [{ delta: { reasoning_content: `${REASONING_TEXT} 2` }, finish_reason: 'length' }] },
        ),
      ),
    );
    const record = refusalRecord(error);

    expect(record.attempts[0]?.failureDetailCode).toBe('STREAM_NO_MESSAGE_CONTENT');
    expect(record.attempts[0]?.finishReason).toBe('length');
    for (const surface of surfacesOf(error, record)) {
      expect(surface).not.toContain(REASONING_TEXT);
    }
  });

  it('never files the route credential, and the guard would notice if it did', async () => {
    const error = await providerRefusal(serving(NO_CONTENT_STREAM));
    const record = refusalRecord(error);

    for (const surface of surfacesOf(error, record)) {
      expect(surface).not.toContain(ROUTE.apiKey);
    }
    expect(() => {
      assertEvidenceSanitized(record, [ROUTE.apiKey]);
    }).not.toThrow();

    // Positive control: the same record with the key in a free-text field.
    const leaked = refusalRecord(error, { observedCostBasis: `basis ${ROUTE.apiKey}` });
    expect(() => {
      assertEvidenceSanitized(leaked, [ROUTE.apiKey]);
    }).toThrow(EvidenceLeakError);
  });
});

// ---------------------------------------------------------------------------
// R7 — the three gaps an adversarial review found in the repair itself.
//
// R5 above proves observation preservation on TWO of the refusal paths that can
// carry one. Measured on candidate d6a5ee5 by deleting `observed` from each
// throw site in turn and running the whole suite: the other six lost their
// observation with 1342/1342 still passing. A property nothing measures is a
// property the next edit removes, so the table below covers all eight and a
// completeness guard keeps it that way.
//
// The two singles that follow are different in kind. One is a record claiming a
// request parameter for a run that dispatched no request; the other is a cost
// that arrives in the same stream frame as the error and was read after the
// throw, which made a charged run invisible to the 0.00 EUR cap.
// ---------------------------------------------------------------------------

/** Token counts and a reported zero cost, in a provider's own wire spelling. */
const OBSERVED_USAGE = {
  prompt_tokens: 11,
  completion_tokens: 22,
  total_tokens: 33,
  cost: 0,
} as const;

/** What every streamed scenario below reports BEFORE it is refused. */
const OBSERVED_PREAMBLE =
  `data: ${JSON.stringify({ id: 'obs', choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'obs', choices: [], usage: OBSERVED_USAGE })}\n\n`;

interface ExpectedObservation {
  readonly finishReason: string | null;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };
  readonly reportedCost: { readonly amount: number; readonly currency: string | null; readonly source: string };
}

const STREAM_OBSERVATION: ExpectedObservation = {
  finishReason: 'length',
  usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
  reportedCost: { amount: 0, currency: null, source: 'usage.cost' },
};

/** Streams the given text, then stalls until the route deadline aborts it. */
function stallingAfter(preamble: string): Transport {
  return {
    fetch(_url: string, init: RequestInit): Promise<Response> {
      const signal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(preamble));
          signal?.addEventListener('abort', () => {
            controller.error(abortError());
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  };
}

/**
 * Streams the given text, DELIVERS it, and only then breaks the connection.
 *
 * Pull-based on purpose. Enqueueing and calling `controller.error` in the same
 * `start` discards the queue: the reader's first `read()` rejects and the
 * preamble is never consumed, so the scenario proves nothing about whether an
 * observation SURVIVES a broken stream — it only proves one was never made.
 * Measured exactly that way first. Serving the frames on one pull and failing
 * on the next is also the real shape: a provider reports usage, then the socket
 * dies.
 */
function breakingAfter(preamble: string): Transport {
  return {
    fetch(): Promise<Response> {
      let delivered = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(new TextEncoder().encode(preamble));
            return;
          }
          controller.error(new Error('connection reset by peer'));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  };
}

interface ObservingScenario {
  readonly code: ProviderFailureDetailCode;
  readonly route: LlmRouteConfig;
  readonly request: LlmChatRequest;
  readonly transport: () => Transport;
  readonly expected: ExpectedObservation;
}

const OBSERVING_SCENARIOS: readonly ObservingScenario[] = [
  {
    code: 'MALFORMED_SSE_CHUNK',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving(`${OBSERVED_PREAMBLE}data: {not json\n\n`),
    expected: STREAM_OBSERVATION,
  },
  {
    code: 'STREAM_CLOSED_MID_FRAME',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving(`${OBSERVED_PREAMBLE}data: {"choi`),
    expected: STREAM_OBSERVATION,
  },
  {
    code: 'IN_BAND_PROVIDER_ERROR',
    route: ROUTE,
    request: STREAMED,
    transport: () =>
      serving(
        `${OBSERVED_PREAMBLE}data: ${JSON.stringify({ error: { message: 'upstream failed' } })}\n\n`,
      ),
    expected: STREAM_OBSERVATION,
  },
  {
    code: 'STREAM_TIMEOUT',
    route: FAST_ROUTE,
    request: STREAMED,
    transport: () => stallingAfter(OBSERVED_PREAMBLE),
    expected: STREAM_OBSERVATION,
  },
  {
    code: 'STREAM_INTERRUPTED',
    route: ROUTE,
    request: STREAMED,
    transport: () => breakingAfter(OBSERVED_PREAMBLE),
    expected: STREAM_OBSERVATION,
  },
  {
    code: 'STREAM_NO_MESSAGE_CONTENT',
    route: ROUTE,
    request: STREAMED,
    transport: () => serving(`${OBSERVED_PREAMBLE}data: [DONE]\n\n`),
    expected: STREAM_OBSERVATION,
  },
  {
    code: 'BUFFERED_NO_CHOICES',
    route: ROUTE,
    request: BUFFERED,
    transport: () => serving(JSON.stringify({ id: 'obs', choices: [], usage: OBSERVED_USAGE })),
    // No choice exists, so no finish reason can have been reported. The usage
    // block still arrived, and null is the truthful record of the other.
    expected: { ...STREAM_OBSERVATION, finishReason: null },
  },
  {
    code: 'BUFFERED_EMPTY_MESSAGE',
    route: ROUTE,
    request: BUFFERED,
    transport: () =>
      serving(
        JSON.stringify(
          completionBody('', {
            choices: [{ message: { content: '' }, finish_reason: 'length' }],
            usage: OBSERVED_USAGE,
          }),
        ),
      ),
    expected: STREAM_OBSERVATION,
  },
];

/**
 * The refusals that CANNOT have observed anything, and why.
 *
 * Each happens before a usable body existed: no request completed, no response
 * arrived, the status was not 200, or the body was unreadable as a whole. They
 * are listed rather than inferred so the completeness guard below is a
 * statement about the closed set and not about whatever the table happens to
 * contain.
 */
const NON_OBSERVING_DETAIL_CODES: readonly ProviderFailureDetailCode[] = [
  'REQUEST_TIMEOUT',
  'NETWORK_FAILURE',
  'HTTP_STATUS_NOT_OK',
  'BUFFERED_BODY_NOT_JSON',
  'BUFFERED_BODY_NOT_OBJECT',
  'STREAM_NO_BODY',
];

describe('ETBZ-25B refusal R7: every refusal that observed something files it', () => {
  for (const scenario of OBSERVING_SCENARIOS) {
    it(`${scenario.code} keeps the finish reason, usage and reported cost it saw`, async () => {
      const error = await transportRefusal(
        requestChatCompletion(scenario.route, scenario.request, scenario.transport()),
      );

      expect(error.detailCode).toBe(scenario.code);
      expect(error.observed).toEqual(scenario.expected);
    });
  }

  it('covers every detail code that can carry an observation, and no other', () => {
    // Without this, a new throw site added with an `observed` block would be
    // covered by nothing and the table above would still look complete.
    const covered = OBSERVING_SCENARIOS.map((scenario) => scenario.code);

    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered, ...NON_OBSERVING_DETAIL_CODES].sort()).toEqual(
      [...PROVIDER_FAILURE_DETAIL_CODES].sort(),
    );
  });

  it('files no observation on a refusal that could not have one (control)', async () => {
    const error = await transportRefusal(
      requestChatCompletion(ROUTE, STREAMED, serving('{"error":"overloaded"}', 503)),
    );

    expect(error.detailCode).toBe('HTTP_STATUS_NOT_OK');
    expect(error.observed).toBeNull();
  });

  it('carries the observation all the way into the filed record', async () => {
    // The table above measures the transport. This measures the rest of the
    // chain for one of the six that had nothing: adapter attempt, then record.
    const record = refusalRecord(
      await providerRefusal(
        serving(
          `${OBSERVED_PREAMBLE}data: ${JSON.stringify({ error: { message: 'upstream failed' } })}\n\n`,
        ),
      ),
    );

    expect(record.attempts[0]).toMatchObject({
      failureDetailCode: 'IN_BAND_PROVIDER_ERROR',
      finishReason: 'length',
      usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      reportedCost: { amount: 0, currency: null, source: 'usage.cost' },
    });
    expect(record.observedBillableCostEur).toBe(0);
  });
});

describe('ETBZ-25B refusal R7: no record implies a provider request that never happened', () => {
  it('files no requested reasoning effort when nothing was ever dispatched', async () => {
    // The harness passes the effort it is configured with on BOTH paths, and a
    // run refused for having no eligible route sends no request at all. Filing
    // the parameter anyway makes the record say a provider was asked to reason
    // at some level when no provider was asked anything.
    const emptyPlan = buildLlmRoutePlan({});
    const error = await providerRefusal(serving(NO_CONTENT_STREAM), emptyPlan);
    const record = refusalRecord(error, {
      routeVerdicts: verdictsOf(emptyPlan),
      requestedReasoningEffort: 'low',
    });

    expect(error.code).toBe('PROVIDER_NO_ELIGIBLE_ROUTE');
    expect(record.attempts).toEqual([]);
    expect(record.requestedReasoningEffort).toBeNull();
  });

  it('keeps it when a request WAS dispatched and then refused', async () => {
    // The other half of the rule: nulling on an empty ledger must not null the
    // ordinary case, or the field would stop being evidence of anything.
    const record = refusalRecord(await providerRefusal(serving(NO_CONTENT_STREAM)));

    expect(record.attempts.length).toBeGreaterThan(0);
    expect(record.requestedReasoningEffort).toBe('low');
  });
});

describe('ETBZ-25B refusal R7: a cost reported inside an error frame still fails the cap', () => {
  it('reads the usage and cost the in-band error frame reports about itself', async () => {
    // The frame that says the call failed can also say what the failed call
    // cost — `StreamChunk` declares `usage` and `error` side by side. The
    // usage was read AFTER the refusal threw, so that cost reached no attempt,
    // `assertObservedCostWithinCap` had nothing to refuse, and a run a provider
    // charged for passed the 0.00 EUR cap.
    const record = refusalRecord(
      await providerRefusal(
        serving(
          sse({
            error: { message: 'upstream failed' },
            usage: {
              prompt_tokens: 7,
              completion_tokens: 9,
              total_tokens: 16,
              cost: '0.0042',
              cost_currency: 'USD',
            },
          }),
        ),
      ),
    );

    expect(record.attempts[0]).toMatchObject({
      failureDetailCode: 'IN_BAND_PROVIDER_ERROR',
      usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 },
      reportedCost: { amount: 0.0042, currency: 'USD', source: 'usage.cost' },
    });
    expect(() => {
      assertObservedCostWithinCap(record);
    }).toThrow(ObservedCostExceedsCapError);
  });

  it('still files nothing of the error frame text (control)', async () => {
    const error = await transportRefusal(
      requestChatCompletion(
        ROUTE,
        STREAMED,
        serving(
          sse({
            error: { message: `${RAW_PROVIDER_TEXT} ${SECRET_SHAPED}` },
            usage: { total_tokens: 16, cost: 0 },
          }),
        ),
      ),
    );

    expect(error.detailCode).toBe('IN_BAND_PROVIDER_ERROR');
    for (const surface of [error.message, JSON.stringify(error.observed)]) {
      expect(surface).not.toContain(RAW_PROVIDER_TEXT);
      expect(surface).not.toContain(SECRET_SHAPED);
    }
  });
});
