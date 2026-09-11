/**
 * ETBZ-25B — ONE generic OpenAI-compatible chat client for every approved route.
 *
 * The Product Owner contract is explicit: "Use one generic OpenAI-compatible
 * provider adapter where the current provider endpoint is OpenAI-compatible. Do
 * not create provider-specific domain abstractions unless a freshly verified
 * provider contract makes that necessary." All four approved routes speak
 * `POST {baseUrl}/chat/completions` with a bearer credential, so this file is
 * the whole provider surface and there is no per-provider subclass anywhere.
 *
 * Rules enforced here, mirroring the FuFirE boundary client:
 *  - the URL is SERVER-OWNED: `{baseUrl}` comes from the route plan and the path
 *    is pinned. No caller and no model output can redirect the request;
 *  - the credential is SERVER-OWNED: injected at composition time, sent as an
 *    `Authorization: Bearer` header, never accepted from user input, never
 *    logged, never placed in an error message;
 *  - NO substitution and NO repair: every failure is an explicit typed error;
 *  - the response is validated structurally before anything reads it.
 *
 * THE ONE THING THIS FILE DECIDES that the rest of the slice depends on:
 * whether a failure is TRANSIENT or TERMINAL. The contract allows failover to
 * the next approved route only for "bounded technical availability failures …
 * network/connectivity failure, timeout, 429, or explicitly classified
 * transient 5xx". Everything else must fail closed. The classification is
 * therefore a STRICT allowlist of transient conditions rather than a denylist
 * of terminal ones: a status nobody has classified is terminal, so a new
 * provider behaviour cannot silently acquire permission to shop for a different
 * answer.
 *
 * Note in particular that `404 model not found` is TERMINAL. It is tempting to
 * read a vanished model as an availability problem, but it is a configuration
 * fact: the route is pointed at something that does not exist, and quietly
 * moving to another provider would hide exactly the drift the Product Owner
 * asked to have surfaced.
 */

import type { LlmRouteConfig } from '../../app/configuration/llm-routes.js';

export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export type LlmFailureClass = 'transient' | 'terminal';

export type LlmErrorCode =
  /** The request did not complete within the route's timeout. */
  | 'LLM_TIMEOUT'
  /** The connection failed before a response existed. */
  | 'LLM_NETWORK_ERROR'
  /** HTTP 429 — the route is rate limited or its free quota is exhausted. */
  | 'LLM_RATE_LIMITED'
  /** An explicitly classified transient server failure. */
  | 'LLM_SERVER_ERROR'
  /** HTTP 401/403 — the credential is rejected. Never a reason to fail over. */
  | 'LLM_AUTH_FAILED'
  /** HTTP 400/404/422 — the route rejected the request or the model is gone. */
  | 'LLM_ROUTE_REJECTED'
  /** The response is not the shape an OpenAI-compatible endpoint promises. */
  | 'LLM_CONTRACT_ERROR';

/**
 * Transient status codes, enumerated. Anything absent here is TERMINAL.
 *
 * The contract authorises failover for "network/connectivity failure, timeout,
 * `429`, or explicitly classified transient `5xx`" and nothing else. `408` is
 * the timeout spelled as a status. `409 Conflict` and `425 Too Early` were
 * removed after review: both are 4xx, neither is in the contract's allowlist,
 * and admitting them would have widened the permission to shop for a different
 * provider beyond what the Product Owner granted.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export class LlmProviderError extends Error {
  readonly code: LlmErrorCode;
  readonly failureClass: LlmFailureClass;
  readonly routeId: string;
  readonly status: number | undefined;

  constructor(
    code: LlmErrorCode,
    failureClass: LlmFailureClass,
    routeId: string,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    this.failureClass = failureClass;
    this.routeId = routeId;
    this.status = status;
  }
}

/** Token counts, exactly as the provider reported them. Never invented. */
export interface LlmUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface LlmCompletion {
  readonly routeId: string;
  /** The model the PROVIDER says answered, which can differ from the request. */
  readonly model: string;
  /** Provider-side response id, when one is returned. Useful for support. */
  readonly responseId: string | null;
  readonly content: string;
  readonly finishReason: string | null;
  readonly usage: LlmUsage;
}

export interface LlmChatRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  /** Zero by default: a reading should not vary for reasons nobody chose. */
  readonly temperature: number;
  /**
   * Ask the provider for a JSON object.
   *
   * Sent as a HINT, never relied upon: at least one approved route accepts a
   * `json_schema` request and answers with free prose anyway. The answer is
   * parsed and validated locally regardless, which is why an unsupported value
   * here can never widen what reaches the report.
   */
  readonly jsonObjectMode: boolean;
  /**
   * Read the answer as a token stream rather than one buffered response.
   *
   * THIS IS A TRANSPORT DECISION, NOT A PRODUCT ONE, and it exists for a
   * measured reason. The approved free route is a reasoning model: on the real
   * brief it spends between seven and eight minutes thinking before it emits its
   * first content token. Node's HTTP client applies a 300-second *headers*
   * timeout that no `fetch` option can raise, so a buffered request to that
   * model fails with `UND_ERR_HEADERS_TIMEOUT` before the model has said
   * anything — measured, not assumed. Streaming makes the response headers
   * arrive in seconds and the body flow afterwards, which is the difference
   * between "this provider is unusable" and "this provider is slow".
   *
   * IT IS NOT CONTINUATION. The stream is accumulated here, from ONE route, and
   * the completion is returned only once that route has finished. A stream that
   * fails part-way retains nothing: the partial text is discarded with the
   * attempt, and no other provider is ever handed a half-written reading. The
   * contract's ban on mid-stream cross-provider continuation and on blending
   * partial outputs is therefore untouched by this flag.
   */
  readonly stream: boolean;
}

export interface Transport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

interface RawChoice {
  readonly message?: { readonly content?: unknown } | undefined;
  readonly finish_reason?: unknown;
}

interface RawCompletion {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly choices?: unknown;
  readonly usage?: unknown;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUsage(raw: unknown): LlmUsage {
  if (typeof raw !== 'object' || raw === null) {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const usage = raw as Record<string, unknown>;
  return {
    promptTokens: numberOrNull(usage['prompt_tokens']),
    completionTokens: numberOrNull(usage['completion_tokens']),
    totalTokens: numberOrNull(usage['total_tokens']),
  };
}

/**
 * Classifies a completed HTTP response.
 *
 * Exported so the classification is testable on its own: the failover
 * behaviour of the whole slice rests on this function, and a rule that is only
 * exercised through a network call is a rule nobody has measured.
 */
export function classifyStatus(status: number): {
  code: LlmErrorCode;
  failureClass: LlmFailureClass;
} {
  if (status === 401 || status === 403) {
    return { code: 'LLM_AUTH_FAILED', failureClass: 'terminal' };
  }
  if (status === 429) {
    return { code: 'LLM_RATE_LIMITED', failureClass: 'transient' };
  }
  if (TRANSIENT_STATUSES.has(status)) {
    return { code: 'LLM_SERVER_ERROR', failureClass: 'transient' };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { code: 'LLM_ROUTE_REJECTED', failureClass: 'terminal' };
  }
  return { code: 'LLM_CONTRACT_ERROR', failureClass: 'terminal' };
}

interface StreamDelta {
  readonly delta?: { readonly content?: unknown } | undefined;
  readonly finish_reason?: unknown;
}

interface StreamChunk {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly choices?: unknown;
  readonly usage?: unknown;
}

/**
 * Accumulates a Server-Sent Events response into one completion.
 *
 * Every field the buffered path reports is reconstructed here — id, model,
 * finish reason and usage — so a caller cannot tell the two paths apart, which
 * is what lets the whole test suite exercise the same code the live run uses.
 *
 * A chunk that does not parse is SKIPPED rather than fatal: providers interleave
 * comments and keep-alives into an SSE stream, and treating a keep-alive as a
 * contract violation would refuse perfectly good readings. A stream that yields
 * no content at all is still a contract failure, caught by the same empty-content
 * check the buffered path applies.
 */
async function readStreamedCompletion(
  route: LlmRouteConfig,
  response: Response,
): Promise<LlmCompletion> {
  const body = response.body;
  if (body === null) {
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" answered a stream with no body`,
      response.status,
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let finishReason: string | null = null;
  let responseId: string | null = null;
  let model: string | null = null;
  let usage: LlmUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

  const consume = (line: string): void => {
    if (!line.startsWith('data:')) {
      return;
    }
    const payload = line.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') {
      return;
    }
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return;
    }
    if (responseId === null && typeof chunk.id === 'string') {
      responseId = chunk.id;
    }
    if (model === null && typeof chunk.model === 'string') {
      model = chunk.model;
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = readUsage(chunk.usage);
    }
    if (!Array.isArray(chunk.choices)) {
      return;
    }
    const [choice] = chunk.choices as readonly StreamDelta[];
    const piece = choice?.delta?.content;
    if (typeof piece === 'string') {
      content += piece;
    }
    if (typeof choice?.finish_reason === 'string') {
      finishReason = choice.finish_reason;
    }
  };

  // The read loop needs the SAME failure classification the request did.
  //
  // Without this, the deadline firing mid-body threw a raw `AbortError` out of
  // `reader.read()` — past the classification, past the attempt ledger, past
  // failover — so a slow provider surfaced as an unclassified crash instead of
  // as a transient `LLM_TIMEOUT` attempt. Measured on a real run: the abort
  // fired correctly at the route deadline and the run still ended with no
  // usable evidence, because the error never became one of ours. With a streamed
  // answer the body is where nearly all the time is spent, so this is the more
  // likely place to time out, not the less.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      // The final element is whatever arrived after the last newline: an
      // incomplete line that must wait for the next chunk rather than be parsed.
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        consume(line);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmProviderError(
        'LLM_TIMEOUT',
        'transient',
        route.routeId,
        `route "${route.routeId}" stopped streaming before it finished answering, after ${String(route.timeoutMs)}ms`,
      );
    }
    const reason = error instanceof Error ? error.message : 'unknown stream failure';
    // A stream that breaks part-way is an AVAILABILITY failure, so failover is
    // authorised — and nothing partial is retained: `content` is discarded with
    // this throw, which is what keeps rule 4 (no continuation, no blending)
    // true even when a route dies halfway through a reading.
    throw new LlmProviderError(
      'LLM_NETWORK_ERROR',
      'transient',
      route.routeId,
      `route "${route.routeId}" stream failed: ${reason}`,
    );
  }
  consume(buffered);

  if (content.trim().length === 0) {
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" streamed no message content`,
      response.status,
    );
  }

  return {
    routeId: route.routeId,
    model: model ?? route.model,
    responseId,
    content,
    finishReason,
    usage,
  };
}

/**
 * Calls one route once.
 *
 * It does not retry, does not fail over and knows nothing about other routes —
 * that decision belongs to `llm-narrative-provider.ts`, where it can be made
 * against the contract's failover rules rather than buried in a transport.
 */
export async function requestChatCompletion(
  route: LlmRouteConfig,
  request: LlmChatRequest,
  transport: Transport,
): Promise<LlmCompletion> {
  const url = `${route.baseUrl}${CHAT_COMPLETIONS_PATH}`;
  const payload: Record<string, unknown> = {
    model: route.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    max_tokens: request.maxTokens,
    temperature: request.temperature,
  };
  if (request.jsonObjectMode) {
    payload['response_format'] = { type: 'json_object' };
  }
  if (request.stream) {
    payload['stream'] = true;
    // Ask for the usage block on the final chunk. Providers that do not know
    // this option ignore it, and `readUsage` then reports nulls rather than
    // zeros — "not reported" and "measured as zero" must not look alike.
    payload['stream_options'] = { include_usage: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, route.timeoutMs);

  try {
    return await sendAndRead(route, request, transport, url, payload, controller);
  } finally {
    // Cleared only once the ANSWER IS COMPLETE, not once the headers arrive.
    // With a streamed response those are minutes apart, and a timer cleared at
    // the headers would leave a stalled body with no deadline at all: the run
    // would hang forever with no timeout, no failover and no refusal. The
    // deadline has to cover the thing that actually takes the time.
    clearTimeout(timer);
  }
}

async function sendAndRead(
  route: LlmRouteConfig,
  request: LlmChatRequest,
  transport: Transport,
  url: string,
  payload: Record<string, unknown>,
  controller: AbortController,
): Promise<LlmCompletion> {
  let response: Response;
  try {
    response = await transport.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The credential. It appears here and in no other statement of this
        // module: no branch below reads `route.apiKey` again, so no error
        // message can carry it.
        Authorization: `Bearer ${route.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmProviderError(
        'LLM_TIMEOUT',
        'transient',
        route.routeId,
        `route "${route.routeId}" did not answer within ${String(route.timeoutMs)}ms`,
      );
    }
    const reason = error instanceof Error ? error.message : 'unknown network failure';
    throw new LlmProviderError(
      'LLM_NETWORK_ERROR',
      'transient',
      route.routeId,
      `route "${route.routeId}" connection failed: ${reason}`,
    );
  }

  if (response.status !== 200) {
    const { code, failureClass } = classifyStatus(response.status);
    throw new LlmProviderError(
      code,
      failureClass,
      route.routeId,
      `route "${route.routeId}" answered HTTP ${String(response.status)}`,
      response.status,
    );
  }

  if (request.stream) {
    return readStreamedCompletion(route, response);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" returned a body that is not valid JSON`,
      response.status,
    );
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" returned a body that is not an object`,
      response.status,
    );
  }
  const completion = raw as RawCompletion;
  const choices = completion.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" returned no choices`,
      response.status,
    );
  }
  const [first] = choices as readonly RawChoice[];
  const content = first?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    // An empty answer is a CONTRACT failure, not an availability failure: the
    // route responded, it simply said nothing usable. Classing it transient
    // would let an empty answer trigger provider shopping.
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" returned an empty message content`,
      response.status,
    );
  }

  return {
    routeId: route.routeId,
    model: typeof completion.model === 'string' ? completion.model : route.model,
    responseId: typeof completion.id === 'string' ? completion.id : null,
    content,
    finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : null,
    usage: readUsage(completion.usage),
  };
}
