/**
 * ETBZ-25B — the narrative QA POLICY, extracted so the prompt and the gate
 * cannot state different numbers.
 *
 * WHY THIS IS ITS OWN MODULE. The thresholds below are judged by
 * `semantic-qa.ts` and must be ANNOUNCED by `prompt-policy.ts`: a floor a
 * provider is refused against but never told about is a trap, which the prompt
 * module's own docblock forbids. That gives two readers for one value, and the
 * only way to keep them from drifting apart is to let both read the SAME
 * constant.
 *
 * The obvious alternative — the prompt importing `semantic-qa.ts` — would work
 * today (there is no cycle) and would be wrong tomorrow: it makes the prompt
 * builder depend on the gate IMPLEMENTATION, including `report-model.ts` and
 * the error types, for the sake of five numbers. The correct dependency is that
 * both the prompt and the gate depend on the POLICY, and neither on the other.
 *
 * This module therefore holds data and nothing else. It imports nothing, which
 * is what makes it safe for both sides to import.
 *
 * `semantic-qa.ts` re-exports both names, so `NARRATIVE_QA_POLICY` keeps its
 * established import path and this extraction moved no caller.
 */

export interface NarrativeQaPolicy {
  /**
   * How far around a chart term the role check looks.
   *
   * A role word further away than this is not describing that symbol, it is
   * describing something else in the sentence. Widening the window would turn
   * ordinary German prose into a stream of false refusals; narrowing it would
   * miss `der Erdzweig Xin`.
   */
  readonly roleWindowChars: number;
  /**
   * Distinct chart terms that must actually APPEAR IN THE PROSE across the
   * whole report.
   *
   * The structural gate already requires distinct CITED facts. This is the
   * different and harder property: a reading can cite four facts and never name
   * one of them, which is exactly what a generic text does.
   */
  readonly minDistinctChartTermsInProse: number;
  /**
   * Distinct chart terms EACH section's prose must name.
   *
   * One is not enough, and the reason is a specific attack: a reading can be
   * built by writing ONE universal paragraph and mail-merging a different chart
   * symbol into each copy. Every section then names a cited term, every section
   * differs textually so the duplicate-prose guard is silent, and the whole
   * report is a template. Requiring two terms per chapter means a section has to
   * be about a combination, which a mail-merge cannot fake with one slot.
   */
  readonly minChartTermsPerSection: number;
  /** Sections that must qualify as synthesis rather than lookup. */
  readonly minSynthesisSections: number;
  /** Distinct fact ROLES a section's prose must name to count as synthesis. */
  readonly minSynthesisRolesInProse: number;
}

/**
 * The thresholds are a FLOOR a generic text fails, not a target good text has
 * to strain for — the same stance `specificity-policy.ts` takes structurally.
 *
 * Every number here is BLOCKING. Changing one changes what the gate refuses AND
 * what the prompt announces, in the same edit, because both read this object.
 */
export const NARRATIVE_QA_POLICY: NarrativeQaPolicy = {
  roleWindowChars: 32,
  minDistinctChartTermsInProse: 4,
  minChartTermsPerSection: 2,
  minSynthesisSections: 1,
  minSynthesisRolesInProse: 2,
};
