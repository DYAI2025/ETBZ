/**
 * ETBZ-25B — the optional reasoning effort, at the generic transport boundary.
 *
 * This candidate changes exactly one runtime variable, and these tests pin how
 * far it reaches and no further:
 *
 *   ABSENT BY DEFAULT  a request that sets no effort carries no
 *                      `reasoning_effort` field, and its key set is exactly the
 *                      one every request carried before the option existed.
 *                      The product default sets none.
 *   EXACT WHEN SET     `low`, `high` and `max` each travel verbatim, in both
 *                      transport modes.
 *   CLOSED             anything else is refused by the type AND at runtime,
 *                      before a request exists.
 *   ROUTE-NEUTRAL      the option lives in the one generic request; failover
 *                      hands the next route the same value, and neither LLM
 *                      module names a model.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_NARRATIVE_OPTIONS,
  generateNarrativeFromPlan,
} from '../../src/adapters/llm/llm-narrative-provider.js';
import {
  LLM_REASONING_EFFORTS,
  requestChatCompletion,
} from '../../src/adapters/llm/openai-compatible-client.js';
import type {
  LlmChatRequest,
  LlmReasoningEffort,
  Transport,
} from '../../src/adapters/llm/openai-compatible-client.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import type { LlmRouteConfig } from '../../src/app/configuration/llm-routes.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import type { EvidenceReasoningEffort } from '../../src/application/interpretation/narrative-evidence.js';
import {
  FIXTURE_LLM_ENV,
  answerAsProviderText,
  asEventStream,
  completionBody,
  fakeTransport,
  validKnownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

const PLAN = buildLlmRoutePlan(FIXTURE_LLM_ENV);
const CHAIN = buildNarrativeChain(knownTimeModel());

function firstRoute(): LlmRouteConfig {
  const [route] = PLAN.routes;
  if (route === undefined) {
    throw new Error('fixture defect: the fixture environment yields no eligible route');
  }
  return route;
}

const ROUTE = firstRoute();

const BASE_REQUEST: LlmChatRequest = {
  system: 'system',
  user: 'user',
  maxTokens: 256,
  temperature: 0,
  jsonObjectMode: true,
  stream: false,
};

/**
 * The request keys every call carried BEFORE this option existed (54d7e30),
 * read off `requestChatCompletion` at that commit. The "absent" half of the
 * contract is the whole key set staying exactly this, not merely one key
 * being missing.
 */
const PRE_OPTION_KEYS_BUFFERED = ['max_tokens', 'messages', 'model', 'response_format', 'temperature'];
const PRE_OPTION_KEYS_STREAMED = [...PRE_OPTION_KEYS_BUFFERED, 'stream', 'stream_options'].sort();

/** Answers in whichever mode the request asked for, and records the parsed body. */
function recordingTransport(): Transport & { readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetch(_url: string, init: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const answer = completionBody('{"ok":true}');
      return Promise.resolve(
        body['stream'] === true
          ? new Response(asEventStream(answer), {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            })
          : new Response(JSON.stringify(answer), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
      );
    },
  };
}

function keysOf(body: Record<string, unknown> | undefined): readonly string[] {
  return Object.keys(body ?? {}).sort();
}

describe('ETBZ-25B reasoning effort: absent unless a caller asks for it', () => {
  it.each([false, true])(
    'sends no reasoning_effort and the pre-option key set when none is set (stream=%s)',
    async (stream) => {
      const transport = recordingTransport();

      await requestChatCompletion(ROUTE, { ...BASE_REQUEST, stream }, transport);

      const [sent] = transport.bodies;
      expect(sent).not.toHaveProperty('reasoning_effort');
      expect(keysOf(sent)).toEqual(
        stream ? PRE_OPTION_KEYS_STREAMED : [...PRE_OPTION_KEYS_BUFFERED].sort(),
      );
    },
  );

  it('leaves the product default without a reasoning effort and its other settings unchanged', () => {
    // The live harness opts in explicitly; the product default does not. And
    // this candidate changes no other generation setting, maxTokens included.
    expect(DEFAULT_LLM_NARRATIVE_OPTIONS).not.toHaveProperty('reasoningEffort');
    expect(DEFAULT_LLM_NARRATIVE_OPTIONS).toEqual({
      maxTokens: 32_000,
      temperature: 0.7,
      stream: true,
    });
  });

  it('sends none through the narrative provider when its default options are used', async () => {
    const transport = fakeTransport([
      { status: 200, body: completionBody(answerAsProviderText(validKnownTimeAnswer())) },
    ]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport);

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.body).not.toHaveProperty('reasoning_effort');
  });
});

describe('ETBZ-25B reasoning effort: exact when set', () => {
  it('declares exactly the three documented values', () => {
    expect(LLM_REASONING_EFFORTS).toEqual(['low', 'high', 'max']);
  });

  it.each(LLM_REASONING_EFFORTS.flatMap((effort) => [[effort, false] as const, [effort, true] as const]))(
    'sends reasoning_effort "%s" verbatim and adds nothing else (stream=%s)',
    async (effort, stream) => {
      const transport = recordingTransport();

      await requestChatCompletion(ROUTE, { ...BASE_REQUEST, stream, reasoningEffort: effort }, transport);

      const [sent] = transport.bodies;
      expect(sent?.['reasoning_effort']).toBe(effort);
      const expected = stream ? PRE_OPTION_KEYS_STREAMED : PRE_OPTION_KEYS_BUFFERED;
      expect(keysOf(sent)).toEqual([...expected, 'reasoning_effort'].sort());
    },
  );

  it('passes the narrative option through to the request', async () => {
    const transport = fakeTransport([
      { status: 200, body: completionBody(answerAsProviderText(validKnownTimeAnswer())) },
    ]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport, {
      ...DEFAULT_LLM_NARRATIVE_OPTIONS,
      reasoningEffort: 'low',
    });

    expect(transport.requests[0]?.body['reasoning_effort']).toBe('low');
    // Only the one variable moved: the budget and the rest are the defaults.
    expect(transport.requests[0]?.body['max_tokens']).toBe(32_000);
  });
});

describe('ETBZ-25B reasoning effort: a closed set at the typed boundary and at runtime', () => {
  it('refuses a value outside the set, and an arbitrary string, at compile time', () => {
    const outside: LlmChatRequest = {
      ...BASE_REQUEST,
      // @ts-expect-error -- 'medium' is a reasoning effort elsewhere, not in this closed set.
      reasoningEffort: 'medium',
    };
    const arbitrary: string = LLM_REASONING_EFFORTS[0];
    const untyped: LlmChatRequest = {
      ...BASE_REQUEST,
      // @ts-expect-error -- a plain string does not pass, even one holding a valid value.
      reasoningEffort: arbitrary,
    };

    // Runtime echo so the two literals above are used; the property under test
    // is that `tsc` accepts this file only because both lines are errors.
    expect([outside.reasoningEffort, untyped.reasoningEffort]).toEqual(['medium', 'low']);
  });

  it.each(['medium', 'LOW', 'Low', ' low', 'max ', '', 'minimal', 'none'])(
    'refuses %j at runtime before any request exists',
    async (value) => {
      const transport = recordingTransport();
      const request = { ...BASE_REQUEST, reasoningEffort: value as LlmReasoningEffort };

      await expect(requestChatCompletion(ROUTE, request, transport)).rejects.toThrow(TypeError);
      expect(transport.bodies).toHaveLength(0);
    },
  );

  it('does not repeat the refused value in its message', async () => {
    const marker = 'UNVALIDATED-EFFORT-MARKER';
    const request = { ...BASE_REQUEST, reasoningEffort: marker as LlmReasoningEffort };

    const error: unknown = await requestChatCompletion(ROUTE, request, recordingTransport()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).message).toContain('low, high, max');
  });
});

describe('ETBZ-25B reasoning effort: route-neutral', () => {
  it('hands the next route the same effort after a transient failure, and changes nothing but the model', async () => {
    const transport = fakeTransport([
      { status: 429, body: { error: { message: 'rate limited' } } },
      { status: 200, body: completionBody(answerAsProviderText(validKnownTimeAnswer())) },
    ]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport, {
      ...DEFAULT_LLM_NARRATIVE_OPTIONS,
      reasoningEffort: 'low',
    });

    expect(result.acceptedRouteId).toBe('opencode');
    expect(transport.requests.map((request) => request.body['reasoning_effort'])).toEqual([
      'low',
      'low',
    ]);
    const [first, second] = transport.requests.map((request) => ({ ...request.body, model: null }));
    expect(second).toEqual(first);
  });

  it('keeps the evidence mirror of the set identical to the adapter set (compile-time)', () => {
    type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const mirrorMatches: MutuallyAssignable<EvidenceReasoningEffort, LlmReasoningEffort> = true;
    expect(mirrorMatches).toBe(true);
  });

  it.each(['openai-compatible-client.ts', 'llm-narrative-provider.ts'])(
    'src/adapters/llm/%s names no model family and writes reasoning_effort in one statement at most',
    (file) => {
      // Model ids are configuration. The effort is a generic request field, not
      // a GLM switch, so neither module may name the model it was added for.
      const source = readFileSync(resolve(process.cwd(), 'src/adapters/llm', file), 'utf8');
      expect(source).not.toMatch(/glm/i);
      expect(source.split("payload['reasoning_effort']").length - 1).toBeLessThanOrEqual(1);
    },
  );
});
