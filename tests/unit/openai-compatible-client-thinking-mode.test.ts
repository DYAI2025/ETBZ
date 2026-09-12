/**
 * ETBZ-25B — the optional THINKING MODE, at the generic transport boundary.
 *
 * A second optional request field, added for a route whose endpoint documents
 * `thinking: { type }` rather than `reasoning_effort`. These tests pin how far
 * it reaches and no further:
 *
 *   ABSENT BY DEFAULT  a request that sets no mode carries no `thinking` field,
 *                      and its key set is exactly the one every request carried
 *                      before the option existed. The product default sets none.
 *   EXACT WHEN SET     `disabled` and `enabled` each travel as the documented
 *                      OBJECT, in both transport modes, with no extra key.
 *   CLOSED             anything else is refused by the type AND at runtime,
 *                      before a request exists.
 *   INDEPENDENT        it is not `reasoning_effort` renamed: each field can be
 *                      sent without the other, and sending both sends both.
 *   ROUTE-NEUTRAL      the option lives in the one generic request, and neither
 *                      LLM module names a model.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_NARRATIVE_OPTIONS,
  generateNarrativeFromPlan,
} from '../../src/adapters/llm/llm-narrative-provider.js';
import {
  LLM_THINKING_MODES,
  requestChatCompletion,
} from '../../src/adapters/llm/openai-compatible-client.js';
import type {
  LlmChatRequest,
  LlmThinkingMode,
  Transport,
} from '../../src/adapters/llm/openai-compatible-client.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import type { LlmRouteConfig } from '../../src/app/configuration/llm-routes.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
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
 * The request keys every call carried BEFORE this option existed. The "absent"
 * half of the contract is the whole key set staying exactly this, not merely
 * `thinking` being missing.
 */
const PRE_OPTION_KEYS_BUFFERED = [
  'max_tokens',
  'messages',
  'model',
  'response_format',
  'temperature',
];
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

describe('ETBZ-25B thinking mode: absent unless a caller asks for it', () => {
  it.each([false, true])(
    'sends no thinking field and the pre-option key set when none is set (stream=%s)',
    async (stream) => {
      const transport = recordingTransport();

      await requestChatCompletion(ROUTE, { ...BASE_REQUEST, stream }, transport);

      const [sent] = transport.bodies;
      expect(sent).not.toHaveProperty('thinking');
      expect(keysOf(sent)).toEqual(
        stream ? PRE_OPTION_KEYS_STREAMED : [...PRE_OPTION_KEYS_BUFFERED].sort(),
      );
    },
  );

  it('leaves the product default without a thinking mode and its other settings unchanged', () => {
    // The default run sends no `thinking` field at all. Pinned as the WHOLE
    // object so adding any generation setting here has to be a deliberate edit.
    expect(DEFAULT_LLM_NARRATIVE_OPTIONS).not.toHaveProperty('thinkingMode');
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
    expect(transport.requests[0]?.body).not.toHaveProperty('thinking');
  });
});

describe('ETBZ-25B thinking mode: the exact documented object when set', () => {
  it('declares exactly the two documented values', () => {
    expect(LLM_THINKING_MODES).toEqual(['enabled', 'disabled']);
  });

  it.each(
    LLM_THINKING_MODES.flatMap((mode) => [[mode, false] as const, [mode, true] as const]),
  )('sends thinking { type: "%s" } and adds nothing else (stream=%s)', async (mode, stream) => {
    const transport = recordingTransport();

    await requestChatCompletion(ROUTE, { ...BASE_REQUEST, stream, thinkingMode: mode }, transport);

    const [sent] = transport.bodies;
    // The OBJECT, asserted with toEqual so an extra key such as
    // `clear_thinking` cannot be smuggled in beside the type.
    expect(sent?.['thinking']).toEqual({ type: mode });
    const expected = stream ? PRE_OPTION_KEYS_STREAMED : PRE_OPTION_KEYS_BUFFERED;
    expect(keysOf(sent)).toEqual([...expected, 'thinking'].sort());
  });

  it('does not send the mode as a bare string', async () => {
    // The counterexample that makes the assertion above mean something: a string
    // under the same key is a DIFFERENT field, and an endpoint reading
    // `thinking.type` would find nothing at all.
    const transport = recordingTransport();

    await requestChatCompletion(ROUTE, { ...BASE_REQUEST, thinkingMode: 'disabled' }, transport);

    const [sent] = transport.bodies;
    expect(typeof sent?.['thinking']).toBe('object');
    expect(sent?.['thinking']).not.toBe('disabled');
  });

  it('passes the narrative option through to the request', async () => {
    const transport = fakeTransport([
      { status: 200, body: completionBody(answerAsProviderText(validKnownTimeAnswer())) },
    ]);

    await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport, {
      ...DEFAULT_LLM_NARRATIVE_OPTIONS,
      thinkingMode: 'disabled',
    });

    expect(transport.requests[0]?.body['thinking']).toEqual({ type: 'disabled' });
    // Only the one variable moved: the budget and the rest are the defaults.
    expect(transport.requests[0]?.body['max_tokens']).toBe(32_000);
    expect(transport.requests[0]?.body).not.toHaveProperty('reasoning_effort');
  });
});

describe('ETBZ-25B thinking mode: a closed set at the typed boundary and at runtime', () => {
  it('refuses a value outside the set, and an arbitrary string, at compile time', () => {
    const outside: LlmChatRequest = {
      ...BASE_REQUEST,
      // @ts-expect-error -- 'off' is how another provider spells it, not this closed set.
      thinkingMode: 'off',
    };
    const arbitrary: string = LLM_THINKING_MODES[0];
    const untyped: LlmChatRequest = {
      ...BASE_REQUEST,
      // @ts-expect-error -- a plain string does not pass, even one holding a valid value.
      thinkingMode: arbitrary,
    };

    // Runtime echo so the two literals above are used; the property under test
    // is that `tsc` accepts this file only because both lines are errors.
    expect([outside.thinkingMode, untyped.thinkingMode]).toEqual(['off', 'enabled']);
  });

  it.each(['off', 'on', 'DISABLED', 'Disabled', ' disabled', 'enabled ', '', 'auto', 'none'])(
    'refuses %j at runtime before any request exists',
    async (value) => {
      const transport = recordingTransport();
      const request = { ...BASE_REQUEST, thinkingMode: value as LlmThinkingMode };

      await expect(requestChatCompletion(ROUTE, request, transport)).rejects.toThrow(TypeError);
      expect(transport.bodies).toHaveLength(0);
    },
  );

  it('does not repeat the refused value in its message', async () => {
    const marker = 'UNVALIDATED-THINKING-MARKER';
    const request = { ...BASE_REQUEST, thinkingMode: marker as LlmThinkingMode };

    const error: unknown = await requestChatCompletion(ROUTE, request, recordingTransport()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(marker);
    expect((error as Error).message).toContain('enabled, disabled');
  });
});

describe('ETBZ-25B thinking mode: independent of reasoning effort', () => {
  it('leaves reasoning_effort behaviour exactly as it was when only thinking is set', async () => {
    const transport = recordingTransport();

    await requestChatCompletion(ROUTE, { ...BASE_REQUEST, thinkingMode: 'disabled' }, transport);

    const [sent] = transport.bodies;
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(sent?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('leaves thinking absent when only reasoning_effort is set', async () => {
    // The other direction, which is what makes them two fields rather than one
    // field with two spellings.
    const transport = recordingTransport();

    await requestChatCompletion(ROUTE, { ...BASE_REQUEST, reasoningEffort: 'low' }, transport);

    const [sent] = transport.bodies;
    expect(sent?.['reasoning_effort']).toBe('low');
    expect(sent).not.toHaveProperty('thinking');
  });

  it('sends both, unmodified, when a caller sets both', async () => {
    const transport = recordingTransport();

    await requestChatCompletion(
      ROUTE,
      { ...BASE_REQUEST, reasoningEffort: 'low', thinkingMode: 'disabled' },
      transport,
    );

    const [sent] = transport.bodies;
    expect(sent?.['reasoning_effort']).toBe('low');
    expect(sent?.['thinking']).toEqual({ type: 'disabled' });
    expect(keysOf(sent)).toEqual(
      [...PRE_OPTION_KEYS_BUFFERED, 'reasoning_effort', 'thinking'].sort(),
    );
  });

  it('refuses an invalid thinking mode even when the reasoning effort is valid', async () => {
    // A valid neighbour must not buy a pass for an invalid value, and nothing is
    // dispatched when one is present.
    const transport = recordingTransport();
    const request = {
      ...BASE_REQUEST,
      reasoningEffort: 'low' as const,
      thinkingMode: 'off' as LlmThinkingMode,
    };

    await expect(requestChatCompletion(ROUTE, request, transport)).rejects.toThrow(TypeError);
    expect(transport.bodies).toHaveLength(0);
  });
});

describe('ETBZ-25B thinking mode: route-neutral', () => {
  it('hands the next route the same mode after a transient failure', async () => {
    const transport = fakeTransport([
      { status: 429, body: { error: { message: 'rate limited' } } },
      { status: 200, body: completionBody(answerAsProviderText(validKnownTimeAnswer())) },
    ]);

    const result = await generateNarrativeFromPlan(CHAIN.brief, PLAN, transport, {
      ...DEFAULT_LLM_NARRATIVE_OPTIONS,
      thinkingMode: 'disabled',
    });

    expect(result.acceptedRouteId).toBe('opencode');
    expect(transport.requests.map((request) => request.body['thinking'])).toEqual([
      { type: 'disabled' },
      { type: 'disabled' },
    ]);
    const [first, second] = transport.requests.map((request) => ({ ...request.body, model: null }));
    expect(second).toEqual(first);
  });

  it.each(['openai-compatible-client.ts', 'llm-narrative-provider.ts'])(
    'src/adapters/llm/%s names no model family and writes the thinking payload once at most',
    (file) => {
      // Model ids are configuration. The mode is a generic request field, not a
      // GLM switch, so neither module may name the model it was added for.
      const source = readFileSync(resolve(process.cwd(), 'src/adapters/llm', file), 'utf8');
      expect(source).not.toMatch(/glm/i);
      // A QUOTED route-id literal is what a per-provider branch looks like;
      // the provider's name in prose is not, and this file already relies on
      // the /glm/i ban above to keep the model family out.
      expect(source).not.toMatch(/['"]zai['"]/);
      expect(source.split("payload['thinking']").length - 1).toBeLessThanOrEqual(1);
    },
  );
});
