/**
 * ETBZ-25B — the sanitized run evidence, and the guard that keeps it sanitized.
 *
 * The Product Owner contract asks for evidence "sufficient to reconstruct the
 * run without PII or secrets". Those are two different obligations and this
 * module treats them as two:
 *
 *  RECONSTRUCTABLE  every identifier needed to say WHICH code, WHICH brief,
 *                   WHICH prompt, WHICH route and WHICH answer produced a
 *                   reading — candidate SHA, brief hash, prompt hash and
 *                   version, route and model ids, attempt order and reason,
 *                   response hash, token usage, both gate verdicts.
 *
 *  SANITIZED        no credential and no personal datum, PROVEN rather than
 *                   intended. `assertEvidenceSanitized` serialises the record
 *                   and searches the resulting text — so a secret that reached
 *                   any field, including one added later by someone who never
 *                   read this comment, is caught by construction rather than by
 *                   remembering to check that field.
 *
 * The record deliberately carries NO answer text: a response hash binds the
 * evidence to an exact answer without republishing it, and the reading itself
 * lives in the Golden Reading artefact where a human is meant to read it.
 *
 * ON COST: THE RECORD KEEPS POLICY AND OBSERVATION APART.
 *
 *  approvedCostCapEur        POLICY. The cap ETBZ approved for this slice, and
 *  allowPaid                 the fact that no paid path is authorised. Both are
 *                            decisions, pinned in the type, true regardless of
 *                            what any provider reports.
 *
 *  reportedCost (per attempt) OBSERVATION. What a provider said the call cost,
 *                            verbatim and un-converted. `null` when it said
 *                            nothing, which is the ordinary case: three of the
 *                            four approved routes return no cost field at all.
 *
 *  observedBillableCostEur   OBSERVATION, reduced to the currency the cap is
 *                            written in. `null` when no provider reported a
 *                            cost, or when what they reported cannot be stated
 *                            in EUR without an exchange rate ETBZ would have to
 *                            invent.
 *
 *  observedCostBasis         WHY the field above holds what it holds.
 *
 * These were one field. The record published `billableCostEur: 0` for every run,
 * and that zero came from the free-model MARKER in a model id — a defensive
 * eligibility guard, not an invoice. A reader had no way to tell it from a
 * measured zero.
 *
 * TWO THINGS NOW STAND BETWEEN A RUN AND A FABRICATED ZERO, and it takes both.
 * The observation is nullable and `buildRunEvidence` no longer writes it, so the
 * builder cannot invent one. But the builder does not police it either — it
 * publishes what the caller passed — so on its own that only moves the invention
 * one call up the stack. `assertObservedCostWithinCap` closes it: the published
 * figure must equal what `observedBillableCostEurFrom` derives from the record's
 * OWN attempts, so a hand-written zero over attempts that reported nothing is
 * refused rather than filed.
 *
 * Fail-closed is unchanged and now applies to the observation too:
 * `assertObservedCostWithinCap` refuses a record in which a provider reported
 * any non-zero amount, in any currency — so a cost ETBZ cannot express in EUR
 * cannot hide behind a `null`.
 */

import { canonicalJson } from '../../domain/canonical-json.js';
import { structuralHashOfCanonicalText } from '../../domain/structural-hash.js';
import type { NarrativeQaFinding } from './semantic-qa.js';

export const RUN_EVIDENCE_VERSION = 'etbz-25b.run-evidence.v1' as const;

/**
 * Token usage exactly as a provider reported it.
 *
 * Declared here, in the application layer, rather than imported from the
 * adapter: evidence is an application concern and `application -> adapters` is
 * the one direction the architecture guard forbids. TypeScript's structural
 * typing makes the adapter's own shape satisfy this one, so the two cannot
 * drift apart without a compile error at the call site.
 */
export interface EvidenceUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

/**
 * A provider-reported cost, mirrored into the application layer.
 *
 * Declared here rather than imported from the adapter for the same reason
 * `EvidenceUsage` is: `application -> adapters` is the one direction the
 * architecture guard forbids. Structural typing makes the adapter's own
 * `ReportedCost` satisfy this, so the two cannot drift without a compile error.
 */
export interface EvidenceReportedCost {
  readonly amount: number;
  readonly currency: string | null;
  readonly source: string;
}

export interface EvidenceRouteAttempt {
  readonly order: number;
  readonly routeId: string;
  readonly model: string;
  readonly outcome: 'accepted' | 'transient_failure' | 'terminal_failure' | 'content_rejected';
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
  readonly failoverAuthorized: boolean;
  readonly usage: EvidenceUsage | null;
  readonly responseId: string | null;
  readonly responseHash: string | null;
  readonly finishReason: string | null;
  /** What the provider reported. `null` means it reported nothing. Not zero. */
  readonly reportedCost: EvidenceReportedCost | null;
}

export interface EvidenceRouteVerdict {
  readonly routeId: string;
  readonly order: number;
  readonly eligible: boolean;
  readonly ineligibleReason: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly noChargeBasis: string;
  readonly statement: string;
}

export interface NarrativeRunEvidence {
  readonly evidenceVersion: typeof RUN_EVIDENCE_VERSION;
  /** The exact ETBZ commit the run executed from. */
  readonly candidateSha: string;
  readonly briefStructuralHash: string;
  readonly promptStructuralHash: string;
  readonly promptVersion: string;
  readonly policyVersion: string;
  readonly qaVersion: string;
  /** POLICY: the cap ETBZ approved. Not configurable in this slice. */
  readonly approvedCostCapEur: 0;
  /** POLICY: no paid provider path is authorised. */
  readonly allowPaid: false;
  readonly routeVerdicts: readonly EvidenceRouteVerdict[];
  readonly attempts: readonly EvidenceRouteAttempt[];
  readonly acceptedRouteId: string | null;
  readonly acceptedModel: string | null;
  readonly reportStructuralHash: string | null;
  readonly structuralGate: 'PASS' | 'BLOCKED' | 'NOT_RUN';
  readonly semanticQaStatus: 'PASS' | 'BLOCKED' | 'NOT_RUN';
  readonly semanticQaFindings: readonly NarrativeQaFinding[];
  readonly goldenReadingStatus: 'CANDIDATE_READY_FOR_HUMAN_REVIEW' | 'BLOCKED' | 'NOT_PRODUCED';
  readonly goldenReadingHash: string | null;
  /**
   * OBSERVATION: the cost providers actually reported, in EUR.
   *
   * `null` is the expected value and means NOT OBSERVED. It is deliberately not
   * `0`: a zero here is a claim that something was measured.
   */
  readonly observedBillableCostEur: number | null;
  /** Why the field above holds what it holds. Never a bare number alone. */
  readonly observedCostBasis: string;
  readonly canonicalJson: string;
  readonly structuralHash: string;
}

export type EvidenceLeakKind = 'secret_value' | 'secret_shape' | 'personal_value';

export interface EvidenceLeak {
  readonly kind: EvidenceLeakKind;
  /** WHAT was found, never the found value itself. */
  readonly description: string;
}

export class EvidenceLeakError extends Error {
  readonly code: 'EVIDENCE_NOT_SANITIZED';
  readonly leaks: readonly EvidenceLeak[];
  constructor(leaks: readonly EvidenceLeak[]) {
    super(
      `evidence is not sanitized and was refused: ${leaks.map((leak) => leak.description).join('; ')}`,
    );
    this.name = 'EvidenceLeakError';
    this.code = 'EVIDENCE_NOT_SANITIZED';
    this.leaks = leaks;
  }
}

/**
 * Shapes that are credentials whatever they are called.
 *
 * The value-based check below catches the keys ETBZ actually holds. These
 * patterns catch the other case — a credential that entered the record from
 * somewhere the caller did not think to declare — so the guard does not depend
 * on the caller's list being complete.
 */
const SECRET_SHAPE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an OpenAI-style `sk-` secret key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/\bAQ\.[A-Za-z0-9_-]{20,}/, 'a Google short-form API key'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, 'an Authorization bearer credential'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub personal access token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
] as const;

/**
 * Refuses an evidence record that carries a secret or a personal datum.
 *
 * `secretValues` are the credentials this run had access to and
 * `personalValues` the personal data of the subject — a display name, a birth
 * date. Both are compared against the SERIALISED record, so the guard covers
 * every field including ones added after this function was written.
 *
 * Blank entries are ignored rather than matched: an empty string occurs in
 * every text, and treating one as a secret would make the guard fail always,
 * which is the same as not having a guard.
 */
export function assertEvidenceSanitized(
  evidence: NarrativeRunEvidence,
  secretValues: readonly string[],
  personalValues: readonly string[] = [],
): void {
  const serialized = canonicalJson(evidence);
  const leaks: EvidenceLeak[] = [];

  for (const secret of secretValues) {
    if (secret.trim().length === 0) {
      continue;
    }
    if (serialized.includes(secret)) {
      leaks.push({
        kind: 'secret_value',
        description: 'a configured credential value appears in the evidence record',
      });
      // One finding per class. Repeating it per key would count the same defect
      // several times and tell a reader nothing more.
      break;
    }
  }

  for (const [pattern, description] of SECRET_SHAPE_PATTERNS) {
    if (pattern.test(serialized)) {
      leaks.push({
        kind: 'secret_shape',
        description: `the evidence record contains something shaped like ${description}`,
      });
    }
  }

  for (const personal of personalValues) {
    if (personal.trim().length === 0) {
      continue;
    }
    if (serialized.includes(personal)) {
      leaks.push({
        kind: 'personal_value',
        description: 'a personal datum of the subject appears in the evidence record',
      });
      break;
    }
  }

  if (leaks.length > 0) {
    throw new EvidenceLeakError(leaks);
  }
}

/**
 * Reduces what the providers reported to the currency the cap is written in.
 *
 * FOUR ANSWERS, and the boundaries between them are the point:
 *
 *  - nobody reported anything            -> `null`. NOT OBSERVED.
 *  - every report is exactly zero        -> `0`. A genuine observation: zero is
 *                                          the same amount in every currency, so
 *                                          an unlabelled reported zero is still
 *                                          a zero in EUR.
 *  - every report is labelled EUR        -> their sum.
 *  - anything else (a non-zero amount in
 *    an unstated or other currency)      -> `null`, because stating it in EUR
 *                                          would need an exchange rate ETBZ
 *                                          invented. That `null` is not a way
 *                                          out: `assertObservedCostWithinCap`
 *                                          refuses the record outright.
 */
export function observedBillableCostEurFrom(
  attempts: readonly EvidenceRouteAttempt[],
): number | null {
  const reports = attempts
    .map((attempt) => attempt.reportedCost)
    .filter((cost): cost is EvidenceReportedCost => cost !== null);
  if (reports.length === 0) {
    return null;
  }
  if (reports.every((cost) => cost.amount === 0)) {
    return 0;
  }
  if (reports.every((cost) => cost.currency?.toUpperCase() === 'EUR')) {
    return reports.reduce((total, cost) => total + cost.amount, 0);
  }
  return null;
}

export class ObservedCostExceedsCapError extends Error {
  readonly code: 'OBSERVED_COST_EXCEEDS_CAP';
  readonly reported: readonly EvidenceReportedCost[];
  constructor(reported: readonly EvidenceReportedCost[]) {
    super(
      `a provider reported a non-zero cost for this run; the approved ETBZ-25B development cap is 0.00 EUR and a run that cost money is refused rather than recorded: ${reported
        .map((cost) => `${String(cost.amount)} ${cost.currency ?? 'unlabelled'} (${cost.source})`)
        .join(', ')}`,
    );
    this.name = 'ObservedCostExceedsCapError';
    this.code = 'OBSERVED_COST_EXCEEDS_CAP';
    this.reported = reported;
  }
}

export class ObservedCostNotDerivableError extends Error {
  readonly code: 'OBSERVED_COST_NOT_DERIVABLE';
  readonly published: number | null;
  readonly derived: number | null;
  constructor(published: number | null, derived: number | null) {
    super(
      `the published observed cost does not follow from the run's own attempts: the record says ${published === null ? 'not observed' : String(published)} while its attempts support ${derived === null ? 'not observed' : String(derived)}; an observation that cannot be derived from the evidence is not an observation`,
    );
    this.name = 'ObservedCostNotDerivableError';
    this.code = 'OBSERVED_COST_NOT_DERIVABLE';
    this.published = published;
    this.derived = derived;
  }
}

/**
 * Refuses a record whose cost claims do not hold up.
 *
 * Two refusals. A provider reported a non-zero cost — the run breached the cap.
 * Or the published EUR figure does not follow from the record's own attempts —
 * the number was asserted rather than observed.
 *
 * Checks the RAW REPORTS, not `observedBillableCostEur`. Reading the reduced
 * field would let the one case that most needs refusing slip through: a non-zero
 * amount in a currency ETBZ cannot convert reduces to `null`, and a guard that
 * asked "is the EUR figure above the cap?" would read that `null` as nothing to
 * see. A cost ETBZ cannot express is still a cost.
 *
 * Currency-blind on purpose. No non-zero amount is acceptable under a 0.00 cap
 * in any denomination, so the guard never needs a rate to decide.
 */
/** The only thing the ledger-level cap guard needs to know about an attempt. */
export interface CostReportingAttempt {
  readonly reportedCost?: EvidenceReportedCost | null;
}

/**
 * Refuses an attempt ledger in which a provider reported a non-zero cost.
 *
 * Separate from the record-level guard below because THE LEDGER OUTLIVES THE
 * RECORD. When a run is refused — a terminal transport failure, a truncated
 * answer, output that will not parse — no evidence record is ever built and the
 * attempts travel out on the error instead. Those are precisely the runs that
 * can have been charged for: a route that answered and was then rejected still
 * answered, and still billed for it if it bills. A cap check reachable only
 * through a completed record would never see any of them.
 */
export function assertNoReportedCharge(attempts: readonly CostReportingAttempt[]): void {
  const charged = attempts
    .map((attempt) => attempt.reportedCost ?? null)
    .filter((cost): cost is EvidenceReportedCost => cost !== null)
    .filter((cost) => cost.amount !== 0);
  if (charged.length > 0) {
    throw new ObservedCostExceedsCapError(charged);
  }
}

export function assertObservedCostWithinCap(evidence: NarrativeRunEvidence): void {
  assertNoReportedCharge(evidence.attempts);
  // The published figure must be derivable from the record's own attempts.
  //
  // Without this the split is only half enforced: `buildRunEvidence` stopped
  // inventing the observation, but it publishes whatever the caller hands it, so
  // a caller could still write `observedBillableCostEur: 0` over attempts that
  // reported nothing — the original defect, moved one call up the stack. Here the
  // number has to agree with the evidence it claims to summarise.
  const derived = observedBillableCostEurFrom(evidence.attempts);
  if (evidence.observedBillableCostEur !== derived) {
    throw new ObservedCostNotDerivableError(evidence.observedBillableCostEur, derived);
  }
}

/**
 * What the caller must supply, and what it deliberately may not.
 *
 * `observedBillableCostEur` is IN this input type. That is the repair: the
 * builder used to write it itself, as a literal `0`, which made every record
 * claim a measurement nobody had taken. The only fields still synthesized are
 * the ones that are genuinely ETBZ's own statements — the version marker and the
 * two POLICY fields.
 */
export type BuildRunEvidenceInput = Omit<
  NarrativeRunEvidence,
  'evidenceVersion' | 'approvedCostCapEur' | 'allowPaid' | 'canonicalJson' | 'structuralHash'
>;

/** Assembles the record and anchors it with its own canonical text. */
export function buildRunEvidence(input: BuildRunEvidenceInput): NarrativeRunEvidence {
  const core = {
    evidenceVersion: RUN_EVIDENCE_VERSION,
    ...input,
    // POLICY only. The observation arrives from the caller and is never
    // manufactured here — see the type above.
    approvedCostCapEur: 0 as const,
    allowPaid: false as const,
  };
  const canonical = canonicalJson(core);
  return {
    ...core,
    canonicalJson: canonical,
    structuralHash: structuralHashOfCanonicalText(canonical),
  };
}
