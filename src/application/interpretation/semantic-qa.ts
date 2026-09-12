/**
 * ETBZ-25B — semantic Narrative QA: the gate ETBZ-25A said it could not be.
 *
 * `report-model.ts` proves ATTACHMENT — every section is bound to cited facts of
 * this chart, no symbol is uncited, no number is invented, no unevaluated method
 * is invoked, no provisionality is dropped. It also names, in its own docblock,
 * the two semantic failures that survive all of that:
 *
 *   1. ROLE — a cited symbol can be given the wrong linguistic role;
 *   2. TONE OF CERTAINTY — a structurally correct uncertainty note can sit
 *      beside a sentence that expresses certainty anyway.
 *
 * This module closes those two and adds the three PRODUCT gates the Product
 * Owner requires before a reading may be shown to a human for a sellability
 * judgement: Specificity / Anti-Barnum, Synthesis Depth and Product Safety.
 *
 * FIVE PROPERTIES OF THIS GATE, chosen deliberately:
 *
 *  - It is DETERMINISTIC. Every judgement is a lookup in the closed vocabularies
 *    of `semantic-qa-lexicon.ts`. Nothing here asks a language model to grade a
 *    language model; that would place the product's last semantic guarantee
 *    behind the same non-determinism it exists to contain.
 *  - It is PURE. Same ReportModel in, byte-identical result out, including its
 *    structural hash. It reads no clock, no environment and no network.
 *  - It reads the REPORT, not the provider's draft. By the time a ReportModel
 *    exists the structural gate has already re-derived the chain from the
 *    HoroscopeModel, so the facts this module reasons over are the chart's own.
 *  - It REFUSES, it never repairs. No sentence is rewritten, softened, trimmed
 *    or re-labelled. A blocked candidate produces findings and no reading.
 *  - It reports EVERY finding, not the first. A human fixing a prompt needs the
 *    whole picture; stopping at the first refusal would hide the rest.
 *
 * A semantic failure here is NEVER a reason to call a different provider. The
 * failure is in the answer, and shopping for a more convenient answer is the
 * precise behaviour this gate exists to prevent.
 *
 * WHAT IT STILL CANNOT DO. It matches vocabulary, so it catches the forms of
 * claim it lists and not the infinite paraphrase around them, and it cannot
 * decide whether a sentence is TRUE about a person. That is why the slice ends
 * at a human `SELLABLE | NOT_SELLABLE` review: these gates raise the floor
 * mechanically; they do not certify the ceiling.
 */

import { structuralHash } from '../../domain/structural-hash.js';
import { containsTerm, findTermSpans, normalizeForMatch } from './chart-symbol-lexicon.js';
import { NarrativeQaError } from './errors.js';
import type { NarrativeQaErrorCode } from './errors.js';
import type { ChartFact } from './feature-set.js';
import { NARRATIVE_QA_POLICY } from './narrative-qa-policy.js';
import type { NarrativeQaPolicy } from './narrative-qa-policy.js';
import type { ReportModel, ReportSection } from './report-model.js';
import {
  BARNUM_PHRASES,
  CERTAINTY_TERMS,
  PROHIBITED_CLAIM_CLASSES,
  PROVISIONALITY_TERMS,
  ROLES_BY_FACT_KIND,
  ROLE_TERMS,
  SYNTHESIS_CONNECTIVES,
} from './semantic-qa-lexicon.js';
import type { ChartFactRole } from './semantic-qa-lexicon.js';

export type NarrativeQaGate =
  | 'fact_role'
  | 'provisionality'
  | 'specificity'
  | 'synthesis_depth'
  | 'product_safety';

/** The five gates, in the order they run. All of them always run. */
export const NARRATIVE_QA_GATES: readonly NarrativeQaGate[] = [
  'fact_role',
  'provisionality',
  'specificity',
  'synthesis_depth',
  'product_safety',
] as const;

/**
 * One inspectable finding.
 *
 * Every field that can be filled is filled: the Product Owner contract requires
 * findings carrying "the relevant section/span/theme/fact references where
 * applicable", because a refusal nobody can locate is barely better than no
 * refusal. `span` indexes the NORMALIZED surface text, which is the text the
 * match was made against — reporting an index into the raw text would point at
 * a different character whenever normalization changed the length.
 */
export interface NarrativeQaFinding {
  readonly gate: NarrativeQaGate;
  readonly code: NarrativeQaErrorCode;
  /** Every finding blocks. There is no advisory tier in this slice. */
  readonly severity: 'blocking';
  /** The report section, or null for a report-wide finding. */
  readonly themeId: string | null;
  /** `prose`, `uncertaintyNotes[i]`, or null for a report-wide finding. */
  readonly surface: string | null;
  /** The chart fact the finding is about, when it is about one. */
  readonly factId: string | null;
  /** The lexicon term that triggered it, normalized. */
  readonly term: string | null;
  readonly span: Readonly<{ start: number; end: number }> | null;
  readonly message: string;
}

/**
 * The policy the gates judge against, re-exported from its own module.
 *
 * It lives in `narrative-qa-policy.ts` because `prompt-policy.ts` has to
 * ANNOUNCE these same numbers, and a floor that is judged here but stated
 * separately over there drifts — it already did once, with R7 asking for one
 * chart term per paragraph while this gate blocked anything under two. Both
 * modules now read one constant, and neither imports the other.
 *
 * Re-exported rather than moved outright so every established import path
 * (`semantic-qa.js`) keeps resolving.
 */
export type { NarrativeQaPolicy } from './narrative-qa-policy.js';
export { NARRATIVE_QA_POLICY } from './narrative-qa-policy.js';

export const NARRATIVE_QA_VERSION = 'etbz-25b.narrative-qa.v1' as const;

export interface NarrativeQaResult {
  readonly qaVersion: typeof NARRATIVE_QA_VERSION;
  /** Binds the verdict to one exact report. */
  readonly reportStructuralHash: string;
  readonly briefStructuralHash: string;
  readonly status: 'PASS' | 'BLOCKED';
  /** Every gate that executed. A gate missing from this list did not run. */
  readonly gatesRun: readonly NarrativeQaGate[];
  readonly policy: NarrativeQaPolicy;
  readonly findings: readonly NarrativeQaFinding[];
  readonly structuralHash: string;
}

/** One provider-authored text surface of a section, with its label. */
interface Surface {
  readonly label: string;
  readonly normalized: string;
}

/**
 * A chart term the report may name, and the roles it may be given.
 *
 * Keyed by the NORMALIZED term because that is what matching compares. One term
 * can map to several facts (the day stem and the day master carry the same
 * value) and therefore to the union of their roles — which is correct, not
 * permissive: the symbol genuinely is both.
 */
interface ChartTerm {
  readonly term: string;
  readonly factIds: readonly string[];
  readonly roles: ReadonlySet<ChartFactRole>;
}

function surfacesOf(section: ReportSection, notes: readonly string[]): readonly Surface[] {
  return [
    { label: 'prose', normalized: normalizeForMatch(section.prose) },
    ...notes.map((note, index) => ({
      label: `uncertaintyNotes[${String(index)}]`,
      normalized: normalizeForMatch(note),
    })),
  ];
}

/**
 * The chart terms a section is allowed to name, built from the facts it cited.
 *
 * Both the fact VALUE and the source's own LABEL are terms: `report-model.ts`
 * already treats them as interchangeably citable, and a QA gate that recognised
 * only one of them would flag legitimate prose that used the other.
 */
function chartTermsOf(
  section: ReportSection,
  factsById: ReadonlyMap<string, ChartFact>,
): readonly ChartTerm[] {
  const byTerm = new Map<string, { factIds: string[]; roles: Set<ChartFactRole> }>();
  for (const factId of section.citedFactIds) {
    const fact = factsById.get(factId);
    if (fact === undefined) {
      // Unreachable for a real ReportModel: `buildReportModel` only emits cited
      // ids it resolved against the re-derived chain. Kept as a programming
      // guard so a future refactor cannot silently narrow the term set.
      continue;
    }
    const roles = ROLES_BY_FACT_KIND[fact.kind];
    for (const raw of [fact.value, fact.sourceLabel]) {
      if (raw === null) {
        continue;
      }
      const term = normalizeForMatch(raw);
      if (term.length === 0) {
        continue;
      }
      const entry = byTerm.get(term);
      if (entry === undefined) {
        byTerm.set(term, { factIds: [fact.id], roles: new Set(roles) });
      } else {
        entry.factIds.push(fact.id);
        for (const role of roles) {
          entry.roles.add(role);
        }
      }
    }
  }
  return [...byTerm.entries()]
    .map(([term, entry]) => ({
      term,
      factIds: [...new Set(entry.factIds)].sort(),
      roles: entry.roles,
    }))
    .sort((left, right) => (left.term < right.term ? -1 : left.term > right.term ? 1 : 0));
}

/** One role word found in a window, with where it sat. */
interface RoleMention {
  readonly role: ChartFactRole;
  readonly term: string;
  readonly start: number;
}

/** Every role mention inside `window`, in document order. */
function roleMentionsIn(window: string): RoleMention[] {
  const mentions: RoleMention[] = [];
  for (const [role, terms] of Object.entries(ROLE_TERMS) as readonly [
    ChartFactRole,
    readonly string[],
  ][]) {
    for (const term of terms) {
      for (const span of findTermSpans(window, term)) {
        mentions.push({ role, term, start: span.start });
      }
    }
  }
  return mentions.sort((left, right) => left.start - right.start);
}

/**
 * The role word that is actually CLASSIFYING this symbol.
 *
 * German puts the classifier immediately before the symbol — "der Erdzweig
 * Hai", "das Element Metall" — so the NEAREST PRECEDING role word is the one
 * making the claim. Falling back to the nearest following one covers the
 * apposition ("Hai, der Erdzweig"), which is rarer but is still a
 * classification.
 *
 * Taking the nearest rather than "any compatible role anywhere in the window"
 * is what closes the swap. Under the older rule a sentence naming two symbols
 * with their roles EXCHANGED — "der Erdzweig Xin und der Himmelsstamm Hai" —
 * passed: each symbol found a compatible role word somewhere in its window,
 * because the other symbol's correct role word was sitting right there. Both
 * statements were wrong and the gate saw two right ones.
 */
function classifyingRole(before: string, after: string): RoleMention | null {
  const preceding = roleMentionsIn(before);
  const nearestBefore = preceding[preceding.length - 1];
  if (nearestBefore !== undefined) {
    return nearestBefore;
  }
  return roleMentionsIn(after)[0] ?? null;
}

/**
 * GATE 1 — fact-role integrity.
 *
 * For every chart term the section names, the role words standing next to it
 * must be roles that term's facts actually carry. `der Erdzweig Xin` is refused
 * because `Xin` is a stem in this chart and nothing cited makes it a branch;
 * `der Himmelsstamm Xin` and `der Tagesmeister Xin` both pass, because the day
 * master genuinely is both.
 *
 * The check is CONSERVATIVE in the safe direction: when a window names no role
 * at all, nothing is flagged. A sentence that mentions a symbol without
 * classifying it has not misclassified it.
 */
function runFactRoleGate(
  section: ReportSection,
  surfaces: readonly Surface[],
  terms: readonly ChartTerm[],
  policy: NarrativeQaPolicy,
): NarrativeQaFinding[] {
  const findings: NarrativeQaFinding[] = [];
  for (const surface of surfaces) {
    for (const term of terms) {
      for (const span of findTermSpans(surface.normalized, term.term)) {
        const before = surface.normalized.slice(
          Math.max(0, span.start - policy.roleWindowChars),
          span.start,
        );
        const after = surface.normalized.slice(
          span.end,
          Math.min(surface.normalized.length, span.end + policy.roleWindowChars),
        );
        const classifier = classifyingRole(before, after);
        // No role word beside the symbol: the sentence named it without
        // classifying it, and an unclassified mention cannot be a
        // misclassification. Conservative on purpose.
        if (classifier === null) {
          continue;
        }
        if (term.roles.has(classifier.role)) {
          continue;
        }
        findings.push({
          gate: 'fact_role',
          code: 'QA_FACT_ROLE_MISMATCH',
          severity: 'blocking',
          themeId: section.themeId,
          surface: surface.label,
          factId: term.factIds[0] ?? null,
          term: term.term,
          span,
          message: `section "${section.themeId}" calls "${term.term}" a "${classifier.term}" (${classifier.role}) in ${surface.label}; the facts it cites give that symbol the role(s) ${[...term.roles].sort().join('/')}`,
        });
      }
    }
  }
  return findings;
}

/**
 * GATE 2 — provisionality semantics.
 *
 * Two distinct failures, deliberately separated because they need different
 * fixes. Prose that asserts certainty over a provisional fact is a claim the
 * chart does not support. A note that carries no word of uncertainty satisfies
 * `REPORT_PROVISIONAL_WITHOUT_NOTE` structurally while telling the reader
 * nothing — the note is present and empty of its own purpose.
 */
function runProvisionalityGate(
  section: ReportSection,
  surfaces: readonly Surface[],
  notes: readonly string[],
): NarrativeQaFinding[] {
  if (!section.citesProvisionalFacts) {
    return [];
  }
  const findings: NarrativeQaFinding[] = [];
  // EVERY provider-authored surface, not only `prose`. Checking the paragraph
  // and skipping the note would leave the certainty check out of exactly the
  // one surface whose entire job is to state an uncertainty — a note reading
  // "die Stundenangabe ist unbekannt, aber diese Deutung gilt zweifellos"
  // satisfied the structural guard and every semantic check while saying the
  // opposite of what it is for. The other three gates already loop over
  // `surfaces` for the same reason.
  for (const surface of surfaces) {
    for (const certainty of CERTAINTY_TERMS) {
      const [span] = findTermSpans(surface.normalized, certainty);
      if (span !== undefined) {
        findings.push({
          gate: 'provisionality',
          code: 'QA_PROVISIONAL_CERTAINTY',
          severity: 'blocking',
          themeId: section.themeId,
          surface: surface.label,
          factId: null,
          term: certainty,
          span,
          message: `section "${section.themeId}" rests on a provisional fact and asserts certainty with "${certainty}" in ${surface.label}; provisionality must survive into the sentence, not only into the note`,
        });
      }
    }
  }
  const notesStateUncertainty = notes.some((note) => {
    const normalized = normalizeForMatch(note);
    return PROVISIONALITY_TERMS.some((term) => containsTerm(normalized, term));
  });
  if (!notesStateUncertainty) {
    findings.push({
      gate: 'provisionality',
      code: 'QA_PROVISIONAL_NOTE_WITHOUT_UNCERTAINTY',
      severity: 'blocking',
      themeId: section.themeId,
      surface: notes.length > 0 ? 'uncertaintyNotes[0]' : null,
      factId: null,
      term: null,
      span: null,
      message: `section "${section.themeId}" cites a provisional fact and its uncertainty note states no uncertainty; a note that names no unknown is decorative`,
    });
  }
  return findings;
}

/**
 * GATE 3 — specificity / anti-Barnum.
 *
 * The structural policy counts CITED facts. This gate asks the harder question:
 * does the text itself depend on this chart? A generic paragraph can cite four
 * facts perfectly and name none of them, and it would then read identically for
 * every customer — which is the commercial failure this product cannot ship.
 *
 * Two checks, plus the canonical Barnum phrases. The per-section check catches
 * one unbound chapter; the report-wide check catches a reading that anchors one
 * chapter and pads the rest.
 */
function runSpecificityGate(
  section: ReportSection,
  surfaces: readonly Surface[],
  terms: readonly ChartTerm[],
  policy: NarrativeQaPolicy,
): NarrativeQaFinding[] {
  const findings: NarrativeQaFinding[] = [];
  const prose = surfaces.find((surface) => surface.label === 'prose');
  if (prose !== undefined) {
    const named = terms.filter((term) => containsTerm(prose.normalized, term.term)).length;
    if (named < policy.minChartTermsPerSection) {
      findings.push({
        gate: 'specificity',
        code: 'QA_UNANCHORED_PROSE',
        severity: 'blocking',
        themeId: section.themeId,
        surface: 'prose',
        factId: null,
        term: null,
        span: null,
        message: `section "${section.themeId}" names ${String(named)} of the chart facts it cites, the policy floor is ${String(policy.minChartTermsPerSection)}; a chapter resting on fewer is a template with one value dropped into it`,
      });
    }
  }
  for (const surface of surfaces) {
    for (const phrase of BARNUM_PHRASES) {
      const [span] = findTermSpans(surface.normalized, phrase);
      if (span !== undefined) {
        findings.push({
          gate: 'specificity',
          code: 'QA_BARNUM_PHRASE',
          severity: 'blocking',
          themeId: section.themeId,
          surface: surface.label,
          factId: null,
          term: phrase,
          span,
          message: `section "${section.themeId}" uses the generic statement "${phrase}" in ${surface.label}; a sentence true of nearly everyone is about no one`,
        });
      }
    }
  }
  return findings;
}

/** True when this section's prose relates several chart signals to each other. */
function isSynthesisSection(
  surfaces: readonly Surface[],
  terms: readonly ChartTerm[],
  policy: NarrativeQaPolicy,
): boolean {
  const prose = surfaces.find((surface) => surface.label === 'prose');
  if (prose === undefined) {
    return false;
  }
  const roles = new Set<ChartFactRole>();
  for (const term of terms) {
    if (containsTerm(prose.normalized, term.term)) {
      for (const role of term.roles) {
        roles.add(role);
      }
    }
  }
  if (roles.size < policy.minSynthesisRolesInProse) {
    return false;
  }
  return SYNTHESIS_CONNECTIVES.some((connective) => containsTerm(prose.normalized, connective));
}

/**
 * GATE 5 — product safety.
 *
 * Checked over EVERY provider-authored surface, prose and notes alike, for the
 * reason `report-model.ts` gives for its own surface loop: a note is published
 * beside the chart facts in the sold artefact and is exactly as capable of
 * carrying a prohibited claim as a paragraph is.
 */
function runProductSafetyGate(
  section: ReportSection,
  surfaces: readonly Surface[],
): NarrativeQaFinding[] {
  const findings: NarrativeQaFinding[] = [];
  for (const surface of surfaces) {
    for (const claimClass of PROHIBITED_CLAIM_CLASSES) {
      for (const term of claimClass.terms) {
        const [span] = findTermSpans(surface.normalized, term);
        if (span !== undefined) {
          findings.push({
            gate: 'product_safety',
            code: 'QA_PROHIBITED_CLAIM',
            severity: 'blocking',
            themeId: section.themeId,
            surface: surface.label,
            factId: null,
            term,
            span,
            message: `section "${section.themeId}" carries a ${claimClass.classId} claim ("${term}") in ${surface.label}. ${claimClass.statement}`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Runs every gate over a ReportModel and returns the structured verdict.
 *
 * Pure and total: it never throws for a bad reading, it REPORTS one.
 * `assertSemanticNarrativeQa` is the fail-closed wrapper for callers that want
 * the refusal as an exception.
 */
export function runSemanticNarrativeQa(
  report: ReportModel,
  policy: NarrativeQaPolicy = NARRATIVE_QA_POLICY,
): NarrativeQaResult {
  const factsById = new Map<string, ChartFact>(report.facts.chart.map((fact) => [fact.id, fact]));
  const notesByTheme = new Map<string, readonly string[]>(
    report.uncertainty.providerNotes.map((note) => [note.themeId, note.notes]),
  );

  const findings: NarrativeQaFinding[] = [];
  const chartTermsInProse = new Set<string>();
  let synthesisSections = 0;

  for (const section of report.interpretation) {
    const notes = notesByTheme.get(section.themeId) ?? [];
    const surfaces = surfacesOf(section, notes);
    const terms = chartTermsOf(section, factsById);

    findings.push(...runFactRoleGate(section, surfaces, terms, policy));
    findings.push(...runProvisionalityGate(section, surfaces, notes));
    findings.push(...runSpecificityGate(section, surfaces, terms, policy));
    findings.push(...runProductSafetyGate(section, surfaces));

    const prose = surfaces.find((surface) => surface.label === 'prose');
    if (prose !== undefined) {
      for (const term of terms) {
        if (containsTerm(prose.normalized, term.term)) {
          chartTermsInProse.add(term.term);
        }
      }
    }
    if (isSynthesisSection(surfaces, terms, policy)) {
      synthesisSections += 1;
    }
  }

  // GATE 3, report-wide half. A reading that anchors one chapter and pads the
  // rest passes every per-section check and is still generic overall.
  if (chartTermsInProse.size < policy.minDistinctChartTermsInProse) {
    findings.push({
      gate: 'specificity',
      code: 'QA_INSUFFICIENT_CHART_DEPENDENCE',
      severity: 'blocking',
      themeId: null,
      surface: null,
      factId: null,
      term: null,
      span: null,
      message: `the reading names ${String(chartTermsInProse.size)} distinct chart terms in its prose, the policy floor is ${String(policy.minDistinctChartTermsInProse)}; a reading that names fewer is not materially about this chart`,
    });
  }

  // GATE 4 — synthesis depth. Report-wide by nature: the contract asks that the
  // READING connects signals, not that every chapter does.
  if (synthesisSections < policy.minSynthesisSections) {
    findings.push({
      gate: 'synthesis_depth',
      code: 'QA_SYNTHESIS_INSUFFICIENT',
      severity: 'blocking',
      themeId: null,
      surface: null,
      factId: null,
      term: null,
      span: null,
      message: `the reading carries ${String(synthesisSections)} section(s) that name at least ${String(policy.minSynthesisRolesInProse)} distinct fact roles and relate them with a connective, the policy floor is ${String(policy.minSynthesisSections)}; lookup paragraphs are not a reading`,
    });
  }

  const core = {
    qaVersion: NARRATIVE_QA_VERSION,
    reportStructuralHash: report.structuralHash,
    briefStructuralHash: report.provenance.briefStructuralHash,
    status: findings.length === 0 ? ('PASS' as const) : ('BLOCKED' as const),
    gatesRun: NARRATIVE_QA_GATES,
    policy,
    findings,
  };
  return { ...core, structuralHash: structuralHash(core) };
}

/**
 * Fail-closed wrapper: returns the result on PASS, throws on BLOCKED.
 *
 * The whole finding list travels on the error, because a human fixing a prompt
 * needs every refusal at once and not one per run.
 */
export function assertSemanticNarrativeQa(
  report: ReportModel,
  policy: NarrativeQaPolicy = NARRATIVE_QA_POLICY,
): NarrativeQaResult {
  const result = runSemanticNarrativeQa(report, policy);
  if (result.status === 'BLOCKED') {
    throw new NarrativeQaError(result.findings);
  }
  return result;
}
