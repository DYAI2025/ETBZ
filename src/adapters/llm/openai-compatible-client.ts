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
  /** What the provider said this call cost. `null` when it said nothing. */
  readonly reportedCost: ReportedCost | null;
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
 * A per-request monetary cost a provider ACTUALLY reported.
 *
 * The distinction this type exists to preserve: `null` means NO PROVIDER SAID
 * ANYTHING ABOUT COST, which is not the same fact as a provider reporting zero,
 * and neither is the same fact as ETBZ having approved a zero cap. Collapsing
 * the three was the defect — a policy number was being published in the field a
 * reader takes for a measurement.
 *
 * `currency` is whatever the provider labelled the amount, verbatim, and `null`
 * when it labelled none. It is NOT normalised and the amount is NEVER converted:
 * an exchange rate ETBZ picked for itself would be exactly the kind of invented
 * number this whole record exists to keep out.
 */
export interface ReportedCost {
  readonly amount: number;
  readonly currency: string | null;
  /** The response field the amount was read from. Non-secret, published. */
  readonly source: string;
}

/**
 * Reads a per-request cost out of a provider `usage` block, if it has one.
 *
 * MEASURED, not assumed: of the four approved routes, only OpenRouter returns a
 * cost at all (`usage.cost`, unlabelled), and TokenRouter, OpenCode and the
 * Gemini OpenAI-compatible endpoint return none. So `null` is the ordinary
 * answer here and must stay distinguishable from a reported `0` forever.
 */
/**
 * A reported amount, accepting the spellings gateways actually use.
 *
 * A NUMERIC STRING COUNTS. OpenAI-compatible gateways serialise money both ways,
 * and `"0.0042"` is a provider reporting a charge just as plainly as `0.0042`.
 * Reading only the number type would turn a reported cost into "nothing was
 * reported", which is the one direction this whole split exists to prevent — and
 * it would do it to a NON-ZERO amount, slipping a real charge past
 * `assertObservedCostWithinCap`.
 *
 * An empty or non-numeric string is not an amount and reads back as `null`.
 */
function costAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readReportedCost(raw: unknown): ReportedCost | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const usage = raw as Record<string, unknown>;
  const amount = costAmount(usage['cost']);
  if (amount === null) {
    return null;
  }
  const labelled = usage['cost_currency'] ?? usage['currency'];
  return {
    amount,
    currency: typeof labelled === 'string' && labelled.trim().length > 0 ? labelled.trim() : null,
    source: 'usage.cost',
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

/** Where in the stream a line was read from. It decides how a bad line is classed. */
type LinePosition = 'in_stream' | 'residual';

/**
 * The refusal for a `data:` line that claims a completion chunk and is not one.
 *
 * TWO CLASSIFICATIONS, because the two positions are two different failures.
 *
 *  in_stream  the provider delivered a complete line, between newlines, that
 *             says `data:` and then does not carry a chunk. The route answered;
 *             it answered with something that is not the contract. That is
 *             TERMINAL — a provider that sends garbage has not had an
 *             availability problem, and classing it transient would let
 *             corrupted content buy permission to call the next provider, which
 *             is precisely the provider-shopping the failover rules forbid.
 *
 *  residual   the stream CLOSED leaving an unterminated line in the buffer. That
 *             line is incomplete by construction, so its unparseability says
 *             nothing about what the provider meant to send — the connection
 *             ended mid-frame. That is an availability failure, TRANSIENT, and
 *             failover is authorised. Note it also throws away whatever content
 *             had accumulated before the cut, which is what keeps rule 4 true:
 *             a half-written reading is never returned as a whole one.
 *
 * THE MESSAGE NAMES THE FACT, NEVER THE BYTES. Interpolating the payload would
 * republish unvalidated provider output into an error that is logged and travels
 * beside the evidence record. `JSON.parse`'s own message cannot be forwarded
 * either: it quotes the offending source text verbatim.
 */
function malformedChunk(
  route: LlmRouteConfig,
  position: LinePosition,
  payloadLength: number,
): LlmProviderError {
  if (position === 'residual') {
    return new LlmProviderError(
      'LLM_NETWORK_ERROR',
      'transient',
      route.routeId,
      `route "${route.routeId}" closed mid-frame: the stream ended on an incomplete data line of ${String(payloadLength)} characters`,
    );
  }
  return new LlmProviderError(
    'LLM_CONTRACT_ERROR',
    'terminal',
    route.routeId,
    `route "${route.routeId}" sent a data line of ${String(payloadLength)} characters that is not a JSON completion chunk`,
  );
}

/**
 * Accumulates a Server-Sent Events response into one completion.
 *
 * Every field the buffered path reports is reconstructed here — id, model,
 * finish reason and usage — so a caller cannot tell the two paths apart, which
 * is what lets the whole test suite exercise the same code the live run uses.
 *
 * WHAT IS IGNORED, AND WHY IT IS A CLOSED LIST. A line is skipped only when it
 * makes no claim to carry completion data: an SSE comment or keep-alive (`: …`),
 * a non-`data:` field line (`event:`, `id:`, `retry:`), a `data:` line with an
 * empty payload, and `data: [DONE]`. These are statements about the STREAM, not
 * about a chunk, and refusing them would refuse perfectly good readings —
 * OpenRouter, for one, interleaves `: OPENROUTER PROCESSING` keep-alives while a
 * model thinks.
 *
 * EVERYTHING ELSE FAILS CLOSED. A `data:` line that purports to carry a chunk
 * and does not parse as a JSON object is a contract violation, not noise, and it
 * is refused rather than skipped. Skipping it was the older behaviour and it was
 * wrong in a specific way: a corrupted frame vanished silently, the run
 * continued on whatever content happened to survive, and the reading that came
 * out was assembled from an answer nobody had validated. A stream that yields no
 * content at all is still caught by the same empty-content check the buffered
 * path applies.
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
  // Accumulated from the same chunk as the usage block, so the streamed and
  // buffered paths report the same observation for the same answer.
  let reportedCost: ReportedCost | null = null;

  const consume = (line: string, position: LinePosition): void => {
    // Makes no claim to carry a chunk: comment, keep-alive, other field, blank.
    if (!line.startsWith('data:')) {
      return;
    }
    const payload = line.slice('data:'.length).trim();
    // MUST STAY ABOVE THE REFUSAL BELOW. An empty payload is a keep-alive
    // spelled as a data line and `[DONE]` is the stream's end marker; both are
    // about the stream rather than about a chunk. Hoisting the refusal above
    // this check turns every provider keep-alive into a refused reading.
    if (payload.length === 0 || payload === '[DONE]') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw malformedChunk(route, position, payload.length);
    }
    // `null`, a bare number, a bare string AND AN ARRAY all survive
    // JSON.parse. A line that said `data:` and then delivered one of those is as
    // much a contract violation as one that did not parse, and it must not read
    // back as a chunk with every field quietly undefined. The array case needs
    // saying out loud because `typeof [] === 'object'` and `[] !== null`, so the
    // obvious two-clause check lets it straight through.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw malformedChunk(route, position, payload.length);
    }
    const chunk = parsed as StreamChunk;
    if (responseId === null && typeof chunk.id === 'string') {
      responseId = chunk.id;
    }
    if (model === null && typeof chunk.model === 'string') {
      model = chunk.model;
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = readUsage(chunk.usage);
      reportedCost = readReportedCost(chunk.usage);
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
        consume(line, 'in_stream');
      }
    }
    // Whatever the stream ended on without a closing newline. Read as 'residual'
    // because an unterminated line is incomplete by construction: see
    // `malformedChunk` for why that is an availability failure and not a
    // contract one.
    consume(buffered, 'residual');
  } catch (error) {
    // A CLASSIFICATION THIS MODULE ALREADY MADE IS NEVER RE-CLASSIFIED.
    //
    // This branch has to come first, and the repair it protects is defeated
    // without it. `consume` now refuses a malformed chunk from inside this try.
    // `LlmProviderError` sets `name` to its own value, so the `AbortError` test
    // below is false for it and it would fall through to the generic re-wrap —
    // which would rewrite a TERMINAL `LLM_CONTRACT_ERROR` as a TRANSIENT
    // `LLM_NETWORK_ERROR`, and hand the run permission to call the next provider
    // on the strength of corrupted content. Silently, too: the contract text
    // would survive only as a fragment inside a network-failure message.
    //
    // The rule is broader than that one case. Everything below classifies a
    // TRANSPORT failure; an error that arrives already classified is passed
    // through untouched.
    if (error instanceof LlmProviderError) {
      throw error;
    }
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
  } finally {
    // Release the body on EVERY exit, including the refusals above.
    //
    // Before the malformed-chunk refusal existed, the only throws out of this
    // region came from a socket that was already dead. Now a refusal is
    // reachable on a perfectly healthy connection: one bad frame, and the body
    // would be left locked and undrained with the socket open — while
    // `requestChatCompletion`'s `finally` clears the abort timer at that same
    // moment, so the deadline that would otherwise have torn it down never
    // fires. Under failover that leaks one live socket per refused route.
    //
    // Deliberately non-throwing: a failed cancel must never replace the
    // classification being propagated out of this function.
    void reader.cancel().catch(() => undefined);
  }

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
    reportedCost,
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
    reportedCost: readReportedCost(completion.usage),
  };
}
