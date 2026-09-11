/**
 * ETBZ-25B — the STREAMING transport path.
 *
 * Streaming is the production default (`DEFAULT_LLM_NARRATIVE_OPTIONS.stream`),
 * and it exists for a measured reason recorded in the client: the approved free
 * route spends minutes reasoning before its first content token, and Node's
 * unconfigurable 300-second headers timeout kills a buffered request to it
 * outright. A default that the test suite did not exercise would mean the live
 * path and the verified path were different code — so this file covers it.
 *
 * The properties that matter are the ones a naive accumulator gets wrong:
 * chunk boundaries that fall mid-line, keep-alive frames that are not JSON, a
 * usage block that arrives in its own final frame, and a stream that carries no
 * content at all.
 */

import { describe, expect, it } from 'vitest';
import {
  CHAT_COMPLETIONS_PATH,
  LlmProviderError,
  requestChatCompletion,
} from '../../src/adapters/llm/openai-compatible-client.js';
import type { LlmChatRequest, Transport } from '../../src/adapters/llm/openai-compatible-client.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import type { LlmRouteConfig } from '../../src/app/configuration/llm-routes.js';
import { FIXTURE_LLM_ENV, asEventStream, completionBody } from '../support/llmNarrativeFixture.js';

function firstRoute(): LlmRouteConfig {
  const [route] = buildLlmRoutePlan(FIXTURE_LLM_ENV).routes;
  if (route === undefined) {
    throw new Error('fixture defect: the fixture environment yields no eligible route');
  }
  return route;
}

const ROUTE = firstRoute();

const STREAMING_REQUEST: LlmChatRequest = {
  system: 'system',
  user: 'user',
  maxTokens: 4096,
  temperature: 0,
  jsonObjectMode: true,
  stream: true,
};

/** A transport that answers with a body of our choosing and records the request. */
function transportServing(
  bodyText: string,
  status = 200,
): Transport & { readonly seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    fetch(_url: string, init: RequestInit): Promise<Response> {
      seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(bodyText, {
          status,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    },
  };
}

describe('ETBZ-25B streaming: the request', () => {
  it('asks for a stream and for the usage block, and still pins the model and path', async () => {
    const transport = transportServing(asEventStream(completionBody('{"ok":true}')));

    await requestChatCompletion(ROUTE, STREAMING_REQUEST, transport);

    const [sent] = transport.seen;
    expect(sent?.['stream']).toBe(true);
    // Without this, a provider reports no usage at all on a streamed answer and
    // the evidence record would silently carry nulls where numbers exist.
    expect(sent?.['stream_options']).toEqual({ include_usage: true });
    expect(sent?.['model']).toBe(ROUTE.model);
  });

  it('omits the streaming fields entirely when the caller asked for a buffered answer', async () => {
    const transport = transportServing(JSON.stringify(completionBody('{"ok":true}')));

    await requestChatCompletion(ROUTE, { ...STREAMING_REQUEST, stream: false }, transport);

    const [sent] = transport.seen;
    expect(sent).not.toHaveProperty('stream');
    expect(sent).not.toHaveProperty('stream_options');
  });

  it('targets the same pinned path as the buffered request', async () => {
    const seen: string[] = [];
    const transport: Transport = {
      fetch(url: string): Promise<Response> {
        seen.push(url);
        return Promise.resolve(
          new Response(asEventStream(completionBody('{"ok":true}')), { status: 200 }),
        );
      },
    };

    await requestChatCompletion(ROUTE, STREAMING_REQUEST, transport);

    expect(seen).toEqual([`${ROUTE.baseUrl}${CHAT_COMPLETIONS_PATH}`]);
  });
});

describe('ETBZ-25B streaming: accumulation', () => {
  it('reassembles the content, the finish reason, the id and the usage', async () => {
    const transport = transportServing(
      asEventStream(completionBody('{"sections":[]}')),
    );

    const completion = await requestChatCompletion(ROUTE, STREAMING_REQUEST, transport);

    expect(completion.content).toBe('{"sections":[]}');
    expect(completion.finishReason).toBe('stop');
    expect(completion.responseId).toBe('cmpl-fixture');
    expect(completion.model).toBe('fixture-model-free');
    expect(completion.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 800,
      totalTokens: 2000,
    });
  });

  it('produces the SAME completion as the buffered path for the same answer', async () => {
    // The two transport modes must be indistinguishable to every caller above
    // them, otherwise the tests exercise one code path and production uses the
    // other.
    const body = completionBody('{"sections":[{"themeId":"x"}]}');
    const streamed = await requestChatCompletion(
      ROUTE,
      STREAMING_REQUEST,
      transportServing(asEventStream(body)),
    );
    const buffered = await requestChatCompletion(
      ROUTE,
      { ...STREAMING_REQUEST, stream: false },
      transportServing(JSON.stringify(body)),
    );

    expect(streamed).toEqual(buffered);
  });

  it('survives a chunk boundary that falls in the middle of a data line', async () => {
    // The real failure mode of a naive accumulator. The fixture stream is split
    // at an arbitrary byte and delivered as two reads; a parser that assumed
    // each chunk ends on a newline loses the frame that straddles the split.
    const full = asEventStream(completionBody('{"sections":[1,2,3]}'));
    const cut = Math.floor(full.length / 2);
    const encoder = new TextEncoder();
    const transport: Transport = {
      fetch(): Promise<Response> {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(full.slice(0, cut)));
            controller.enqueue(encoder.encode(full.slice(cut)));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      },
    };

    const completion = await requestChatCompletion(ROUTE, STREAMING_REQUEST, transport);

    expect(completion.content).toBe('{"sections":[1,2,3]}');
  });

  it('ignores keep-alive and comment frames instead of failing on them', async () => {
    // Providers interleave these. Treating one as a contract violation would
    // refuse a perfectly good reading.
    const noise = [
      ': keep-alive\n\n',
      'data: \n\n',
      'data: not-json-at-all\n\n',
      asEventStream(completionBody('{"ok":1}')),
    ].join('');

    const completion = await requestChatCompletion(
      ROUTE,
      STREAMING_REQUEST,
      transportServing(noise),
    );

    expect(completion.content).toBe('{"ok":1}');
  });

  it('reports usage as nulls when the provider streamed none', async () => {
    const withoutUsage = completionBody('{"ok":1}');
    delete withoutUsage['usage'];

    const completion = await requestChatCompletion(
      ROUTE,
      STREAMING_REQUEST,
      transportServing(asEventStream(withoutUsage)),
    );

    // Null means "not reported". Zero would be a measurement nobody made.
    expect(completion.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });
});

describe('ETBZ-25B streaming: refusals', () => {
  it('refuses a stream that carried no content, and calls it TERMINAL', async () => {
    // A route that answered and said nothing has not had an availability
    // problem, so this must never authorise trying another provider.
    const empty = 'data: {"id":"x","choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n';
    const transport = transportServing(empty);

    await expect(
      requestChatCompletion(ROUTE, STREAMING_REQUEST, transport),
    ).rejects.toMatchObject({
      code: 'LLM_CONTRACT_ERROR',
      failureClass: 'terminal',
    });
  });

  it('classifies a non-200 the same way whether or not a stream was requested', async () => {
    // The status is decided before the body is read, so a streamed request that
    // is rate limited is still a transient 429 rather than a stream failure.
    const transport = transportServing(JSON.stringify({ error: 'rate limited' }), 429);

    const error = await requestChatCompletion(ROUTE, STREAMING_REQUEST, transport).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      code: 'LLM_RATE_LIMITED',
      failureClass: 'transient',
      status: 429,
    });
  });

  it('never puts the credential into a streaming failure message', async () => {
    const transport = transportServing('data: [DONE]\n\n');

    const error = await requestChatCompletion(ROUTE, STREAMING_REQUEST, transport).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as Error).message).not.toContain(ROUTE.apiKey);
  });
});
