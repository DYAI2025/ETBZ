import { describe, expect, it } from 'vitest';
import {
  CHAT_COMPLETIONS_PATH,
  LlmProviderError,
  classifyStatus,
  requestChatCompletion,
} from '../../src/adapters/llm/openai-compatible-client.js';
import type {
  LlmChatRequest,
  LlmErrorCode,
  LlmFailureClass,
  Transport,
} from '../../src/adapters/llm/openai-compatible-client.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import type { LlmRouteConfig } from '../../src/app/configuration/llm-routes.js';
import {
  FIXTURE_LLM_ENV,
  answerAsProviderText,
  completionBody,
  fakeTransport,
  validKnownTimeAnswer,
} from '../support/llmNarrativeFixture.js';

/**
 * ETBZ-25B — evidence for the ONE generic OpenAI-compatible adapter.
 *
 * WHY THIS FILE EXISTS. Four things in this slice are decided here and nowhere
 * else, and each of them is the kind of rule that is easy to state in a comment
 * and impossible to trust without measurement:
 *
 *   1. TRANSIENT vs TERMINAL. The contract allows moving to the next approved
 *      route only for bounded availability failures. Every other failure must
 *      fail closed. That makes the classification the permission system for
 *      provider shopping: if a status were misclassified as transient, ETBZ
 *      would answer a configuration defect by asking a different model for a
 *      different answer — and the reading would look fine. The table below
 *      therefore names every status the implementation distinguishes, and one
 *      test sweeps the whole 100..599 range so the ALLOWLIST shape is proven
 *      rather than assumed: a status nobody classified must be terminal.
 *      `404` gets its own named test because it is the one everybody wants to
 *      read as availability. A vanished model is a configuration fact.
 *
 *   2. THE REQUEST IS SERVER-OWNED. The URL is the route's base URL plus a
 *      pinned path, the credential travels as a bearer header, and neither the
 *      caller nor a model output can redirect either. Asserted against the
 *      bytes the transport actually received, not against the code's intent.
 *
 *   3. USAGE IS REPORTED, NEVER INVENTED. A missing token count must surface as
 *      `null`, because `0` is a measurement nobody made and it would travel
 *      into the run evidence as one.
 *
 *   4. THE CREDENTIAL NEVER REACHES AN ERROR SURFACE. Errors are the surface
 *      that gets logged, attached to issues and pasted into chats, so every
 *      failure path is re-checked against the real key value, with a positive
 *      control proving the key was genuinely in play.
 *
 * No real credential is involved anywhere: the key is the synthetic fixture
 * value from `FIXTURE_LLM_ENV`.
 */

/**
 * A short timeout, so the timeout message can be asserted against an exact
 * number instead of the production default.
 */
const ROUTE_TIMEOUT_MS = 1_500;

/**
 * Routes come from the real plan builder rather than from a hand-written
 * literal. The URL property under test is a JOINT property — the plan
 * normalizes the configured base URL, the adapter concatenates the pinned path
 * — and a hand-written `LlmRouteConfig` would quietly pre-normalize the input
 * and prove nothing.
 */
function routeFrom(
  routeId: LlmRouteConfig['routeId'],
  overrides: Readonly<Record<string, string>> = {},
): LlmRouteConfig {
  const plan = buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, ...overrides }, ROUTE_TIMEOUT_MS);
  const route = plan.routes.find((candidate) => candidate.routeId === routeId);
  if (route === undefined) {
    throw new Error(
      `fixture defect: route "${routeId}" is not eligible under the fixture environment`,
    );
  }
  return route;
}

const ROUTE = routeFrom('tokenrouter');

/** The credential the adapter is given. Every leak assertion tests THIS value. */
const API_KEY = ROUTE.apiKey;

const REQUEST: LlmChatRequest = {
  system: 'Du bist ein BaZi-Interpret. Antworte ausschliesslich mit einem JSON-Objekt.',
  user: 'Brief: primary.self_role, primary.seasonal_anchor.',
  maxTokens: 4096,
  // Zero, and it must survive JSON serialisation: a falsy value that silently
  // vanishes would hand the provider its own default sampling temperature.
  temperature: 0,
  jsonObjectMode: true,
  // The buffered path. Streaming is exercised separately in
  // `tests/unit/openai-compatible-client-stream.test.ts`, so both transport
  // modes are covered rather than only the one the production default uses.
  stream: false,
};

/** A body shaped like a provider's error envelope, carrying no credential. */
const ERROR_ENVELOPE = { error: { message: 'the route refused this request', type: 'fixture' } };

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Records the FULL `RequestInit`.
 *
 * `fakeTransport` records only url, authorization and body — everything the
 * failover tests need — so the HTTP method and the abort signal are only
 * observable through a transport that keeps the whole init. This does not
 * duplicate the fixture; it reaches the part of the request the fixture cannot
 * express.
 */
function capturingTransport(body: unknown): Transport & { readonly calls: readonly CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    fetch(url: string, init: RequestInit): Promise<Response> {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  };
}

/**
 * Answers with a RAW body that is not JSON.
 *
 * `fakeTransport` serialises its scripted body, so every body it can produce is
 * valid JSON by construction — the "provider answered 200 with an HTML error
 * page" case is unreachable through it.
 */
function textTransport(status: number, text: string): Transport {
  return {
    fetch: () =>
      Promise.resolve(
        new Response(text, { status, headers: { 'Content-Type': 'application/json' } }),
      ),
  };
}

/** Rejects with an arbitrary value, including values that are not `Error`s. */
function throwingTransport(reason: unknown): Transport {
  return { fetch: () => Promise.reject(reason) };
}

function theOnly<T>(values: readonly T[], what: string): T {
  expect(values, `expected exactly one ${what}`).toHaveLength(1);
  const [first] = values;
  if (first === undefined) {
    throw new Error(`unreachable: the length assertion for ${what} has already failed`);
  }
  return first;
}

/** Runs one call that is expected to fail, and returns the typed error. */
async function providerErrorFrom(
  transport: Transport,
  route: LlmRouteConfig = ROUTE,
  request: LlmChatRequest = REQUEST,
): Promise<LlmProviderError> {
  const outcome: unknown = await requestChatCompletion(route, request, transport).catch(
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(LlmProviderError);
  if (!(outcome instanceof LlmProviderError)) {
    throw new Error('unreachable: the instance assertion above has already failed');
  }
  return outcome;
}

interface ClassificationRow {
  readonly status: number;
  readonly code: LlmErrorCode;
  readonly failureClass: LlmFailureClass;
}

/**
 * Every status the implementation distinguishes, stated once and reused by both
 * the pure-classification suite and the thrown-error suite, so the two can
 * never drift apart.
 */
const CLASSIFICATION_TABLE: readonly ClassificationRow[] = [
  { status: 401, code: 'LLM_AUTH_FAILED', failureClass: 'terminal' },
  { status: 403, code: 'LLM_AUTH_FAILED', failureClass: 'terminal' },
  { status: 429, code: 'LLM_RATE_LIMITED', failureClass: 'transient' },
  { status: 408, code: 'LLM_SERVER_ERROR', failureClass: 'transient' },
  { status: 500, code: 'LLM_SERVER_ERROR', failureClass: 'transient' },
  { status: 502, code: 'LLM_SERVER_ERROR', failureClass: 'transient' },
  { status: 503, code: 'LLM_SERVER_ERROR', failureClass: 'transient' },
  { status: 504, code: 'LLM_SERVER_ERROR', failureClass: 'transient' },
  { status: 400, code: 'LLM_ROUTE_REJECTED', failureClass: 'terminal' },
  { status: 404, code: 'LLM_ROUTE_REJECTED', failureClass: 'terminal' },
  { status: 422, code: 'LLM_ROUTE_REJECTED', failureClass: 'terminal' },
  // 409 and 425 are 4xx and are NOT in the contract's failover allowlist
  // ("network/connectivity failure, timeout, 429, or explicitly classified
  // transient 5xx"). Admitting them would widen the permission to shop for a
  // different provider beyond what the Product Owner granted.
  { status: 409, code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' },
  { status: 425, code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' },
  { status: 402, code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' },
  { status: 418, code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' },
  { status: 501, code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' },
  { status: 505, code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' },
];

/** The allowlist, restated independently of the implementation's own set. */
const TRANSIENT_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504];

describe('classifyStatus: the transient allowlist that authorises failover', () => {
  // The transient rows below are this block's positive control: the guard is
  // not "everything is terminal", it admits exactly eight statuses.
  for (const row of CLASSIFICATION_TABLE) {
    it(`classifies HTTP ${String(row.status)} as ${row.code} / ${row.failureClass}`, () => {
      expect(classifyStatus(row.status)).toEqual({
        code: row.code,
        failureClass: row.failureClass,
      });
    });
  }

  it('classifies 404 as TERMINAL: a vanished model must not authorise provider shopping', () => {
    const verdict = classifyStatus(404);
    expect(verdict.failureClass).toBe('terminal');
    expect(verdict.code).toBe('LLM_ROUTE_REJECTED');
    // Stated as a contrast so the property is unmistakable: 503 — the same
    // server saying "not now" — IS allowed to move on, 404 is not.
    expect(classifyStatus(503).failureClass).toBe('transient');
  });

  it('treats transience as an allowlist: across 100..599 only the eight enumerated statuses are transient', () => {
    const unexpectedlyTransient: number[] = [];
    const unexpectedlyTerminal: number[] = [];
    for (let status = 100; status <= 599; status += 1) {
      const isTransient = classifyStatus(status).failureClass === 'transient';
      const shouldBeTransient = TRANSIENT_STATUSES.includes(status);
      if (isTransient && !shouldBeTransient) {
        unexpectedlyTransient.push(status);
      }
      if (!isTransient && shouldBeTransient) {
        unexpectedlyTerminal.push(status);
      }
    }
    expect(unexpectedlyTransient).toEqual([]);
    expect(unexpectedlyTerminal).toEqual([]);
  });

  it('pairs every transient verdict with a transient-capable code', () => {
    const transientCodes = new Set<LlmErrorCode>(['LLM_RATE_LIMITED', 'LLM_SERVER_ERROR']);
    const mismatches: { status: number; code: LlmErrorCode }[] = [];
    for (let status = 100; status <= 599; status += 1) {
      const { code, failureClass } = classifyStatus(status);
      if (failureClass === 'transient' && !transientCodes.has(code)) {
        mismatches.push({ status, code });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('never derives a transport-only code from a completed response', () => {
    // LLM_TIMEOUT and LLM_NETWORK_ERROR describe a request that produced NO
    // response. A status exists, so neither code may ever come out of here.
    const leaked: number[] = [];
    for (let status = 100; status <= 599; status += 1) {
      const { code } = classifyStatus(status);
      if (code === 'LLM_TIMEOUT' || code === 'LLM_NETWORK_ERROR') {
        leaked.push(status);
      }
    }
    expect(leaked).toEqual([]);
  });
});

describe('requestChatCompletion: the request the provider actually receives', () => {
  it('posts to the route base URL joined with the pinned completions path', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const recorded = theOnly(transport.requests, 'recorded request');
    expect(recorded.url).toBe(`${ROUTE.baseUrl}${CHAT_COMPLETIONS_PATH}`);
    expect(CHAT_COMPLETIONS_PATH).toBe('/chat/completions');
  });

  it('uses the POST method and a JSON content type', async () => {
    const transport = capturingTransport(completionBody('ok'));
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const call = theOnly(transport.calls, 'captured call');
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json');
  });

  it('sends the credential as an Authorization bearer header and in no other header', async () => {
    const transport = capturingTransport(completionBody('ok'));
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const call = theOnly(transport.calls, 'captured call');
    const headers = new Headers(call.init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
    const carryingTheKey = [...headers.entries()].filter(([, value]) => value.includes(API_KEY));
    expect(carryingTheKey.map(([name]) => name)).toEqual(['authorization']);
    // The credential must not travel in the URL either, where it would reach
    // proxy logs and provider-side access logs.
    expect(call.url).not.toContain(API_KEY);
  });

  it('joins a base URL that was configured WITH a trailing slash without producing a double slash', async () => {
    // The fixture configures this route's base URL with a trailing slash on
    // purpose; the assertion below is worthless if that ever stops being true,
    // so the input is measured first.
    expect(FIXTURE_LLM_ENV['GEMINI_BASE_URL']).toBe('https://provider.invalid/two/v1/');
    const slashed = routeFrom('gemini', { GEMINI_MODEL: 'vendor-model-b-free' });
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(slashed, REQUEST, transport);
    const recorded = theOnly(transport.requests, 'recorded request');
    expect(recorded.url).toBe('https://provider.invalid/two/v1/chat/completions');
    expect(recorded.url.slice('https://'.length)).not.toContain('//');
  });

  it('sends the ROUTE model and the two messages in system-then-user order', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const { body } = theOnly(transport.requests, 'recorded request');
    // The model comes from the route plan. `LlmChatRequest` has no model field
    // at all, so no caller and no model output can redirect the request.
    expect(body['model']).toBe(ROUTE.model);
    expect(body['messages']).toEqual([
      { role: 'system', content: REQUEST.system },
      { role: 'user', content: REQUEST.user },
    ]);
  });

  it('sends max_tokens and a temperature of zero that survives serialisation', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const { body } = theOnly(transport.requests, 'recorded request');
    expect(body['max_tokens']).toBe(REQUEST.maxTokens);
    expect(body['temperature']).toBe(0);
    expect(Object.keys(body)).toContain('temperature');
  });

  it('asks for a JSON object when jsonObjectMode is true', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const { body } = theOnly(transport.requests, 'recorded request');
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  it('omits response_format entirely when jsonObjectMode is false', async () => {
    // Same valid request, exactly one field changed.
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(ROUTE, { ...REQUEST, jsonObjectMode: false }, transport);
    const { body } = theOnly(transport.requests, 'recorded request');
    expect(Object.keys(body)).not.toContain('response_format');
    expect(body).not.toHaveProperty('response_format');
    // Everything else is untouched by the flip.
    expect(body['model']).toBe(ROUTE.model);
    expect(body['max_tokens']).toBe(REQUEST.maxTokens);
  });

  it('calls the transport exactly once: retry and failover are not this layer decisions', async () => {
    const transport = fakeTransport([{ status: 500, body: ERROR_ENVELOPE }]);
    await providerErrorFrom(transport);
    expect(transport.requests).toHaveLength(1);
  });

  it('arms an abort signal per request that has not fired on a prompt answer', async () => {
    const transport = capturingTransport(completionBody('ok'));
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const call = theOnly(transport.calls, 'captured call');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.signal?.aborted).toBe(false);
    expect(ROUTE.timeoutMs).toBe(ROUTE_TIMEOUT_MS);
  });
});

describe('requestChatCompletion: reading a well-formed answer', () => {
  it('returns the message content verbatim, unparsed and unrepaired', async () => {
    const providerText = answerAsProviderText(validKnownTimeAnswer());
    const transport = fakeTransport([{ status: 200, body: completionBody(providerText) }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.content).toBe(providerText);
    expect(typeof completion.content).toBe('string');
  });

  it('returns prose content verbatim: parsing the draft is not this layer job', async () => {
    const prose = 'Ich antworte lieber in Prosa als in JSON.';
    const transport = fakeTransport([{ status: 200, body: completionBody(prose) }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.content).toBe(prose);
  });

  it('reports the route id, the PROVIDER model, the response id and the finish reason', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.routeId).toBe(ROUTE.routeId);
    // The provider names a different model than the one requested; the answer
    // records what actually answered. Asserting they differ keeps this honest.
    expect(completion.model).toBe('fixture-model-free');
    expect(completion.model).not.toBe(ROUTE.model);
    expect(completion.responseId).toBe('cmpl-fixture');
    expect(completion.finishReason).toBe('stop');
  });

  it('falls back to the requested model when the provider names none', async () => {
    const transport = fakeTransport([
      { status: 200, body: completionBody('ok', { model: undefined }) },
    ]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.model).toBe(ROUTE.model);
  });

  it('falls back to the requested model when the provider model is not a string', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok', { model: 7 }) }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.model).toBe(ROUTE.model);
  });

  it('reports a missing response id as null rather than inventing one', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok', { id: undefined }) }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.responseId).toBeNull();
  });

  it('reports a missing finish reason as null', async () => {
    const transport = fakeTransport([
      { status: 200, body: completionBody('ok', { choices: [{ message: { content: 'ok' } }] }) },
    ]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.finishReason).toBeNull();
    expect(completion.content).toBe('ok');
  });

  it('reads usage verbatim from the provider', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 800,
      totalTokens: 2000,
    });
  });

  it('reports absent usage as null, NOT as zero: a zero is a measurement nobody made', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok', { usage: undefined }) }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    expect(completion.usage.promptTokens).not.toBe(0);
    expect(completion.usage.completionTokens).not.toBe(0);
    expect(completion.usage.totalTokens).not.toBe(0);
  });

  it('nulls only the usage fields the provider omitted and keeps the ones it reported', async () => {
    const transport = fakeTransport([
      { status: 200, body: completionBody('ok', { usage: { prompt_tokens: 11 } }) },
    ]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.usage.promptTokens).toBe(11);
    expect(completion.usage.completionTokens).toBeNull();
    expect(completion.usage.totalTokens).toBeNull();
    expect(completion.usage.completionTokens).not.toBe(0);
  });

  it('reports a non-numeric usage value as null instead of coercing it', async () => {
    const transport = fakeTransport([
      {
        status: 200,
        body: completionBody('ok', {
          usage: { prompt_tokens: 'many', completion_tokens: null, total_tokens: 2000 },
        }),
      },
    ]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.usage.promptTokens).toBeNull();
    expect(completion.usage.completionTokens).toBeNull();
    expect(completion.usage.totalTokens).toBe(2000);
  });
});

describe('requestChatCompletion: a non-200 response', () => {
  it('resolves a 200 — the failure assertions below are not a guard that is always red', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.content).toBe('ok');
  });

  it('throws LLM_AUTH_FAILED / terminal on 401: a rejected credential is never a reason to fail over', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 401, body: ERROR_ENVELOPE }]));
    expect(error.code).toBe('LLM_AUTH_FAILED');
    expect(error.failureClass).toBe('terminal');
    expect(error.status).toBe(401);
    expect(error.routeId).toBe(ROUTE.routeId);
    expect(error.name).toBe('LlmProviderError');
  });

  it('throws LLM_RATE_LIMITED / transient on 429', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 429, body: ERROR_ENVELOPE }]));
    expect(error.code).toBe('LLM_RATE_LIMITED');
    expect(error.failureClass).toBe('transient');
    expect(error.status).toBe(429);
  });

  it('throws LLM_SERVER_ERROR / transient on 503', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 503, body: ERROR_ENVELOPE }]));
    expect(error.code).toBe('LLM_SERVER_ERROR');
    expect(error.failureClass).toBe('transient');
    expect(error.status).toBe(503);
  });

  it('throws LLM_ROUTE_REJECTED / TERMINAL on 404, so a missing model surfaces instead of moving on', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 404, body: ERROR_ENVELOPE }]));
    expect(error.code).toBe('LLM_ROUTE_REJECTED');
    expect(error.failureClass).toBe('terminal');
    expect(error.status).toBe(404);
  });

  it('throws LLM_CONTRACT_ERROR / terminal on a status nobody classified', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 418, body: ERROR_ENVELOPE }]));
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
    expect(error.status).toBe(418);
  });

  it('throws exactly what classifyStatus decided, for every status in the table', async () => {
    for (const row of CLASSIFICATION_TABLE) {
      const error = await providerErrorFrom(
        fakeTransport([{ status: row.status, body: ERROR_ENVELOPE }]),
      );
      const label = `HTTP ${String(row.status)}`;
      expect(error.code, label).toBe(row.code);
      expect(error.failureClass, label).toBe(row.failureClass);
      expect(error.status, label).toBe(row.status);
      expect(error.routeId, label).toBe(ROUTE.routeId);
      expect(error.message, label).toContain(String(row.status));
    }
  });

  it('does not read the failing body: a provider error envelope never becomes content', async () => {
    const transport = fakeTransport([
      { status: 500, body: completionBody('this must never be returned') },
    ]);
    const error = await providerErrorFrom(transport);
    expect(error.message).not.toContain('this must never be returned');
  });
});

describe('requestChatCompletion: a 200 whose body breaks the contract', () => {
  it('accepts a well-formed body — this block proves refusal, not paralysis', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.content).toBe('ok');
  });

  it('refuses a 200 whose body is not valid JSON', async () => {
    const error = await providerErrorFrom(textTransport(200, '<html>502 Bad Gateway</html>'));
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
    expect(error.status).toBe(200);
  });

  it('refuses a 200 whose body is valid JSON but not an object', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 200, body: 'plain prose' }]));
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
    expect(error.status).toBe(200);
  });

  it('refuses a 200 whose body is JSON null', async () => {
    const error = await providerErrorFrom(fakeTransport([{ status: 200, body: null }]));
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('refuses a 200 with no choices key', async () => {
    const error = await providerErrorFrom(
      fakeTransport([{ status: 200, body: completionBody('ok', { choices: undefined }) }]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('refuses a 200 with an empty choices array', async () => {
    const error = await providerErrorFrom(
      fakeTransport([{ status: 200, body: completionBody('ok', { choices: [] }) }]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('refuses a 200 whose choices are not an array', async () => {
    const error = await providerErrorFrom(
      fakeTransport([{ status: 200, body: completionBody('ok', { choices: { message: {} } }) }]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('refuses a 200 whose first choice carries no message', async () => {
    const error = await providerErrorFrom(
      fakeTransport([
        { status: 200, body: completionBody('ok', { choices: [{ finish_reason: 'stop' }] }) },
      ]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('refuses a 200 whose message content is not a string', async () => {
    const error = await providerErrorFrom(
      fakeTransport([
        {
          status: 200,
          body: completionBody('ok', { choices: [{ message: { content: { text: 'ok' } } }] }),
        },
      ]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('refuses a 200 with empty content: an empty answer is not an availability problem', async () => {
    const error = await providerErrorFrom(
      fakeTransport([{ status: 200, body: completionBody('') }]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    // The load-bearing half: classing this transient would let an empty answer
    // send ETBZ shopping for a different provider's answer.
    expect(error.failureClass).toBe('terminal');
    expect(error.status).toBe(200);
  });

  it('refuses a 200 whose content is only whitespace', async () => {
    const error = await providerErrorFrom(
      fakeTransport([{ status: 200, body: completionBody('   \n\t  ') }]),
    );
    expect(error.code).toBe('LLM_CONTRACT_ERROR');
    expect(error.failureClass).toBe('terminal');
  });

  it('classes every malformed 200 as terminal, never as transient', async () => {
    const malformed: readonly { readonly label: string; readonly transport: () => Transport }[] = [
      { label: 'not JSON', transport: () => textTransport(200, 'nope') },
      { label: 'not an object', transport: () => fakeTransport([{ status: 200, body: 12 }]) },
      {
        label: 'no choices',
        transport: () =>
          fakeTransport([{ status: 200, body: completionBody('ok', { choices: undefined }) }]),
      },
      {
        label: 'empty choices',
        transport: () =>
          fakeTransport([{ status: 200, body: completionBody('ok', { choices: [] }) }]),
      },
      {
        label: 'empty content',
        transport: () => fakeTransport([{ status: 200, body: completionBody('') }]),
      },
    ];
    for (const scenario of malformed) {
      const error = await providerErrorFrom(scenario.transport());
      expect(error.code, scenario.label).toBe('LLM_CONTRACT_ERROR');
      expect(error.failureClass, scenario.label).toBe('terminal');
    }
  });
});

describe('requestChatCompletion: the transport itself fails', () => {
  it('resolves when the transport answers — the failures below are reachable, not universal', async () => {
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    const completion = await requestChatCompletion(ROUTE, REQUEST, transport);
    expect(completion.content).toBe('ok');
  });

  it('turns a connection failure into LLM_NETWORK_ERROR / transient with no status', async () => {
    const error = await providerErrorFrom(
      fakeTransport([{ status: 0, body: null, throws: new Error('socket hang up') }]),
    );
    expect(error.code).toBe('LLM_NETWORK_ERROR');
    expect(error.failureClass).toBe('transient');
    expect(error.status).toBeUndefined();
    expect(error.routeId).toBe(ROUTE.routeId);
    expect(error.message).toContain('socket hang up');
  });

  it('turns a rejection that is not an Error into LLM_NETWORK_ERROR without inventing a reason', async () => {
    const error = await providerErrorFrom(throwingTransport('a bare string rejection'));
    expect(error.code).toBe('LLM_NETWORK_ERROR');
    expect(error.failureClass).toBe('transient');
    expect(error.message).toContain('unknown network failure');
  });

  it('turns an abort into LLM_TIMEOUT / transient naming the route timeout', async () => {
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    const error = await providerErrorFrom(fakeTransport([{ status: 0, body: null, throws: aborted }]));
    expect(error.code).toBe('LLM_TIMEOUT');
    expect(error.failureClass).toBe('transient');
    expect(error.status).toBeUndefined();
    expect(error.message).toContain(`${String(ROUTE_TIMEOUT_MS)}ms`);
  });

  it('keeps timeout and network apart: only an AbortError becomes LLM_TIMEOUT', async () => {
    // Same failure shape, exactly one thing changed: the error name.
    const plain = new Error('The operation was aborted.');
    const error = await providerErrorFrom(fakeTransport([{ status: 0, body: null, throws: plain }]));
    expect(error.code).toBe('LLM_NETWORK_ERROR');
  });
});

describe('the credential never reaches an error surface', () => {
  it('proves the credential is genuinely in play (positive control for every check below)', async () => {
    expect(API_KEY.length).toBeGreaterThan(0);
    const transport = fakeTransport([{ status: 200, body: completionBody('ok') }]);
    await requestChatCompletion(ROUTE, REQUEST, transport);
    const recorded = theOnly(transport.requests, 'recorded request');
    // If this ever stopped holding, every `not.toContain(API_KEY)` below would
    // pass for the uninteresting reason that no key was ever sent.
    expect(recorded.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('keeps the credential out of every HTTP failure message in the table', async () => {
    for (const row of CLASSIFICATION_TABLE) {
      const error = await providerErrorFrom(
        fakeTransport([{ status: row.status, body: ERROR_ENVELOPE }]),
      );
      const label = `HTTP ${String(row.status)}`;
      expect(error.message, label).not.toContain(API_KEY);
      expect(String(error), label).not.toContain(API_KEY);
      expect(error.stack ?? '', label).not.toContain(API_KEY);
    }
  });

  it('keeps the credential out of every contract failure message', async () => {
    const scenarios: readonly { readonly label: string; readonly transport: () => Transport }[] = [
      { label: 'body is not JSON', transport: () => textTransport(200, '<html>gateway</html>') },
      {
        label: 'body is not an object',
        transport: () => fakeTransport([{ status: 200, body: 'prose' }]),
      },
      {
        label: 'no choices',
        transport: () =>
          fakeTransport([{ status: 200, body: completionBody('ok', { choices: undefined }) }]),
      },
      {
        label: 'empty choices',
        transport: () =>
          fakeTransport([{ status: 200, body: completionBody('ok', { choices: [] }) }]),
      },
      {
        label: 'empty content',
        transport: () => fakeTransport([{ status: 200, body: completionBody('') }]),
      },
    ];
    for (const scenario of scenarios) {
      const error = await providerErrorFrom(scenario.transport());
      expect(error.message, scenario.label).not.toContain(API_KEY);
      expect(String(error), scenario.label).not.toContain(API_KEY);
      expect(error.stack ?? '', scenario.label).not.toContain(API_KEY);
    }
  });

  it('keeps the credential out of every transport failure message', async () => {
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    const scenarios: readonly { readonly label: string; readonly transport: () => Transport }[] = [
      {
        label: 'connection failure',
        transport: () =>
          fakeTransport([{ status: 0, body: null, throws: new Error('socket hang up') }]),
      },
      {
        label: 'abort',
        transport: () => fakeTransport([{ status: 0, body: null, throws: aborted }]),
      },
      { label: 'non-Error rejection', transport: () => throwingTransport('bare string') },
    ];
    for (const scenario of scenarios) {
      const error = await providerErrorFrom(scenario.transport());
      expect(error.message, scenario.label).not.toContain(API_KEY);
      expect(String(error), scenario.label).not.toContain(API_KEY);
      expect(error.stack ?? '', scenario.label).not.toContain(API_KEY);
    }
  });

  it('keeps the credential out of the error even when the route base URL appears in the message', async () => {
    // A message may legitimately name the route; naming the route must never
    // pull the credential along with it.
    const error = await providerErrorFrom(fakeTransport([{ status: 500, body: ERROR_ENVELOPE }]));
    expect(error.message).toContain(ROUTE.routeId);
    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(API_KEY);
  });
});
