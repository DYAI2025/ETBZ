/**
 * ETBZ-25 — ReportModel: the sellable artefact, and the gate that produces it.
 *
 * Two jobs, deliberately in one place because they are one decision:
 *
 *  1. FACT INTEGRITY. Provider output is untrusted input. It is re-checked
 *     against the HoroscopeModel itself — not against the brief it was handed,
 *     because a tampered brief would then validate a tampered report. The chain
 *     is re-derived from the model here, and the provider's answer must belong
 *     to exactly that chain.
 *
 *  2. SEPARATION. The report keeps four blocks apart and never merges them:
 *       facts          — HoroscopeModel values, verbatim, with their source paths
 *       interpretation — provider prose, each section bound to cited facts
 *       uncertainty    — source-owned warnings/provisionality, plus, clearly
 *                        labelled and separate, the provider's own notes
 *       methodNotes    — what was evaluated and what was not, and why
 *
 * A SECTION IS A PRIMARY THEME. The candidate ThemeGraph stays complete in the
 * brief and a provider may read all of it, but a section that names a candidate
 * theme id is refused with its own code: the exhaustive structural index must
 * not leak into the sold artefact one chapter per node. The section count is
 * held between the policy's floor and ceiling for the same reason.
 *
 * Every failure below is a REFUSAL. Nothing is repaired, trimmed, re-labelled
 * or downgraded: a provider that changes a chart fact, invents a symbol, claims
 * a method this slice does not evaluate, drops a provisionality, narrates a raw
 * candidate theme or writes unbound generic paragraphs produces NO report.
 *
 * WHAT THIS GATE STILL CANNOT SEE, stated rather than implied. Two semantic
 * failure modes survive every check below and are deliberately OUT OF SCOPE for
 * this slice; both need a Narrative-QA gate that reasons about meaning:
 *
 *   1. ROLE. A cited symbol can still be given the wrong linguistic role in
 *      free prose — a section citing a stem and a branch can call the stem a
 *      branch, and every structural check here still passes.
 *   2. TONE OF CERTAINTY. A provider can attach a structurally correct
 *      uncertainty note while the prose beside it expresses certainty. The note
 *      is present, so the provisionality guard is satisfied; the sentence still
 *      overclaims.
 *
 * Nothing in this file should be read as proving the semantic truth of
 * arbitrary free prose. It proves attachment, not meaning.
 */

import { canonicalJson } from '../../domain/canonical-json.js';
import { structuralHashOfCanonicalText } from '../../domain/structural-hash.js';
import type { HoroscopeModel } from '../horoscope-model.js';
import { narrativeProviderOutputSchema } from '../ports/narrative-provider.js';
import type { NarrativeSectionDraft } from '../ports/narrative-provider.js';
import { findUncitedNumerals, findUncitedSymbols } from './chart-symbol-lexicon.js';
import { ReportError } from './errors.js';
import type { ChartFact } from './feature-set.js';
import { NOT_EVALUATED_METHODS } from './method-scope.js';
import type { MethodNote } from './method-scope.js';
import { buildNarrativeChain } from './narrative-brief.js';
import type { NarrativeBrief } from './narrative-brief.js';
import type { PrimaryTheme, PrimaryThemeFamily } from './primary-theme.js';
import type { SpecificityPolicy } from './specificity-policy.js';

export interface ReportSection {
  /** A PRIMARY theme id. A candidate ThemeGraph id here is refused. */
  readonly themeId: string;
  readonly themeFamily: PrimaryThemeFamily;
  /** The candidate themes this chapter groups, copied from the brief. */
  readonly sourceThemeIds: readonly string[];
  /** Their source-owned labels, in `sourceThemeIds` order. Never an ETBZ coinage. */
  readonly sourceThemeLabels: readonly string[];
  /** Sorted, de-duplicated fact ids this section is bound to. */
  readonly citedFactIds: readonly string[];
  readonly prose: string;
  readonly citesProvisionalFacts: boolean;
}

export interface ReportProviderNote {
  readonly themeId: string;
  /** Provider-authored text. NEVER source-owned evidence. */
  readonly notes: readonly string[];
}

export interface ReportUncertainty {
  readonly birthTimeKnown: boolean;
  readonly provisionalFields: Readonly<{ bazi: readonly string[]; natal: readonly string[] }>;
  readonly provisionalFactIds: readonly string[];
  /** FuFirE's warning codes, verbatim: source order, duplicates, unknown codes. */
  readonly sourceWarnings: readonly string[];
  readonly providerNotes: readonly ReportProviderNote[];
}

export interface ReportModel {
  readonly reportVersion: 'etbz-25.report-model.v1';
  readonly subject: Readonly<{ displayName: string; birth: HoroscopeModel['birth'] }>;
  readonly facts: Readonly<{
    chart: readonly ChartFact[];
    /** The HoroscopeModel's own canonical fact text, unchanged. */
    sourceCanonicalJson: string;
    sourceStructuralHash: string;
  }>;
  readonly interpretation: readonly ReportSection[];
  readonly uncertainty: ReportUncertainty;
  readonly methodNotes: readonly MethodNote[];
  readonly provenance: Readonly<{
    engineVersion: string;
    rulesetId: string;
    ephemerisId: string;
    tzdbVersionId: string;
    runtimeImage: string;
    openapiSha256: string;
    natalRulesetId: string;
    natalRulesetVersion: string;
    /** Volatile, preserved as evidence, excluded from the canonical text. */
    computationTimestamp: string;
    /** Volatile, preserved as evidence, excluded from the canonical text. */
    natalComputedAt: string;
    providerId: string;
    briefStructuralHash: string;
    featureSetStructuralHash: string;
    themeGraphStructuralHash: string;
    primaryThemeProjectionStructuralHash: string;
  }>;
  readonly canonicalJson: string;
  readonly structuralHash: string;
}

export interface BuildReportModelInput {
  readonly model: HoroscopeModel;
  /** The brief the provider was handed. Verified against `model`, never trusted. */
  readonly brief: NarrativeBrief;
  /** Raw provider output. Untrusted: schema-checked before anything reads it. */
  readonly providerOutput: unknown;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Method-scope vocabulary, matched case-insensitively over whitespace-collapsed
 * text. The collapse matters: the multi-word terms ("yong shen", "da yun") are
 * otherwise defeated by a non-breaking space or a line break between the words,
 * which is exactly the shape wrapped prose produces.
 */
function findOutOfScopeMethod(prose: string): { methodId: string; term: string } | null {
  const haystack = prose.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
  for (const method of NOT_EVALUATED_METHODS) {
    for (const term of method.vocabulary) {
      if (haystack.includes(term)) {
        return { methodId: method.methodId, term };
      }
    }
  }
  return null;
}

function assertSpecificity(
  sections: readonly ReportSection[],
  factKindsBySection: readonly (readonly string[])[],
  policy: SpecificityPolicy,
): void {
  if (sections.length < policy.minSections) {
    throw new ReportError(
      'REPORT_INSUFFICIENT_SPECIFICITY',
      `report carries ${String(sections.length)} sections, the policy floor is ${String(policy.minSections)}`,
    );
  }
  const distinctFacts = new Set(sections.flatMap((section) => section.citedFactIds)).size;
  if (distinctFacts < policy.minDistinctCitedFacts) {
    throw new ReportError(
      'REPORT_INSUFFICIENT_SPECIFICITY',
      `report cites ${String(distinctFacts)} distinct chart facts, the policy floor is ${String(policy.minDistinctCitedFacts)}; a report that cites fewer is not about this chart`,
    );
  }
  const paragraphs = sections.map((section) => section.prose.trim());
  const distinctParagraphs = new Set(paragraphs).size;
  if (distinctParagraphs < paragraphs.length) {
    throw new ReportError(
      'REPORT_DUPLICATE_PROSE',
      `report repeats the same paragraph in ${String(paragraphs.length - distinctParagraphs + 1)} sections; one text reused under several themes is boilerplate, not a reading of this chart`,
    );
  }
  const synthesisSections = factKindsBySection.filter(
    (kinds) => new Set(kinds).size >= policy.minSynthesisFactKinds,
  ).length;
  if (synthesisSections < policy.minSynthesisSections) {
    throw new ReportError(
      'REPORT_INSUFFICIENT_SPECIFICITY',
      `report carries ${String(synthesisSections)} sections combining at least ${String(policy.minSynthesisFactKinds)} kinds of fact, the policy floor is ${String(policy.minSynthesisSections)}`,
    );
  }
}

interface ValidatedSection {
  readonly section: ReportSection;
  readonly factKinds: readonly string[];
  readonly providerNote: ReportProviderNote | null;
}

function validateSection(
  draft: NarrativeSectionDraft,
  primaryThemesById: ReadonlyMap<string, PrimaryTheme>,
  candidateThemeIds: ReadonlySet<string>,
  factsById: ReadonlyMap<string, ChartFact>,
): ValidatedSection {
  const theme = primaryThemesById.get(draft.themeId);
  if (theme === undefined) {
    // A candidate id is a DIFFERENT mistake from an invented one, and saying so
    // is the difference between a provider fixing its output in one step and
    // guessing. The candidate theme exists, is in the brief, and is still not a
    // chapter.
    if (candidateThemeIds.has(draft.themeId)) {
      throw new ReportError(
        'REPORT_CANDIDATE_THEME_NOT_NARRATABLE',
        `section names candidate theme "${draft.themeId}"; candidate themes are structural nuance and only a primary theme may be a report section`,
      );
    }
    throw new ReportError(
      'REPORT_UNKNOWN_THEME',
      `section names theme "${draft.themeId}", which the brief does not contain`,
    );
  }
  if (draft.citedFacts.length === 0) {
    throw new ReportError(
      'REPORT_UNGROUNDED_INTERPRETATION',
      `section for theme "${theme.id}" cites no chart fact; interpretation without a fact basis is refused`,
    );
  }
  if (isBlank(draft.prose)) {
    throw new ReportError(
      'REPORT_UNGROUNDED_INTERPRETATION',
      `section for theme "${theme.id}" carries no prose; an empty section is not an interpretation`,
    );
  }

  const themeFactIds = new Set(theme.factIds);
  const covered = new Set<string>();
  const citedFactIds: string[] = [];
  const factKinds: string[] = [];
  let citesProvisional = false;

  for (const citation of draft.citedFacts) {
    const fact = factsById.get(citation.factId);
    if (fact === undefined) {
      throw new ReportError(
        'REPORT_UNKNOWN_FACT',
        `section for theme "${theme.id}" cites fact "${citation.factId}", which is not a fact of this chart`,
      );
    }
    if (!themeFactIds.has(fact.id)) {
      throw new ReportError(
        'REPORT_FACT_NOT_IN_THEME',
        `section for theme "${theme.id}" cites fact "${fact.id}", which belongs to a different theme`,
      );
    }
    if (citation.value !== fact.value) {
      throw new ReportError(
        'REPORT_FACT_MUTATED',
        `section for theme "${theme.id}" restates fact "${fact.id}" (${fact.path}) with a value the HoroscopeModel does not carry; a provider may not change a chart fact`,
      );
    }
    citedFactIds.push(fact.id);
    factKinds.push(fact.kind);
    covered.add(fact.value);
    if (fact.sourceLabel !== null) {
      covered.add(fact.sourceLabel);
    }
    if (fact.provisional) {
      citesProvisional = true;
    }
  }

  const notes = draft.uncertaintyNotes.filter((note) => !isBlank(note));

  // EVERY provider-authored text surface that reaches the report is checked,
  // not just `prose`. An uncertainty note is published next to the chart facts
  // in the sellable artefact, so a note is exactly as capable of asserting an
  // uncited symbol or an unevaluated method as a paragraph is. Checking only
  // the paragraph would leave an open channel beside a closed one.
  const surfaces: readonly (readonly [string, string])[] = [
    ['prose', draft.prose],
    ...notes.map((note, index): readonly [string, string] => [
      `uncertaintyNotes[${String(index)}]`,
      note,
    ]),
  ];
  for (const [where, text] of surfaces) {
    const outOfScope = findOutOfScopeMethod(text);
    if (outOfScope !== null) {
      throw new ReportError(
        'REPORT_OUT_OF_METHOD_SCOPE',
        `section for theme "${theme.id}" invokes "${outOfScope.term}" in ${where}; method "${outOfScope.methodId}" is not_evaluated in this slice (insufficient_method_scope)`,
      );
    }
    const uncited = findUncitedSymbols(text, covered);
    if (uncited.length > 0) {
      throw new ReportError(
        'REPORT_UNCITED_SYMBOL',
        `section for theme "${theme.id}" names chart symbols it did not cite in ${where}: ${uncited.join(', ')}`,
      );
    }
    const numbers = findUncitedNumerals(text, covered);
    if (numbers.length > 0) {
      throw new ReportError(
        'REPORT_UNCITED_NUMBER',
        `section for theme "${theme.id}" states numbers it did not cite in ${where}: ${numbers.join(', ')}; a quantity is a chart fact`,
      );
    }
  }
  if (citesProvisional && notes.length === 0) {
    throw new ReportError(
      'REPORT_PROVISIONAL_WITHOUT_NOTE',
      `section for theme "${theme.id}" cites a provisional fact but states no uncertainty; provisionality must survive into the report`,
    );
  }

  return {
    section: {
      themeId: theme.id,
      themeFamily: theme.family,
      sourceThemeIds: theme.sourceThemeIds,
      sourceThemeLabels: theme.sourceThemeLabels,
      citedFactIds: sortedUnique(citedFactIds),
      prose: draft.prose,
      citesProvisionalFacts: citesProvisional,
    },
    factKinds,
    providerNote: notes.length > 0 ? { themeId: theme.id, notes } : null,
  };
}

/**
 * Validates provider output against the HoroscopeModel and assembles the
 * ReportModel. Throws `ReportError` and returns nothing partial.
 */
export function buildReportModel(input: BuildReportModelInput): ReportModel {
  const { model, brief, providerOutput } = input;

  // The chain is RE-DERIVED from the model. The brief that was handed to the
  // provider is only ever compared against this one; it is never the authority.
  const rederived = buildNarrativeChain(model);
  if (brief.structuralHash !== rederived.brief.structuralHash) {
    throw new ReportError(
      'REPORT_BRIEF_NOT_DERIVED_FROM_MODEL',
      'the supplied brief is not the brief this HoroscopeModel produces; a report is never built on an unverified brief',
    );
  }
  const trusted = rederived.brief;

  const parsed = narrativeProviderOutputSchema.safeParse(providerOutput);
  if (!parsed.success) {
    // Path + code only for the SCHEMA failure: a shape violation says nothing
    // useful about the value, and the value is the part most likely to be
    // untrusted bulk. The semantic refusals below do name the offending fact
    // id, theme id or symbol, because there the identifier IS the finding and a
    // refusal nobody can act on is not much better than no refusal.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.code}`)
      .join('; ');
    throw new ReportError(
      'REPORT_PROVIDER_SCHEMA_INVALID',
      `provider output does not satisfy the narrative output schema (${issues})`,
    );
  }
  const output = parsed.data;

  if (output.briefStructuralHash !== trusted.structuralHash) {
    throw new ReportError(
      'REPORT_BRIEF_HASH_MISMATCH',
      'provider answered a different brief than the one being validated',
    );
  }

  // The compact-report ceiling is checked HERE, on the raw section count, and
  // deliberately before any per-section validation: an oversized report is a
  // product-contract violation in its own right. Reporting whichever duplicate
  // or unknown theme happened to come first would name a symptom of "too many
  // chapters" instead of the thing that is wrong.
  const { specificity } = trusted.constraints;
  if (output.sections.length > specificity.maxSections) {
    throw new ReportError(
      'REPORT_TOO_MANY_SECTIONS',
      `report carries ${String(output.sections.length)} sections, the policy ceiling is ${String(specificity.maxSections)}; a compact report does not publish one chapter per structural candidate`,
    );
  }

  const primaryThemesById = new Map<string, PrimaryTheme>(
    trusted.primaryThemes.map((theme) => [theme.id, theme]),
  );
  const candidateThemeIds = new Set<string>(trusted.constraints.candidateThemeIds);
  const factsById = new Map<string, ChartFact>(trusted.facts.map((fact) => [fact.id, fact]));

  const seenThemes = new Set<string>();
  const sections: ReportSection[] = [];
  const factKindsBySection: (readonly string[])[] = [];
  const providerNotes: ReportProviderNote[] = [];

  for (const draft of output.sections) {
    if (seenThemes.has(draft.themeId)) {
      throw new ReportError(
        'REPORT_DUPLICATE_THEME_SECTION',
        `theme "${draft.themeId}" is narrated twice; the report would state it as two independent findings`,
      );
    }
    const validated = validateSection(draft, primaryThemesById, candidateThemeIds, factsById);
    seenThemes.add(validated.section.themeId);
    sections.push(validated.section);
    factKindsBySection.push(validated.factKinds);
    if (validated.providerNote !== null) {
      providerNotes.push(validated.providerNote);
    }
  }

  assertSpecificity(sections, factKindsBySection, specificity);

  const report = {
    reportVersion: 'etbz-25.report-model.v1' as const,
    subject: { displayName: model.displayName, birth: model.birth },
    facts: {
      chart: trusted.facts,
      sourceCanonicalJson: model.canonicalJson,
      sourceStructuralHash: trusted.sourceStructuralHash,
    },
    interpretation: sections,
    uncertainty: {
      birthTimeKnown: trusted.uncertainty.birthTimeKnown,
      provisionalFields: trusted.uncertainty.provisionalFields,
      provisionalFactIds: trusted.uncertainty.provisionalFactIds,
      sourceWarnings: trusted.uncertainty.sourceWarnings,
      providerNotes,
    },
    methodNotes: trusted.methodScope,
    provenance: {
      engineVersion: model.provenance.engineVersion,
      rulesetId: model.provenance.rulesetId,
      ephemerisId: model.provenance.ephemerisId,
      tzdbVersionId: model.provenance.tzdbVersionId,
      runtimeImage: model.provenance.runtimeImage,
      openapiSha256: model.provenance.openapiSha256,
      natalRulesetId: model.natal.provenance.rulesetId,
      natalRulesetVersion: model.natal.provenance.rulesetVersion,
      computationTimestamp: model.provenance.computationTimestamp,
      natalComputedAt: model.natal.provenance.computedAt,
      providerId: output.providerId,
      briefStructuralHash: trusted.structuralHash,
      featureSetStructuralHash: trusted.featureSetStructuralHash,
      themeGraphStructuralHash: trusted.themeGraphStructuralHash,
      primaryThemeProjectionStructuralHash: trusted.primaryThemeProjectionStructuralHash,
    },
  };

  // The canonical text excludes the two VOLATILE source timestamps and nothing
  // else — the same two exclusions ETBZ-24/29 already justified from observed
  // FuFirE behaviour. Both remain on the model above as evidence. Every fact,
  // every section, every warning and every method note is inside the anchor, so
  // any relevant mutation changes the hash. The primary-projection hash is in
  // there too: a change to which candidate themes a chapter groups, or to the
  // facts it unions, moves the report's identity.
  const canonical = canonicalJson({
    reportVersion: report.reportVersion,
    subject: report.subject,
    facts: report.facts,
    interpretation: report.interpretation,
    uncertainty: report.uncertainty,
    methodNotes: report.methodNotes,
    provenance: {
      engineVersion: report.provenance.engineVersion,
      rulesetId: report.provenance.rulesetId,
      ephemerisId: report.provenance.ephemerisId,
      tzdbVersionId: report.provenance.tzdbVersionId,
      runtimeImage: report.provenance.runtimeImage,
      openapiSha256: report.provenance.openapiSha256,
      natalRulesetId: report.provenance.natalRulesetId,
      natalRulesetVersion: report.provenance.natalRulesetVersion,
      providerId: report.provenance.providerId,
      briefStructuralHash: report.provenance.briefStructuralHash,
      featureSetStructuralHash: report.provenance.featureSetStructuralHash,
      themeGraphStructuralHash: report.provenance.themeGraphStructuralHash,
      primaryThemeProjectionStructuralHash:
        report.provenance.primaryThemeProjectionStructuralHash,
    },
  });

  // Hash the canonical TEXT, not a re-canonicalization of it: the published
  // hash must be reproducible as a plain sha256 of the published canonicalJson.
  return {
    ...report,
    canonicalJson: canonical,
    structuralHash: structuralHashOfCanonicalText(canonical),
  };
}
