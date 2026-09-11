# ADR-0006 — The narrative LLM provider boundary

Status: accepted for ETBZ-25B (development scope only)
Date: 2026-09-11
Supersedes: nothing. Extends ADR-0001 (modular monolith, hexagonal-lite).

## Context

ETBZ-25A shipped the `NarrativeProvider` port with exactly one implementation:
a deterministic, structural provider that performs no generation, makes no
network call and holds no credential. The port's whole purpose — a real model
writing the interpretation — was deliberately left unimplemented.

ETBZ-25B implements it, under a Product Owner contract whose binding condition
is a **development billable LLM cost cap of `0.00 EUR` per synthetic run**, with
no paid fallback and no autonomous provider, model or budget change.

Four routes were approved, in preference order: TokenRouter, the Gemini
OpenAI-compatible endpoint, OpenCode, OpenRouter.

## Decisions

### 1. One generic OpenAI-compatible adapter, no per-provider abstraction

All four approved routes speak `POST {baseUrl}/chat/completions` with a bearer
credential. `src/adapters/llm/openai-compatible-client.ts` is therefore the
entire provider surface. There is no provider subclass, no per-vendor mapper and
no vendor name in any branch of it.

The contract permits a provider-specific abstraction only when "a freshly
verified provider contract makes that necessary". No such necessity was found.

### 2. Approved routes are code; endpoints, models and credentials are config

`APPROVED_LLM_ROUTES` in `src/app/configuration/llm-routes.ts` records WHICH
routes are approved and in WHAT ORDER. That is a product decision and changing
it is a reviewed code change.

Base URLs, model ids and credentials are read from an explicitly supplied
environment record. The contract is explicit that these "are configuration, not
hard-coded product truth".

### 3. No-charge eligibility is checked mechanically, and fails closed

A route is eligible only when its configured model id carries the provider's
own explicit zero-price marker (the id ends with `-free` or `:free`). A route
whose no-charge status cannot be decided from the configuration it was given is
**ineligible and skipped** — never "probably free".

This is deliberately strict enough to exclude a provider whose free tier is real
but is not expressed in the model id. The Gemini route is exactly that case, and
a live probe on 2026-09-11 confirmed the exclusion was right rather than merely
cautious: that endpoint answered `429 RESOURCE_EXHAUSTED — "Your prepayment
credits are depleted"`, which is a **billing-backed** account, not a free tier.

Marker-based verification has a known limit, recorded here rather than left to
be discovered: a marker is a provider's naming convention, not a billing
readback. A `:free`-suffixed passthrough model on TokenRouter was observed to
require account credit despite its marker. It fails closed at call time
(`insufficient_user_quota`) and cannot be billed against a zero balance, but the
eligibility check would have admitted it. This is why every evidence record
states `observedCostBasis` in words instead of publishing a bare zero.

### 4. A paid path cannot be enabled by configuration

`assertNoPaidPathAuthorized` refuses a billable path unconditionally. No
environment variable, flag or override turns it on. The contract requires "a new
explicit Human Approval" for any cost above `0.00 EUR`, and an approval an
operator can grant to themselves by exporting a variable is not an approval.
Raising the cap is a reviewed code change in a later slice.

### 5. Failover is a strict transient allowlist

Failover to the next approved route is permitted only for bounded technical
availability failures: network failure, timeout, `429`, and the explicitly
enumerated transient `5xx` statuses. `classifyStatus` is an allowlist of
transient conditions, so a status nobody has classified is terminal — a new
provider behaviour cannot silently acquire permission to shop for a different
answer.

`404 model not found` is TERMINAL. A vanished model is a configuration fact, and
quietly moving to another provider would hide exactly the drift the contract
asks to have surfaced. This was not hypothetical: the configured OpenRouter
model `minimax/minimax-m3:free` had ceased to exist by 2026-09-11 and the
endpoint answered `404 — "This model is unavailable for free"`.

A CONTENT failure — output that is not JSON, is of the wrong shape, is truncated,
fails a structural gate or fails semantic QA — is **never** a reason to call
another provider. The run stops.

### 6. Streaming is a transport decision, and is not continuation

The approved free route is a reasoning model. Measured against the real brief on
2026-09-11 it spent roughly 22,000 tokens and seven to eight minutes reasoning
before emitting its first content token. Node's HTTP client applies a
300-second *headers* timeout that no `fetch` option can raise, so a buffered
request to that model fails with `UND_ERR_HEADERS_TIMEOUT` before the model has
said anything.

Streaming is therefore the default. The stream is accumulated inside one route
and the completion is returned only once that route has finished. A stream that
fails part-way retains nothing. The contract's ban on mid-stream cross-provider
continuation and on blending partial outputs is untouched.

### 7. The prompt carries no PII

The `NarrativeBrief` contains exactly one personal datum, `subject.displayName`,
and `prompt-policy.ts` does not send it. A provider writes about a chart and has
no use for a name; the report assembles it locally. Birth date, time and place
are not in the brief at all. The prompt is therefore PII-free by construction
rather than by redaction after the fact.

### 8. Semantic QA is deterministic, and never asks a model to grade a model

`semantic-qa.ts` decides every finding by lookup in the closed vocabularies of
`semantic-qa-lexicon.ts`. Using a language model to judge a language model's
output would place the product's last semantic guarantee behind the same
non-determinism the gate exists to contain, and would make a refusal impossible
to review.

The gate's limits are stated in its own docblock: it matches vocabulary, so it
catches the forms of claim it lists and not the infinite paraphrase around them,
and it cannot decide whether a sentence is true about a person. That is why the
slice still ends at a human `SELLABLE | NOT_SELLABLE` review.

### 9. A provider refusal files evidence, and names its failure from a closed set

A run a provider refuses — no answer accepted at all — is filed through
`buildProviderRefusalEvidence` as the same `NarrativeRunEvidence` a completed
run gets: bound to the candidate SHA, the brief hash and the identity of the
prompt the run was prepared to send, with both gates `NOT_RUN`, the reading
`NOT_PRODUCED`, and `providerRefusalCode` naming the refusal. The builder takes
no gate field from its caller, so a refused run cannot be filed as a pass.

Each transport refusal names one member of `PROVIDER_FAILURE_DETAIL_CODES` — a
closed set, never free text — and keeps the finish reason, usage and reported
cost it had genuinely observed before refusing; each stays `null` when it was
not observed. Answer text, reasoning text and provider error bodies are never
kept.

The measured reason: candidate `54d7e30`'s one live run ended HTTP 200 /
`LLM_CONTRACT_ERROR` / no content after roughly 700 seconds and left no file,
while the finish reason and token counts that would have diagnosed it had
already been discarded, and most transport refusals shared that one code.

### 10. Reasoning effort is an optional, generic request field, absent by default

`LlmChatRequest.reasoningEffort` (`low | high | max`, closed by type and at
runtime) is sent as `reasoning_effort` only when set. Unset, the request is
byte-for-byte what it was before the field existed, and
`DEFAULT_LLM_NARRATIVE_OPTIONS` sets none. There is no provider subclass and no
model id in code: the field belongs to the one generic adapter.

The live harness sets `low` explicitly for the controlled ETBZ-25B run — the
approved free route's model documents `max` as its default when none is sent —
and files it as `requestedReasoningEffort`: what was asked for, not a
measurement of how the provider reasoned.

## Consequences

- The live harness (`tests/live/`, `npm run golden-reading`) is excluded from the
  CI verification contract. A gate must be reproducible from source alone, and a
  suite needing a network, a credential and a third party's availability is not.
  It is still typechecked and linted with everything else.
- Evidence from a live run is reviewed as evidence, bound to an exact candidate
  SHA, and never counted as a passing gate.
- A blocked candidate is a real and acceptable outcome. The response is to
  improve the versioned prompt and produce a new candidate — never to soften a
  gate or to try a different provider.
