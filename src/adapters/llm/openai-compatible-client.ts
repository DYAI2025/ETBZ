/**
 * ETBZ-25B — ONE generic OpenAI-compatible chat client for every approved route.
 *
 * The Product Owner contract is explicit: "Use one generic OpenAI-compatible
 * provider adapter where the current provider endpoint is OpenAI-compatible. Do
 * not create provider-specific domain abstractions unless a freshly verified
 * provider contract makes that necessary." All five approved routes speak
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
import type { ProviderFailureDetailCode } from '../../application/interpretation/errors.js';

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
 * An explicit reasoning effort, for routes whose models reason before answering.
 *
 * ABSENT BY DEFAULT. A request that sets none carries no `reasoning_effort`
 * field at all — byte-for-byte what every request carried before this option
 * existed — so no route changes behaviour unless a caller asks for it.
 *
 * The three values are the closed set the approved free route's model documents.
 * They are refused at runtime as well as by the type, because a value that
 * arrives through a cast or a configuration string would otherwise be forwarded
 * verbatim to a provider nobody has asked how it reads an unknown value.
 */
export const LLM_REASONING_EFFORTS = ['low', 'high', 'max'] as const;

export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

/**
 * Whether the model should think before answering, as a request field of its own.
 *
 * A SEPARATE FIELD FROM `reasoningEffort`, AND NOT A SPELLING OF IT. Some
 * OpenAI-compatible endpoints take an effort LEVEL (`reasoning_effort`), others
 * take an explicit on/off OBJECT (`thinking: { type }`), and at least one
 * publishes both. Sending an effort level to an endpoint that documents the
 * object is not a near miss — it is a field that endpoint never agreed to read,
 * and nobody has asked it what it does with one.
 *
 * ABSENT BY DEFAULT, like the effort beside it. A request that sets no mode
 * carries no `thinking` field at all, so no existing route's request changes by
 * a single byte unless a caller asks for it.
 *
 * THIS IS TRANSPORT, NOT A PROVIDER ABSTRACTION. It is one optional key on the
 * one generic request; there is no branch on a vendor, no model family named
 * here, and no second client. Which routes need it is configuration's business.
 *
 * The two values are the closed set the field documents. They are refused at
 * runtime as well as by the type, because a value arriving through a cast or a
 * configuration string would otherwise be forwarded verbatim to a provider
 * nobody has asked how it reads an unknown one.
 */
export const LLM_THINKING_MODES = ['enabled', 'disabled'] as const;

export type LlmThinkingMode = (typeof LLM_THINKING_MODES)[number];

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

/**
 * What a failed attempt had GENUINELY observed before it was refused.
 *
 * Structured, non-secret fields only — never answer text, never reasoning text,
 * never a provider's error body. Each is `null` when it was not observed:
 * `usage` is `null` when no usage block arrived, not a row of zeros.
 *
 * It exists because the refusal is the run's only record. A stream that ended
 * with no content had usually reported a finish reason and token counts first,
 * and dropping them left "HTTP 200, no content" as the whole story — when the
 * finish reason and the token count are exactly what distinguish "the model
 * spent its budget reasoning" from "the provider sent nothing".
 */
export interface LlmObservation {
  readonly finishReason: string | null;
  readonly usage: LlmUsage | null;
  readonly reportedCost: ReportedCost | null;
}

/** The structured facts a refusal carries beside its class. */
export interface LlmFailureDetail {
  readonly detailCode: ProviderFailureDetailCode;
  /** The HTTP status, when a response existed. */
  readonly status?: number;
  readonly observed?: LlmObservation;
}

export class LlmProviderError extends Error {
  readonly code: LlmErrorCode;
  readonly failureClass: LlmFailureClass;
  readonly routeId: string;
  readonly status: number | undefined;
  /**
   * WHICH closed failure shape this is. `code` alone cannot say: most refusals
   * in this file share `LLM_CONTRACT_ERROR`.
   */
  readonly detailCode: ProviderFailureDetailCode;
  /** What the attempt observed before it failed. `null` when nothing was. */
  readonly observed: LlmObservation | null;

  constructor(
    code: LlmErrorCode,
    failureClass: LlmFailureClass,
    routeId: string,
    message: string,
    detail: LlmFailureDetail,
  ) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    this.failureClass = failureClass;
    this.routeId = routeId;
    this.status = detail.status;
    this.detailCode = detail.detailCode;
    this.observed = detail.observed ?? null;
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
  /**
   * Sent as `reasoning_effort` when set; not sent at all when absent. See
   * `LlmReasoningEffort`.
   */
  readonly reasoningEffort?: LlmReasoningEffort;
  /**
   * Sent as `thinking: { type: <mode> }` when set; not sent at all when absent.
   * See `LlmThinkingMode`.
   */
  readonly thinkingMode?: LlmThinkingMode;
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
 * MEASURED, not assumed: of the five approved routes, only OpenRouter returns a
 * cost at all (`usage.cost`, unlabelled). TokenRouter, OpenCode and the Gemini
 * OpenAI-compatible endpoint return none, and the direct Z.ai endpoint was
 * measured on 2026-09-12 to answer with a `usage` block carrying no cost field
 * either. So `null` is the ordinary answer here and must stay distinguishable
 * from a reported `0` forever.
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
  /** Present when the provider reports a failure mid-stream, after HTTP 200. */
  readonly error?: unknown;
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
  status: number,
  observed: LlmObservation,
): LlmProviderError {
  if (position === 'residual') {
    return new LlmProviderError(
      'LLM_NETWORK_ERROR',
      'transient',
      route.routeId,
      `route "${route.routeId}" closed mid-frame: the stream ended on an incomplete data line of ${String(payloadLength)} characters`,
      { detailCode: 'STREAM_CLOSED_MID_FRAME', status, observed },
    );
  }
  return new LlmProviderError(
    'LLM_CONTRACT_ERROR',
    'terminal',
    route.routeId,
    `route "${route.routeId}" sent a data line of ${String(payloadLength)} characters that is not a JSON completion chunk`,
    { detailCode: 'MALFORMED_SSE_CHUNK', status, observed },
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
      { detailCode: 'STREAM_NO_BODY', status: response.status },
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
  // Whether a usage block arrived at all. `usage` starts as a row of nulls, and
  // a refusal must be able to say "no usage was reported" rather than file that
  // row as if something had been.
  let usageObserved = false;
  // What a refusal raised from here may carry: observed structure, never text.
  const observedSoFar = (): LlmObservation => ({
    finishReason,
    usage: usageObserved ? usage : null,
    reportedCost,
  });

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
      throw malformedChunk(route, position, payload.length, response.status, observedSoFar());
    }
    // `null`, a bare number, a bare string AND AN ARRAY all survive
    // JSON.parse. A line that said `data:` and then delivered one of those is as
    // much a contract violation as one that did not parse, and it must not read
    // back as a chunk with every field quietly undefined. The array case needs
    // saying out loud because `typeof [] === 'object'` and `[] !== null`, so the
    // obvious two-clause check lets it straight through.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw malformedChunk(route, position, payload.length, response.status, observedSoFar());
    }
    const chunk = parsed as StreamChunk;
    // READ WHAT THE FRAME REPORTS BEFORE REFUSING ON WHAT IT ADMITS.
    //
    // This read sat BELOW the in-band error refusal, and a provider that
    // reports a mid-stream failure can state the usage — and the COST — of the
    // work it already did in that very frame. The throw happened first, so the
    // attempt filed `usage: null` and `reportedCost: null`,
    // `assertObservedCostWithinCap` found nothing to refuse, and a run the
    // provider charged for passed a 0.00 EUR cap because the charge arrived in
    // the same frame as the error. Reading first cannot lose anything: a frame
    // with no usage block leaves both values exactly as they were.
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = readUsage(chunk.usage);
      reportedCost = readReportedCost(chunk.usage);
      usageObserved = true;
    }
    // AN IN-BAND ERROR FRAME ENDS THE RUN.
    //
    // A provider that has already sent 200 and started streaming reports a
    // mid-answer failure inside the stream — `data: {"error":{...}}` — because
    // the status line is long gone. That frame carries no `choices`, so the
    // choices check below skipped it in silence: the partial text streamed
    // before it was returned as a COMPLETE answer with `finishReason: null`,
    // and `isIncompleteFinishReason(null)` is false, so the provider's explicit
    // statement that the call failed was recorded as `outcome: 'accepted'`.
    // Measured on this client: a stream of one content frame plus one error
    // frame resolved with content "partial answer".
    //
    // Terminal, like every other unclassified provider behaviour: the transient
    // allowlist is a closed set of HTTP statuses, and an error nobody has
    // classified must not buy permission to call the next provider. Nothing
    // partial survives the throw, which is what keeps rule 4 true here too.
    if (chunk.error !== undefined && chunk.error !== null) {
      throw new LlmProviderError(
        'LLM_CONTRACT_ERROR',
        'terminal',
        route.routeId,
        `route "${route.routeId}" reported an error inside the stream after answering HTTP 200`,
        { detailCode: 'IN_BAND_PROVIDER_ERROR', status: response.status, observed: observedSoFar() },
      );
    }
    if (responseId === null && typeof chunk.id === 'string') {
      responseId = chunk.id;
    }
    if (model === null && typeof chunk.model === 'string') {
      model = chunk.model;
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
        { detailCode: 'STREAM_TIMEOUT', status: response.status, observed: observedSoFar() },
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
      { detailCode: 'STREAM_INTERRUPTED', status: response.status, observed: observedSoFar() },
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
      // The observation is the diagnosis here. A reasoning model that spent its
      // whole budget thinking ends exactly like this, and the finish reason and
      // token counts it reported are what say so.
      { detailCode: 'STREAM_NO_MESSAGE_CONTENT', status: response.status, observed: observedSoFar() },
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
  if (request.reasoningEffort !== undefined) {
    // Refused before the deadline starts and before anything leaves the
    // process. The value itself is not repeated: it did not pass validation.
    if (!(LLM_REASONING_EFFORTS as readonly string[]).includes(request.reasoningEffort)) {
      throw new TypeError(
        `reasoning effort must be one of ${LLM_REASONING_EFFORTS.join(', ')}; no request was sent`,
      );
    }
    payload['reasoning_effort'] = request.reasoningEffort;
  }
  if (request.thinkingMode !== undefined) {
    // Refused before the deadline starts and before anything leaves the
    // process, exactly like the effort above. The value itself is not repeated:
    // it did not pass validation, so it is not something this module will echo.
    if (!(LLM_THINKING_MODES as readonly string[]).includes(request.thinkingMode)) {
      throw new TypeError(
        `thinking mode must be one of ${LLM_THINKING_MODES.join(', ')}; no request was sent`,
      );
    }
    // The OBJECT form, because that is what the field is: a bare string here
    // would be a different field with the same name, and an endpoint that reads
    // `thinking.type` would see nothing at all.
    payload['thinking'] = { type: request.thinkingMode };
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

/** What a buffered body reported before it was refused. Structure only. */
function bufferedObservation(rawUsage: unknown, rawFinishReason: unknown): LlmObservation {
  return {
    finishReason: typeof rawFinishReason === 'string' ? rawFinishReason : null,
    usage: rawUsage === undefined || rawUsage === null ? null : readUsage(rawUsage),
    reportedCost: readReportedCost(rawUsage),
  };
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
        { detailCode: 'REQUEST_TIMEOUT' },
      );
    }
    const reason = error instanceof Error ? error.message : 'unknown network failure';
    throw new LlmProviderError(
      'LLM_NETWORK_ERROR',
      'transient',
      route.routeId,
      `route "${route.routeId}" connection failed: ${reason}`,
      { detailCode: 'NETWORK_FAILURE' },
    );
  }

  if (response.status !== 200) {
    const { code, failureClass } = classifyStatus(response.status);
    throw new LlmProviderError(
      code,
      failureClass,
      route.routeId,
      `route "${route.routeId}" answered HTTP ${String(response.status)}`,
      { detailCode: 'HTTP_STATUS_NOT_OK', status: response.status },
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
      { detailCode: 'BUFFERED_BODY_NOT_JSON', status: response.status },
    );
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new LlmProviderError(
      'LLM_CONTRACT_ERROR',
      'terminal',
      route.routeId,
      `route "${route.routeId}" returned a body that is not an object`,
      { detailCode: 'BUFFERED_BODY_NOT_OBJECT', status: response.status },
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
      {
        detailCode: 'BUFFERED_NO_CHOICES',
        status: response.status,
        observed: bufferedObservation(completion.usage, undefined),
      },
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
      {
        detailCode: 'BUFFERED_EMPTY_MESSAGE',
        status: response.status,
        observed: bufferedObservation(completion.usage, first?.finish_reason),
      },
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
