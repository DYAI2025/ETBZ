/**
 * ETBZ-25 — the first structural QA gate for specificity, synthesis and SIZE.
 *
 * The commercial failure mode of a generated report is not a wrong sentence; it
 * is a TRUE sentence that would fit any chart. This policy is the smallest
 * mechanical defence against that: a report must carry several distinct,
 * chart-specific fact references, spread over more than one theme, and at least
 * one section must combine facts of DIFFERENT kinds rather than restating one
 * value in longer words.
 *
 * It measures structure, not literary quality — it cannot and does not claim to
 * judge whether prose is good. What it can prove is that the prose is ATTACHED:
 * a report that satisfies this policy cannot consist of unbound generic
 * paragraphs, because every section is bound to cited facts of this chart.
 *
 * `minSections` / `maxSections` are the ETBZ-25 product contract for a COMPACT
 * report: roughly three to five customer-facing chapters, each one a primary
 * theme. The ceiling is what stops the exhaustive candidate ThemeGraph from
 * leaking into the sold artefact one chapter per candidate node; the floor is
 * what stops a single-paragraph "reading". Neither bound expresses an
 * astrological opinion about how many themes a chart "has" — the candidate
 * graph keeps every one of them, and nothing is discarded to satisfy a count.
 *
 * The other thresholds are deliberately low. They are a floor that a generic
 * text fails, not a target that good text has to strain for.
 */
export interface SpecificityPolicy {
  /**
   * Minimum number of interpretation sections in a report.
   *
   * This is also the distinct-theme floor: `report-model.ts` refuses two
   * sections for the same theme, so section count and distinct-theme count are
   * the same number by construction. A separate theme threshold would be a
   * second spelling of this one and could never fail on its own.
   */
  readonly minSections: number;
  /**
   * Maximum number of interpretation sections in a report.
   *
   * Enforced BEFORE the per-section checks in `report-model.ts`, on the raw
   * section count alone: an oversized report is a violation of the product
   * contract in its own right, and naming it as such is more honest than
   * letting whichever duplicate or unknown theme happens to come first report
   * an incidental symptom.
   */
  readonly maxSections: number;
  /** Minimum number of DISTINCT chart facts cited across the whole report. */
  readonly minDistinctCitedFacts: number;
  /** Minimum number of sections that combine several kinds of fact. */
  readonly minSynthesisSections: number;
  /** How many distinct fact KINDS a section must cite to count as synthesis. */
  readonly minSynthesisFactKinds: number;
}

/**
 * One further rule lives in `report-model.ts` rather than as a number here,
 * because it has no threshold: two sections may not carry the SAME paragraph.
 * A single text reused under several themes satisfies every count above while
 * being precisely the generic output this gate exists to refuse.
 */

export const SPECIFICITY_POLICY: SpecificityPolicy = {
  minSections: 3,
  maxSections: 5,
  minDistinctCitedFacts: 4,
  minSynthesisSections: 1,
  minSynthesisFactKinds: 2,
};
