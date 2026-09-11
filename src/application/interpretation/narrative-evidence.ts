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
 * ON COST. `billableCostEur` is `0`, and `billableCostBasis` states in words
 * HOW that is known. None of the approved routes returns a per-call invoice, so
 * the zero rests on route eligibility — a provider-published zero-price model
 * marker — and not on a billing readback. Saying so is the difference between
 * evidence and a comfortable number.
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
  readonly billableCostEur: 0;
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
  readonly billableCostCapEur: 0;
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
  readonly billableCostEur: 0;
  /** How the zero above is known. Never a bare number without its basis. */
  readonly billableCostBasis: string;
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

export type BuildRunEvidenceInput = Omit<
  NarrativeRunEvidence,
  'evidenceVersion' | 'billableCostCapEur' | 'allowPaid' | 'billableCostEur' | 'canonicalJson' | 'structuralHash'
>;

/** Assembles the record and anchors it with its own canonical text. */
export function buildRunEvidence(input: BuildRunEvidenceInput): NarrativeRunEvidence {
  const core = {
    evidenceVersion: RUN_EVIDENCE_VERSION,
    ...input,
    billableCostCapEur: 0 as const,
    allowPaid: false as const,
    billableCostEur: 0 as const,
  };
  const canonical = canonicalJson(core);
  return {
    ...core,
    canonicalJson: canonical,
    structuralHash: structuralHashOfCanonicalText(canonical),
  };
}
