/**
 * ETBZ-25 — the NarrativeProvider port.
 *
 * The application owns this boundary; a concrete provider (a hosted model, a
 * local model, anything) would live outside `src/application` and conform to
 * it. In THIS slice no such implementation exists and none is reachable: there
 * is no credential, no endpoint, no cost path and no network call anywhere
 * behind this interface. The only implementation shipped is the deterministic
 * one in `src/application/interpretation/deterministic-narrative-provider.ts`.
 *
 * The port's whole design intent: a provider produces STRUCTURED output that
 * quotes the facts it used, so that every sentence can be re-checked against
 * the HoroscopeModel. Free prose is allowed; unbound free prose is not.
 */

import { z } from 'zod';
import type { NarrativeBrief } from '../interpretation/narrative-brief.js';

/**
 * One fact the provider claims to have used, echoed back verbatim.
 *
 * The echo is the load-bearing part of the contract. A provider cannot mutate a
 * chart fact without either changing this value (caught by comparison against
 * the HoroscopeModel) or leaving it correct (in which case the fact is intact).
 */
export interface NarrativeCitation {
  readonly factId: string;
  /** The fact's value, exactly as the brief stated it. */
  readonly value: string;
}

export interface NarrativeSectionDraft {
  readonly themeId: string;
  readonly citedFacts: readonly NarrativeCitation[];
  /** Free interpretive text. Bound by the citations above, not by a template. */
  readonly prose: string;
  /** Provider-authored uncertainty statements. Never source-owned evidence. */
  readonly uncertaintyNotes: readonly string[];
}

export interface NarrativeProviderOutput {
  readonly providerId: string;
  /** Binds the answer to one specific brief. */
  readonly briefStructuralHash: string;
  readonly sections: readonly NarrativeSectionDraft[];
}

export interface NarrativeProvider {
  readonly id: string;
  generate(brief: NarrativeBrief): Promise<NarrativeProviderOutput>;
}

/**
 * STRUCTURAL schema only.
 *
 * It answers "is this the right shape?" and nothing else. Emptiness, grounding,
 * fact identity and method scope are SEMANTIC questions and are answered in
 * `report-model.ts` against the HoroscopeModel — deliberately not here, so that
 * each guard has exactly one owner and none of them is a duplicate that could
 * never fail.
 */
export const narrativeCitationSchema = z.strictObject({
  factId: z.string().min(1),
  value: z.string(),
});

export const narrativeSectionDraftSchema = z.strictObject({
  themeId: z.string().min(1),
  citedFacts: z.array(narrativeCitationSchema),
  prose: z.string(),
  uncertaintyNotes: z.array(z.string()),
});

export const narrativeProviderOutputSchema = z.strictObject({
  providerId: z.string().min(1),
  briefStructuralHash: z.string().min(1),
  sections: z.array(narrativeSectionDraftSchema),
});
