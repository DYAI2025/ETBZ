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
 * chunk boundaries that fall mid-line, a usage block that arrives in its own
 * final frame, and a stream that carries no content at all.
 *
 * And the two-sided rule about what may be skipped. A frame that makes no claim
 * to carry completion data — an SSE comment, a keep-alive, an empty payload,
 * `[DONE]` — is ignored. A `data:` frame that CLAIMS a chunk and does not carry
 * one is a TERMINAL contract failure that must not authorise failover. The
 * second half is covered here because it used to be the opposite, and because
 * the one line that can silently undo it lives two functions away.
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

  it('ignores comment lines and empty data payloads, which claim no chunk', async () => {
    // Providers interleave these while a model thinks — OpenRouter sends
    // ': OPENROUTER PROCESSING' every few seconds. None of them says it carries
    // completion data, so none of them can be a contract violation; refusing one
    // would refuse a perfectly good reading. A 'data:' frame that DOES claim a
    // chunk is a different matter entirely — see the refusals below.
    const noise = [
      ': keep-alive\n\n',
      ': OPENROUTER PROCESSING\n\n',
      'data: \n\n',
      'event: ping\n\n',
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
  it('refuses a malformed data frame MID-STREAM, and calls it TERMINAL', async () => {
    // THE REGRESSION TEST FOR THE WHOLE REPAIR. A frame that says 'data:' and
    // then does not carry a JSON chunk is corrupted content, not a bad minute on
    // the network. Classing it transient would let corrupted content buy
    // permission to call the next provider, which is provider shopping.
    //
    // The bad frame sits in the MIDDLE on purpose. A stream ending on it would
    // be read from the residual buffer instead, where an unterminated line is
    // correctly transient — and this test would then pass while the in-stream
    // path stayed broken.
    const stream = [
      'data: {"id":"x","choices":[{"delta":{"content":"{"}}]}\n\n',
      'data: {not json at all}\n\n',
      'data: {"choices":[{"delta":{"content":"}"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    await expect(
      requestChatCompletion(ROUTE, STREAMING_REQUEST, transportServing(stream)),
    ).rejects.toMatchObject({
      code: 'LLM_CONTRACT_ERROR',
      failureClass: 'terminal',
    });
  });

  it('refuses a data frame whose payload parses but is not an object', async () => {
    // 'null', a bare number, a bare string and an ARRAY all survive JSON.parse.
    // Read as a chunk, each yields an object with every field undefined and is
    // skipped in silence — a corrupted frame that looks exactly like a keep-alive.
    //
    // EVERY STREAM HERE CARRIES REAL CONTENT AROUND THE BAD FRAME, and that is
    // not decoration. With the bad frame alone, the stream yields no content and
    // the pre-existing empty-content check throws the identical
    // LLM_CONTRACT_ERROR/terminal this test matches — so the test would pass
    // whether the frame was refused or silently dropped, and could never fail for
    // its own reason. With content present, a silent skip RESOLVES.
    for (const payload of ['null', '42', '"a string"', '["corrupted"]']) {
      const stream = [
        'data: {"id":"x","choices":[{"delta":{"content":"{\\"ok\\":1}"}}]}\n\n',
        `data: ${payload}\n\n`,
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      await expect(
        requestChatCompletion(ROUTE, STREAMING_REQUEST, transportServing(stream)),
        `payload ${payload} must be refused`,
      ).rejects.toMatchObject({
        code: 'LLM_CONTRACT_ERROR',
        failureClass: 'terminal',
      });
    }
  });

  it('refuses an in-band error frame and keeps nothing that streamed before it', async () => {
    // A provider that has already sent 200 reports a mid-answer failure inside
    // the stream, because the status line is long gone. The frame carries no
    // `choices`, so it used to be skipped in silence and the text streamed
    // before it was returned as a COMPLETE answer with `finishReason: null` —
    // which `isIncompleteFinishReason` does not consider incomplete, so the run
    // recorded the provider's own failure report as `outcome: 'accepted'`.
    // Measured before the fix: this exact stream resolved with "partial answer".
    const stream =
      'data: {"id":"a","choices":[{"delta":{"content":"partial answer"}}]}\n\n' +
      'data: {"error":{"code":429,"message":"rate limited upstream"}}\n\n';

    const error = await requestChatCompletion(
      ROUTE,
      STREAMING_REQUEST,
      transportServing(stream),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      code: 'LLM_CONTRACT_ERROR',
      failureClass: 'terminal',
    });
    // Rule 4: the partial text is discarded with the throw, never returned and
    // never handed to another provider.
    expect((error as { message: string }).message).not.toContain('partial answer');
    // And the refusal does not republish the provider's error text either.
    expect((error as { message: string }).message).not.toContain('rate limited upstream');
  });

  it('calls a stream that CLOSED mid-frame transient, not a contract failure', async () => {
    // The other side of the same rule, and the reason the two positions are
    // classified differently. Here the provider did not send a bad frame: the
    // connection ended before the frame was finished, leaving an unterminated
    // line in the buffer. That line is incomplete by construction, so it says
    // nothing about what the provider meant — it is an availability failure and
    // failover IS authorised.
    const cut =
      'data: {"id":"x","choices":[{"delta":{"content":"hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"wor';

    const error = await requestChatCompletion(
      ROUTE,
      STREAMING_REQUEST,
      transportServing(cut),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      code: 'LLM_NETWORK_ERROR',
      failureClass: 'transient',
    });
    // And nothing partial escapes: the content accumulated before the cut is
    // discarded with the throw rather than returned as a complete reading.
    expect((error as { message: string }).message).not.toContain('hello');
  });

  it('never republishes the offending payload in the refusal message', async () => {
    // A refusal does not republish what it refuses. The payload is unvalidated
    // provider output and the message is logged and travels beside evidence;
    // JSON.parse's own message cannot be forwarded either, because it quotes the
    // source text verbatim.
    //
    // THE PAYLOAD IS A BARE TOKEN, NOT '{...}', and that is what makes this test
    // able to fail. V8 quotes the offending source only for some shapes: for
    // '{MARKER}' it reports "Expected property name or '}' … at position 1" and
    // names nothing, so a regression that forwarded the parser message would
    // still have passed. For a bare token it reports
    // `Unexpected token 'S', "SECRET-LOO"... is not valid JSON` — it quotes the
    // first ten characters. Measured both ways; the assertion targets that
    // prefix, so forwarding the parser's message now goes red.
    const marker = 'SECRET-LOOKING-PAYLOAD-CONTENT';
    const quotedPrefix = marker.slice(0, 10);
    const error = await requestChatCompletion(
      ROUTE,
      STREAMING_REQUEST,
      transportServing(`data: ${marker}\n\ndata: [DONE]\n\n`),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    const { message } = error as { message: string };
    expect(message).not.toContain(marker);
    // The half that a brace-wrapped payload could never have caught.
    expect(message).not.toContain(quotedPrefix);
    expect(message).not.toContain('is not valid JSON');
  });

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
