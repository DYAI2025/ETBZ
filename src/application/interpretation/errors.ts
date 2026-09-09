/**
 * ETBZ-25 — the fail-closed error vocabulary of the narrative chain.
 *
 * Every code below names a REFUSAL, never a repair. Nothing in this slice
 * substitutes, defaults, normalizes or downgrades a fact: when the chain cannot
 * be proven intact, no InterpretationFeatureSet / ThemeGraph / NarrativeBrief /
 * ReportModel exists at all.
 */

/** Codes raised while deriving structure FROM the HoroscopeModel. */
export type InterpretationErrorCode =
  /** A `provisional_fields` entry ETBZ cannot map to a pillar. Uncertainty is
   *  never silently dropped, so an unmapped field fails the whole derivation. */
  | 'FEATURE_SET_PROVISIONAL_FIELD_UNMAPPED'
  /** A method declared `evaluated` carries no source fact — the scope
   *  statement would be a claim without evidence. */
  | 'FEATURE_SET_METHOD_WITHOUT_SOURCE_FACTS'
  /** Two occurrences of the same FuFirE Ten God carry different source labels. */
  | 'THEME_LABEL_CONTRADICTION';

export class InterpretationError extends Error {
  readonly code: InterpretationErrorCode;
  constructor(code: InterpretationErrorCode, message: string) {
    super(message);
    this.name = 'InterpretationError';
    this.code = code;
  }
}

/** Codes raised while validating PROVIDER output against the brief and model. */
export type ReportErrorCode =
  /** The provider output does not satisfy the structural schema. */
  | 'REPORT_PROVIDER_SCHEMA_INVALID'
  /** The brief handed to the provider does not match the HoroscopeModel it
   *  claims to describe (re-derived here, never trusted). */
  | 'REPORT_BRIEF_NOT_DERIVED_FROM_MODEL'
  /** The provider answered a different brief than the one being validated. */
  | 'REPORT_BRIEF_HASH_MISMATCH'
  /** A section names a theme the brief does not contain. */
  | 'REPORT_UNKNOWN_THEME'
  /** Two sections claim the same theme; the report would state it twice. */
  | 'REPORT_DUPLICATE_THEME_SECTION'
  /** A cited fact id does not exist in the brief. */
  | 'REPORT_UNKNOWN_FACT'
  /** A cited fact exists but does not belong to the section's theme. */
  | 'REPORT_FACT_NOT_IN_THEME'
  /** A cited fact value differs from the HoroscopeModel value: the provider
   *  changed a chart fact. */
  | 'REPORT_FACT_MUTATED'
  /** A section carries interpretation with no fact basis at all. */
  | 'REPORT_UNGROUNDED_INTERPRETATION'
  /** Prose names a chart symbol the section did not cite. */
  | 'REPORT_UNCITED_SYMBOL'
  /** Prose states a number the section did not cite: an invented quantity. */
  | 'REPORT_UNCITED_NUMBER'
  /** Prose invokes a BaZi method this slice does not evaluate. */
  | 'REPORT_OUT_OF_METHOD_SCOPE'
  /** A section cites a provisional fact without stating the uncertainty. */
  | 'REPORT_PROVISIONAL_WITHOUT_NOTE'
  /** The report is generic: too few sections, facts, or no synthesis. */
  | 'REPORT_INSUFFICIENT_SPECIFICITY'
  /** Two sections carry the same paragraph: boilerplate wearing two hats. */
  | 'REPORT_DUPLICATE_PROSE';

export class ReportError extends Error {
  readonly code: ReportErrorCode;
  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}
