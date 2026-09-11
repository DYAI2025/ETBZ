import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { generateNarrativeFromPlan } from '../../src/adapters/llm/llm-narrative-provider.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import { buildGoldenReading } from '../../src/application/interpretation/golden-reading.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import {
  EvidenceLeakError,
  ObservedCostExceedsCapError,
  ObservedCostNotDerivableError,
  assertNoReportedCharge,
  RUN_EVIDENCE_VERSION,
  assertEvidenceSanitized,
  assertObservedCostWithinCap,
  buildRunEvidence,
  observedBillableCostEurFrom,
} from '../../src/application/interpretation/narrative-evidence.js';
import type {
  BuildRunEvidenceInput,
  EvidenceRouteAttempt,
  EvidenceRouteVerdict,
  NarrativeRunEvidence,
} from '../../src/application/interpretation/narrative-evidence.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import {
  NARRATIVE_QA_VERSION,
  runSemanticNarrativeQa,
} from '../../src/application/interpretation/semantic-qa.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import {
  FIXTURE_LLM_ENV,
  answerAsProviderText,
  completionBody,
  fakeTransport,
  validKnownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B negative: the evidence record is SANITIZED, and that is measured.
 *
 * The Product Owner contract asks for evidence "sufficient to reconstruct the
 * run without PII or secrets". Reconstructability is easy to see — the fields
 * are either there or they are not. Sanitisation is the half that is invisible
 * in a passing run: a record that carries a credential looks exactly like a
 * record that does not, right up to the moment it is written to
 * `docs/evidence/run/` and committed. So the property this file proves is not
 * "we did not put a secret in the record" — that is a claim about intent — but
 * "a record carrying one is REFUSED", which is a claim about behaviour and can
 * be made red.
 *
 * FIVE PROPERTIES, each of which a plausible-looking guard could fail:
 *
 *  1. WHOLE-RECORD COVERAGE. `assertEvidenceSanitized` serialises and searches,
 *     so the tests plant the credential in fields nobody would think to
 *     sanitise — `observedCostBasis`, `candidateSha`, a route verdict's
 *     `statement`, and a nested attempt's `responseId`. A field-by-field guard
 *     would pass the first two and miss the rest; this one must catch all four.
 *
 *  2. INDEPENDENCE FROM THE CALLER'S LIST. A guard that only compares against
 *     the credentials the caller remembered to declare is a guard against
 *     forgetfulness it already assumes away. The shape cases below plant a
 *     credential the declared list does NOT contain and still require a
 *     refusal, which is the only version of this check worth having.
 *
 *  3. NON-VACUITY. A guard that refuses everything is not a guard. Three
 *     separate controls hold that line: the clean baseline is accepted with the
 *     real credential list supplied, a blank entry in that list is ignored
 *     rather than matched (an empty string occurs in every text), and prose
 *     that merely LOOKS credential-ish — a word ending in `sk` before a hyphen,
 *     a `sk-` prefix that is too short — is accepted.
 *
 *  4. THE REFUSAL DOES NOT REPUBLISH WHAT IT REFUSES. An error message that
 *     quotes the secret it found has moved the leak into the log, the CI
 *     transcript and the failing-test output. Every refusal here is inspected
 *     for the value that caused it.
 *
 *  5. THE COST CONTRACT IS PINNED BY THE BUILDER, not by the caller, and the
 *     published `structuralHash` is re-derived here with `node:crypto` from the
 *     published canonical text. A hash nobody can reproduce is decoration.
 *
 * METHOD. Every case starts from ONE baseline evidence record built from a real
 * offline run — real brief, real route plan, real prompt, real attempt history
 * (one transient failure, then an accepted answer), real report, real QA
 * verdict, real Golden Reading hash — and changes EXACTLY ONE field. A red
 * assertion can therefore only mean the guard reacted to that one change.
 *
 * ON THE CREDENTIAL-SHAPED FIXTURES. They are assembled at runtime from
 * fragments and never written as a contiguous literal. `scripts/secret-scan.sh`
 * runs gitleaks across this working tree, and a test file carrying a
 * scanner-detectable literal would turn the repository's own secret gate red
 * for a value that is not a secret. `create_fixture()` in that script splits
 * its own fixture for exactly this reason; this file follows it.
 *
 * No network, no credential and no real person: the transport is scripted, the
 * keys are the fixture environment's fake values, and the chart is the
 * synthetic fixture chart the rest of the slice already uses.
 */

// ---------------------------------------------------------------------------
// The baseline run. Built once, offline, from the production path.
// ---------------------------------------------------------------------------

const MODEL = knownTimeModel();
const CHAIN = buildNarrativeChain(MODEL);
const PLAN = buildLlmRoutePlan(FIXTURE_LLM_ENV);

/**
 * Route 1 rate-limits, the next ELIGIBLE route answers.
 *
 * A two-attempt history is the realistic case and the interesting one: the
 * failed attempt contributes a record full of nulls, the accepted one a record
 * with a response id, a response hash and token counts. Both are places a
 * credential could end up, and a single-attempt baseline would not exercise the
 * nested array at all.
 */
const TRANSPORT = fakeTransport([
  { status: 429, body: { error: { message: 'rate limited' } } },
  { status: 200, body: completionBody(answerAsProviderText(validKnownTimeAnswer())) },
]);

const RESULT = await generateNarrativeFromPlan(CHAIN.brief, PLAN, TRANSPORT);

/** The ETBZ-25A structural gate. It re-derives the chain from the chart. */
const REPORT = buildReportModel({
  model: MODEL,
  brief: CHAIN.brief,
  providerOutput: RESULT.providerOutput,
});

const QA = runSemanticNarrativeQa(REPORT);

/**
 * Built only when the QA verdict allows it.
 *
 * `buildGoldenReading` throws on a blocked candidate, and a throw at module
 * scope would take the whole file down before a single assertion could explain
 * why. The baseline test below asserts the verdict instead, so a baseline that
 * stops being valid fails with a message rather than an import error.
 */
const READING = QA.status === 'PASS' ? buildGoldenReading(REPORT, QA) : null;

/** A plausible commit id. Not a credential, and deliberately not one either. */
const CANDIDATE_SHA = '3f7c0b1a9d24e6857b0c4f1e2a9d7c3b5e08f142';

const BASE_INPUT: BuildRunEvidenceInput = {
  candidateSha: CANDIDATE_SHA,
  briefStructuralHash: CHAIN.brief.structuralHash,
  promptStructuralHash: RESULT.prompt.promptStructuralHash,
  promptVersion: RESULT.prompt.promptVersion,
  policyVersion: RESULT.prompt.policyVersion,
  qaVersion: NARRATIVE_QA_VERSION,
  routeVerdicts: PLAN.eligibility.map((entry) => ({
    routeId: entry.routeId,
    order: entry.order,
    eligible: entry.eligible,
    ineligibleReason: entry.ineligibleReason,
    baseUrl: entry.baseUrl,
    model: entry.model,
    noChargeBasis: entry.noChargeBasis,
    statement: entry.statement,
  })),
  attempts: RESULT.attempts,
  acceptedRouteId: RESULT.acceptedRouteId,
  acceptedModel: RESULT.acceptedModel,
  reportStructuralHash: REPORT.structuralHash,
  structuralGate: 'PASS',
  semanticQaStatus: QA.status,
  semanticQaFindings: QA.findings,
  goldenReadingStatus: READING === null ? 'BLOCKED' : 'CANDIDATE_READY_FOR_HUMAN_REVIEW',
  goldenReadingHash: READING?.structuralHash ?? null,
  requestedReasoningEffort: null,
  providerRefusalCode: null,
  observedBillableCostEur: null,
  observedCostBasis:
    'Not observed: none of the approved routes returned a per-call cost field for this run, so no monetary cost was measured. The 0.00 EUR figure recorded beside it is the APPROVED CAP, which is policy, not a reading.',
};

/** The baseline, and every mutation of it, through the real builder. */
function evidenceWith(overrides: Partial<BuildRunEvidenceInput>): NarrativeRunEvidence {
  return buildRunEvidence({ ...BASE_INPUT, ...overrides });
}

// ---------------------------------------------------------------------------
// The declared inputs of the guard.
// ---------------------------------------------------------------------------

/**
 * The credential values this run actually held, read from the fixture
 * environment the route plan was built from — not retyped here. A retyped list
 * can drift from the environment and then prove nothing about it.
 */
const CONFIGURED_SECRETS: readonly string[] = Object.entries(FIXTURE_LLM_ENV)
  .filter(([variable]) => variable.endsWith('_API_KEY'))
  .map(([, value]) => value);

/** The personal data of the synthetic subject. Names a person, so it is PII. */
const SUBJECT_PERSONAL_VALUES: readonly string[] = [MODEL.displayName, MODEL.birth.date];

/**
 * Assembles a token from fragments so no contiguous literal is committed.
 * See the module docblock: gitleaks scans this file.
 */
function fragments(...parts: readonly string[]): string {
  return parts.join('');
}

/**
 * Credentials the caller's list does NOT contain, one per shape the guard
 * claims to recognise. The declared list is asserted not to contain them, so
 * every refusal below is a refusal the caller's list could not have produced.
 */
const SHAPED_CREDENTIALS: readonly (readonly [string, string])[] = [
  ['an OpenAI-style key', fragments('sk', '-', 'FIXTUREvalue0123', '456789abcdef')],
  ['a Google API key', fragments('AI', 'za', 'FIXTUREvalue0123456789', 'abcdefghijklm')],
  ['a Google short-form API key', fragments('AQ', '.', 'FIXTUREvalue0123456789', 'abc')],
  ['a bearer credential', fragments('Bearer ', 'eyJhbG', 'ciOiJIUzI1NiJ9', 'FIXTUREvalue')],
  ['a GitHub token', fragments('ghp', '_', 'FIXTUREvalue0123456789', 'abcdef')],
  ['a Slack token', fragments('xox', 'b-', 'FIXTURE-value-0123456789')],
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Runs the guard and returns the refusal it must raise.
 *
 * `expect(...).toThrow()` would prove that something was thrown; the tests
 * below also need the typed `leaks`, and they must fail loudly — rather than
 * silently skipping their assertions — when nothing is thrown at all.
 */
function refusalFor(
  evidence: NarrativeRunEvidence,
  secretValues: readonly string[],
  personalValues: readonly string[] = [],
): EvidenceLeakError {
  try {
    assertEvidenceSanitized(evidence, secretValues, personalValues);
  } catch (error) {
    if (error instanceof EvidenceLeakError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected assertEvidenceSanitized to refuse, but it returned normally');
}

/** Puts a value on the ACCEPTED attempt, leaving every other attempt alone. */
function attemptsWithResponseId(value: string): readonly EvidenceRouteAttempt[] {
  return BASE_INPUT.attempts.map((attempt) =>
    attempt.outcome === 'accepted' ? { ...attempt, responseId: value } : attempt,
  );
}

/** Puts a value on the first route verdict, leaving every other one alone. */
function verdictsWithStatement(value: string): readonly EvidenceRouteVerdict[] {
  return BASE_INPUT.routeVerdicts.map((verdict, index) =>
    index === 0 ? { ...verdict, statement: value } : verdict,
  );
}

/** The first credential the fixture environment configures. */
function firstConfiguredSecret(): string {
  const secret = CONFIGURED_SECRETS[0];
  if (secret === undefined) {
    throw new Error('fixture defect: the fixture environment configures no credential');
  }
  return secret;
}

// ---------------------------------------------------------------------------
// The baseline itself.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: the baseline every case below mutates is a real, gate-passing run', () => {
  it('passed both gates and produced a Golden Reading, so a mutation is the only variable', () => {
    expect(
      QA.findings,
      `the baseline candidate was blocked:\n${QA.findings.map((finding) => `  ${finding.code}: ${finding.message}`).join('\n')}`,
    ).toEqual([]);
    expect(QA.status).toBe('PASS');
    expect(READING).not.toBeNull();
  });

  it('carries a two-attempt history whose accepted attempt has a response id to overwrite', () => {
    // The nested-field cases plant their credential here. If the baseline had
    // no accepted attempt, `attemptsWithResponseId` would change nothing and
    // those cases would be asserting against an unmutated record.
    const accepted = BASE_INPUT.attempts.filter((attempt) => attempt.outcome === 'accepted');

    expect(BASE_INPUT.attempts).toHaveLength(2);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.responseId).not.toBeNull();
  });

  it('declares all four approved credentials and the subject personal data it must refuse', () => {
    // Both lists are derived, not retyped. A silently empty derivation would
    // make every "is refused" case below pass for the wrong reason.
    expect(CONFIGURED_SECRETS).toHaveLength(4);
    expect(CONFIGURED_SECRETS.every((secret) => secret.length > 0)).toBe(true);
    expect(SUBJECT_PERSONAL_VALUES).toEqual(['Musterkundin A', '1990-06-15']);
  });
});

// ---------------------------------------------------------------------------
// 1. The builder's own guarantees.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: buildRunEvidence pins the cost contract and anchors the record in its own text', () => {
  it('pins the POLICY and leaves the OBSERVATION exactly as it was supplied', () => {
    const evidence = evidenceWith({});

    expect(evidence.evidenceVersion).toBe(RUN_EVIDENCE_VERSION);
    // Policy: ETBZ's own decision, synthesized by the builder, always true.
    expect(evidence.approvedCostCapEur).toBe(0);
    expect(evidence.allowPaid).toBe(false);
    // Observation: NOT synthesized. The fixture run observed no cost, so the
    // record says so. `toBeNull` rather than `toBe(0)` is the whole repair —
    // if the builder ever manufactures a zero here again, this goes red.
    expect(evidence.observedBillableCostEur).toBeNull();
    // The value never travels alone: the basis says WHY it holds what it holds.
    expect(evidence.observedCostBasis.length).toBeGreaterThan(0);
  });

  it('publishes the caller\'s observation verbatim rather than flattening it', () => {
    // The builder is deliberately NOT the guard here. It records what it was
    // given — an absent measurement stays absent, and a real one is not rounded
    // into the policy number. What it must never do is manufacture a value.
    expect(evidenceWith({ observedBillableCostEur: null }).observedBillableCostEur).toBeNull();
    expect(evidenceWith({ observedBillableCostEur: 0 }).observedBillableCostEur).toBe(0);
  });

  it('checks the cap on a REFUSED run, where no evidence record exists', () => {
    // The path the record-level guard cannot reach. A terminal failure, a
    // truncated answer or unparseable output ends the run before any evidence is
    // built, and the attempts leave on the error instead — so a cap check that
    // only ever sees a completed record never sees the runs most likely to have
    // been charged for. A route that answered and was then rejected still
    // generated the tokens it bills for.
    const chargedLedger = [
      { order: 1, routeId: 'tokenrouter', outcome: 'transient_failure', errorCode: 'LLM_TIMEOUT', failoverAuthorized: true, reportedCost: null },
      { order: 4, routeId: 'openrouter', outcome: 'content_rejected', errorCode: 'PROVIDER_OUTPUT_TRUNCATED', failoverAuthorized: false, reportedCost: { amount: 0.0021, currency: 'USD', source: 'usage.cost' } },
    ];

    expect(() => {
      assertNoReportedCharge(chargedLedger);
    }).toThrow(ObservedCostExceedsCapError);

    // A ledger that reported nothing, and one that reported zero, both pass.
    expect(() => {
      assertNoReportedCharge(chargedLedger.map((a) => ({ ...a, reportedCost: null })));
    }).not.toThrow();
    expect(() => {
      assertNoReportedCharge([{ reportedCost: { amount: 0, currency: null, source: 'usage.cost' } }]);
    }).not.toThrow();
    // An attempt shape that carries no cost field at all is not a charge.
    expect(() => {
      assertNoReportedCharge([{}]);
    }).not.toThrow();
  });

  it('refuses an observed zero that the run\'s own attempts do not support', () => {
    // The other half, and the half that makes the docblock's guarantee true.
    // Every attempt in BASE_INPUT reports nothing, so a published 0 is a number
    // the caller asserted rather than observed — exactly the original defect,
    // moved one call up the stack once the builder stopped inventing it.
    expect(() => {
      assertObservedCostWithinCap(evidenceWith({ observedBillableCostEur: 0 }));
    }).toThrow(ObservedCostNotDerivableError);

    // The truthful record of the same run passes.
    expect(() => {
      assertObservedCostWithinCap(evidenceWith({ observedBillableCostEur: null }));
    }).not.toThrow();
  });

  it('overwrites caller-supplied POLICY fields rather than carrying them', () => {
    // The two POLICY fields are spread AFTER the caller's input, so a tampered
    // cap or a tampered allowPaid cannot survive. The types forbid this call,
    // which is why the input is laundered through an untyped record here: the
    // point is what happens when it comes from somewhere the compiler never saw,
    // such as a deserialised run record. The OBSERVATION is deliberately not
    // clamped this way — clamping it would delete the evidence that a run cost
    // money — so it is refused instead, by the two tests above.
    const tampered: Record<string, unknown> = {
      ...BASE_INPUT,
      approvedCostCapEur: 99,
      allowPaid: true,
    };

    const evidence = buildRunEvidence(tampered as unknown as BuildRunEvidenceInput);

    expect(evidence.approvedCostCapEur).toBe(0);
    expect(evidence.allowPaid).toBe(false);
  });

  it('refuses a record in which a provider reported a non-zero cost', () => {
    // The observation is caller-supplied, so the builder can no longer clamp a
    // paid value to zero — and it must not. Clamping would DELETE the evidence
    // that a run cost money. The fail-closed duty moved to a guard that refuses
    // the record instead, and it reads the raw reports rather than the reduced
    // EUR figure, so a cost in a currency ETBZ cannot convert cannot slip past
    // as a null.
    const charged = {
      ...BASE_INPUT,
      attempts: BASE_INPUT.attempts.map((attempt) => ({
        ...attempt,
        reportedCost: { amount: 0.0042, currency: 'USD', source: 'usage.cost' },
      })),
      observedBillableCostEur: null,
    };

    expect(() => {
      assertObservedCostWithinCap(buildRunEvidence(charged));
    }).toThrow(ObservedCostExceedsCapError);

    // A reported zero is a real observation and is NOT refused.
    const free = {
      ...BASE_INPUT,
      attempts: BASE_INPUT.attempts.map((attempt) => ({
        ...attempt,
        reportedCost: { amount: 0, currency: null, source: 'usage.cost' },
      })),
      observedBillableCostEur: 0,
    };
    expect(() => {
      assertObservedCostWithinCap(buildRunEvidence(free));
    }).not.toThrow();
  });

  it('reduces provider reports to EUR only when it can do so without inventing a rate', () => {
    const attempt = BASE_INPUT.attempts[0];
    if (attempt === undefined) {
      throw new Error('fixture defect: the fixture run has no attempts');
    }
    const withCost = (reportedCost: {
      amount: number;
      currency: string | null;
      source: string;
    } | null): typeof attempt => ({ ...attempt, reportedCost });

    // Nothing reported at all.
    expect(observedBillableCostEurFrom([withCost(null)])).toBeNull();
    // A reported zero IS an observation: zero is the same amount in every
    // currency, so an unlabelled zero is still zero EUR.
    expect(
      observedBillableCostEurFrom([withCost({ amount: 0, currency: null, source: 'usage.cost' })]),
    ).toBe(0);
    // Labelled EUR, so it can be stated as EUR.
    expect(
      observedBillableCostEurFrom([withCost({ amount: 1.5, currency: 'EUR', source: 'usage.cost' })]),
    ).toBe(1.5);
    // Non-zero and not EUR: unconvertible without a rate ETBZ would invent, so
    // the EUR field stays null — and the cap guard above is what stops that null
    // from being mistaken for "nothing happened".
    expect(
      observedBillableCostEurFrom([withCost({ amount: 1.5, currency: 'USD', source: 'usage.cost' })]),
    ).toBeNull();
  });

  it('publishes a canonicalJson that is the canonical text of the record minus its own two self-referential fields', () => {
    const evidence = evidenceWith({});
    // The two self-referential fields are removed by name rather than by
    // destructuring, so this stays a statement about the published record and
    // not about a shape retyped here.
    const core: Record<string, unknown> = { ...evidence };
    delete core['canonicalJson'];
    delete core['structuralHash'];

    expect(canonicalJson(core)).toBe(evidence.canonicalJson);
  });

  it('publishes a structuralHash that is a plain sha256 of that canonical text, re-derived here', () => {
    const evidence = evidenceWith({});

    // Independent derivation with the platform digest. The prefix is spelled
    // out rather than imported: a hash is only evidence if a reader with
    // `sha256sum` and the published text can reproduce it without this code.
    const digest = createHash('sha256').update(evidence.canonicalJson, 'utf8').digest('hex');

    expect(evidence.structuralHash).toBe(`sha256:${digest}`);
  });

  it('changes that hash when any field of the record changes', () => {
    // Without this, the previous assertion would also hold for a constant.
    const baseline = evidenceWith({});
    const mutated = evidenceWith({ structuralGate: 'BLOCKED' });

    expect(mutated.structuralHash).not.toBe(baseline.structuralHash);
  });

  it('binds the run to an exact answer by hash without republishing the answer text', () => {
    const evidence = evidenceWith({});
    const accepted = evidence.attempts.find((attempt) => attempt.outcome === 'accepted');

    // Reconstructable: the hash of the exact answer is there.
    expect(accepted?.responseHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Sanitized: the prose the provider wrote is not. A distinctive sentence
    // fragment from the verified fixture answer is the probe.
    expect(evidence.canonicalJson).not.toContain('Der Tagesmeister Xin steht im Element');
  });
});

// ---------------------------------------------------------------------------
// 2. A credential VALUE anywhere in the record.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: a configured credential value is refused wherever it sits', () => {
  it('accepts the clean record with the real credential list supplied (positive control)', () => {
    // The control that makes every refusal below mean something: the same call,
    // the same list, an unmutated record, and no refusal.
    expect(() => {
      assertEvidenceSanitized(evidenceWith({}), CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);
    }).not.toThrow();
  });

  it('refuses a credential placed in observedCostBasis', () => {
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({
      observedCostBasis: `${BASE_INPUT.observedCostBasis} Key used: ${secret}`,
    });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal).toBeInstanceOf(EvidenceLeakError);
    expect(refusal.code).toBe('EVIDENCE_NOT_SANITIZED');
    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value']);
  });

  it('refuses a credential placed in a nested attempt record', () => {
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({ attempts: attemptsWithResponseId(secret) });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value']);
  });

  it('refuses a credential placed in a nested route verdict', () => {
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({ routeVerdicts: verdictsWithStatement(secret) });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value']);
  });

  it('refuses a credential placed in a field that has nothing to do with credentials', () => {
    // `candidateSha` is a commit id. A guard written field-by-field would never
    // have thought to check it, which is the whole argument for serialise-then-
    // search: a field added after the guard was written is covered anyway.
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({ candidateSha: `${CANDIDATE_SHA}-${secret}` });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value']);
  });

  it('refuses every one of the four configured credentials, not only the first', () => {
    for (const secret of CONFIGURED_SECRETS) {
      const evidence = evidenceWith({ acceptedModel: `${BASE_INPUT.acceptedModel ?? ''}+${secret}` });

      const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

      expect(refusal.leaks.map((leak) => leak.kind), `credential ${String(CONFIGURED_SECRETS.indexOf(secret))} must be refused`).toEqual([
        'secret_value',
      ]);
    }
  });

  it('reports one finding per class when two different credentials leak at once', () => {
    // Repeating the same finding per matching key would count one defect four
    // times and tell a reader nothing more than the first one did.
    const [first, second] = CONFIGURED_SECRETS;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const evidence = evidenceWith({
      observedCostBasis: `${BASE_INPUT.observedCostBasis} ${String(first)} ${String(second)}`,
    });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.leaks).toHaveLength(1);
    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value']);
  });

  it('accepts a credential-free record even when a credential is a substring of nothing in it', () => {
    // The mirror of the cases above and the second positive control of this
    // block: the same four credentials, a record that simply does not carry
    // them, and no refusal. A guard that matched on something other than the
    // value — a field name, a length, a prefix — would fail here.
    const evidence = evidenceWith({
      observedCostBasis: 'Zero by route eligibility. No credential value is recorded anywhere.',
    });

    expect(() => {
      assertEvidenceSanitized(evidence, CONFIGURED_SECRETS);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. A credential SHAPE the caller never declared.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: a credential-shaped token is refused even when the caller never declared it', () => {
  it.each(SHAPED_CREDENTIALS)('refuses %s that is absent from the declared list', (_label, token) => {
    // The precondition IS the property: the declared list does not contain this
    // token, so the refusal cannot have come from the value comparison.
    expect(CONFIGURED_SECRETS).not.toContain(token);

    const evidence = evidenceWith({ observedCostBasis: `${BASE_INPUT.observedCostBasis} ${token}` });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.leaks.map((leak) => leak.kind)).toContain('secret_shape');
  });

  it('refuses a shaped token even when the declared list is empty', () => {
    const [, token] = SHAPED_CREDENTIALS[0] ?? [];
    expect(token).toBeDefined();
    const evidence = evidenceWith({ observedCostBasis: `Key: ${String(token)}` });

    const refusal = refusalFor(evidence, []);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_shape']);
  });

  it('refuses a shaped token in a nested attempt record', () => {
    const [, token] = SHAPED_CREDENTIALS[1] ?? [];
    expect(token).toBeDefined();
    const evidence = evidenceWith({ attempts: attemptsWithResponseId(String(token)) });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.leaks.map((leak) => leak.kind)).toContain('secret_shape');
  });

  it('accepts the same field with a prefix that is too short to be a credential (positive control)', () => {
    // One thing changed against the refused case above: the length of the tail.
    // `sk-` alone is not a credential, and a guard that treated it as one would
    // be unusable in prose.
    const evidence = evidenceWith({
      observedCostBasis: `${BASE_INPUT.observedCostBasis} ${fragments('sk', '-short')}`,
    });

    expect(() => {
      assertEvidenceSanitized(evidence, CONFIGURED_SECRETS);
    }).not.toThrow();
  });

  it('accepts ordinary prose in which a word merely ends in the prefix letters', () => {
    // `desk-side-…` contains the characters `sk-` followed by a long token, and
    // is refused by a naive substring check. The pattern is anchored on a word
    // boundary, so it is accepted here — which is what keeps the guard usable.
    const evidence = evidenceWith({
      observedCostBasis: fragments('Reviewed at the desk', '-side-handover-0123456789abcdef'),
    });

    expect(() => {
      assertEvidenceSanitized(evidence, CONFIGURED_SECRETS);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Personal data of the subject.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: a personal datum of the subject is refused', () => {
  it('accepts the clean record with the subject personal data declared (positive control)', () => {
    expect(() => {
      assertEvidenceSanitized(evidenceWith({}), CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);
    }).not.toThrow();
  });

  it('refuses the subject display name placed in observedCostBasis', () => {
    const evidence = evidenceWith({
      observedCostBasis: `${BASE_INPUT.observedCostBasis} Reading for ${MODEL.displayName}.`,
    });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);

    expect(refusal.code).toBe('EVIDENCE_NOT_SANITIZED');
    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['personal_value']);
  });

  it('refuses the subject display name placed in a nested attempt record', () => {
    const evidence = evidenceWith({ attempts: attemptsWithResponseId(MODEL.displayName) });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['personal_value']);
  });

  it('refuses the subject birth date, which is personal data with no credential shape', () => {
    const evidence = evidenceWith({ candidateSha: `${CANDIDATE_SHA}-${MODEL.birth.date}` });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['personal_value']);
  });

  it('reports both classes when a credential and a personal datum leak together', () => {
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({
      observedCostBasis: `${BASE_INPUT.observedCostBasis} ${secret} for ${MODEL.displayName}`,
    });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value', 'personal_value']);
  });

  it('leaves an UNDECLARED personal datum to the caller, because personal data has no shape', () => {
    // Stated as a property rather than left implicit: unlike a credential, a
    // display name is indistinguishable from prose, so this guard covers
    // exactly what the caller declares. The live run therefore declares the
    // subject's name and birth date explicitly, and this test is the reason
    // that call site cannot be quietly shortened.
    const evidence = evidenceWith({
      observedCostBasis: `${BASE_INPUT.observedCostBasis} Reading for ${MODEL.displayName}.`,
    });

    expect(() => {
      assertEvidenceSanitized(evidence, CONFIGURED_SECRETS, []);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. The guard is not vacuous.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: a blank entry in a declared list is ignored, not matched', () => {
  it('accepts a clean record when the secret list contains an empty string', () => {
    // The property that separates a guard from a permanent refusal: an empty
    // string is a substring of every text, so a guard that matched one would
    // refuse every record ever built. Refusing everything is the same as
    // checking nothing.
    expect(() => {
      assertEvidenceSanitized(evidenceWith({}), ['']);
    }).not.toThrow();
  });

  it('accepts a clean record when the secret list contains only whitespace', () => {
    expect(() => {
      assertEvidenceSanitized(evidenceWith({}), ['   ', '\t', '\n']);
    }).not.toThrow();
  });

  it('accepts a clean record when the personal list contains a blank entry', () => {
    expect(() => {
      assertEvidenceSanitized(evidenceWith({}), CONFIGURED_SECRETS, ['', '  ']);
    }).not.toThrow();
  });

  it('still refuses when a real credential sits beside the blank entries (positive control)', () => {
    // Without this, "blank entries are ignored" would also be satisfied by a
    // guard that ignores its list entirely. One thing changed against the first
    // case in this block: a real value added to the same list.
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({ observedCostBasis: `Key: ${secret}` });

    const refusal = refusalFor(evidence, ['', '   ', secret]);

    expect(refusal.leaks.map((leak) => leak.kind)).toEqual(['secret_value']);
  });
});

// ---------------------------------------------------------------------------
// 6. The refusal does not republish what it refuses.
// ---------------------------------------------------------------------------

describe('ETBZ-25B evidence: the refusal names the defect without repeating the value', () => {
  it('keeps a leaked credential value out of the message and out of every description', () => {
    // A guard that prints the secret it found has moved the leak from the
    // evidence file into the CI log, where it is harder to delete.
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({ observedCostBasis: `Key: ${secret}` });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.message).not.toContain(secret);
    for (const leak of refusal.leaks) {
      expect(leak.description).not.toContain(secret);
    }
  });

  it('keeps a leaked shaped token out of the message and out of every description', () => {
    const [, token] = SHAPED_CREDENTIALS[0] ?? [];
    expect(token).toBeDefined();
    const evidence = evidenceWith({ observedCostBasis: `Key: ${String(token)}` });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal.message).not.toContain(String(token));
    for (const leak of refusal.leaks) {
      expect(leak.description).not.toContain(String(token));
    }
  });

  it('keeps a leaked personal datum out of the message and out of every description', () => {
    const evidence = evidenceWith({
      observedCostBasis: `Reading for ${MODEL.displayName}, born ${MODEL.birth.date}.`,
    });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS, SUBJECT_PERSONAL_VALUES);

    expect(refusal.message).not.toContain(MODEL.displayName);
    expect(refusal.message).not.toContain(MODEL.birth.date);
    for (const leak of refusal.leaks) {
      expect(leak.description).not.toContain(MODEL.displayName);
      expect(leak.description).not.toContain(MODEL.birth.date);
    }
  });

  it('still says enough to act on: a typed error, a code, and a named class per leak (positive control)', () => {
    // Redaction is only half the contract. An error that says nothing is as
    // useless as one that says too much, so this control requires the refusal
    // to be typed, coded, named and specific about WHAT was found.
    const secret = firstConfiguredSecret();
    const evidence = evidenceWith({ observedCostBasis: `Key: ${secret}` });

    const refusal = refusalFor(evidence, CONFIGURED_SECRETS);

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('EvidenceLeakError');
    expect(refusal.code).toBe('EVIDENCE_NOT_SANITIZED');
    expect(refusal.message).toContain('not sanitized');
    expect(refusal.leaks).toHaveLength(1);
    expect(refusal.leaks[0]?.description).toContain('credential');
  });

  it('names the recognised shape so a reader knows what to look for', () => {
    const [, token] = SHAPED_CREDENTIALS[1] ?? [];
    expect(token).toBeDefined();
    const evidence = evidenceWith({ observedCostBasis: `Key: ${String(token)}` });

    const refusal = refusalFor(evidence, []);

    // The description says what KIND of credential was recognised; the value
    // itself stays out of it. Both halves are asserted, not just the first.
    expect(refusal.leaks[0]?.description).toContain('Google API key');
    expect(refusal.leaks[0]?.description).not.toContain(String(token));
  });
});
