/**
 * ETBZ-25 — NarrativeBrief: the ONLY thing a narrative provider ever sees.
 *
 * The brief is the contract boundary of the creative step. It carries the
 * chart's facts, the structural themes over those facts, the source-owned
 * uncertainty and the method scope — and it carries them as CLOSED sets. The
 * provider cannot reach past it: it never receives the HoroscopeModel, never
 * receives the model's canonical text, and therefore has no channel through
 * which an unlisted chart value could enter a report.
 *
 * The brief states the themes at TWO levels, and keeps them apart on purpose:
 *
 *   primaryThemes    the four v1 grouping families. These, and only these, may
 *                    become customer-facing sections.
 *   candidateThemes  the complete structural ThemeGraph, plus its edges. Every
 *                    candidate node is preserved and reachable as nuance — a
 *                    provider may read them freely — but naming one as a report
 *                    section is refused in `report-model.ts`.
 *
 * Nothing is dropped between the two levels: every candidate theme belongs to
 * exactly one primary family, and the primary themes' fact union is the union
 * of the candidates'. The split is about what a chapter may be, never about
 * which parts of the chart count.
 *
 * `constraints` states the obligations the provider's answer will be held to.
 * Nothing here is advisory: every field is re-checked in `report-model.ts`
 * against the HoroscopeModel itself, so a provider that ignores the brief
 * produces no report at all.
 *
 * Uncertainty is carried forward whole. `sourceWarnings` is FuFirE's array
 * verbatim — source order, duplicates and unknown codes included — because it
 * is evidence, not a message. Nothing in this slice filters, renames,
 * deduplicates or reclassifies a warning.
 */

import { structuralHash } from '../../domain/structural-hash.js';
import type { HoroscopeModel } from '../horoscope-model.js';
import { deriveInterpretationFeatureSet } from './feature-set.js';
import type { ChartFact, InterpretationFeatureSet } from './feature-set.js';
import type { MethodNote } from './method-scope.js';
import { NOT_EVALUATED_METHOD_IDS } from './method-scope.js';
import { buildPrimaryThemeProjection } from './primary-theme.js';
import type { PrimaryTheme, PrimaryThemeProjection } from './primary-theme.js';
import { SPECIFICITY_POLICY } from './specificity-policy.js';
import type { SpecificityPolicy } from './specificity-policy.js';
import { buildThemeGraph } from './theme-graph.js';
import type { Theme, ThemeEdge, ThemeGraph } from './theme-graph.js';

export interface NarrativeBriefConstraints {
  /** The only fact ids a section may cite. */
  readonly allowedFactIds: readonly string[];
  /**
   * The only theme ids a section may claim: the PRIMARY themes.
   *
   * A report chapter is a primary theme or it is refused. This is what keeps
   * the sold artefact compact while the candidate graph stays complete.
   */
  readonly narratableThemeIds: readonly string[];
  /**
   * The candidate ThemeGraph ids. Available to READ as structural nuance and
   * explicitly NOT narratable: a section naming one of these is refused.
   */
  readonly candidateThemeIds: readonly string[];
  /** Methods whose vocabulary must not appear in prose (`not_evaluated`). */
  readonly forbiddenMethodIds: readonly string[];
  /** Every section must cite at least one fact; stated so it is not implicit. */
  readonly citationRequired: true;
  /** Every section citing a provisional fact must state that uncertainty. */
  readonly provisionalCitationRequiresNote: true;
  /**
   * Every number written in prose or in a note must be a cited fact value.
   * Stated here so a provider is told the rule rather than discovering it as a
   * refusal - including that decorative counting is not allowed.
   */
  readonly numeralsMustBeCited: true;
  readonly specificity: SpecificityPolicy;
}

export interface NarrativeBrief {
  readonly briefVersion: 'etbz-25.narrative-brief.v1';
  /** Hash of the HoroscopeModel's canonical fact text (the chain's anchor). */
  readonly sourceStructuralHash: string;
  readonly featureSetStructuralHash: string;
  readonly themeGraphStructuralHash: string;
  readonly primaryThemeProjectionStructuralHash: string;
  readonly subject: Readonly<{ displayName: string; birthTimeKnown: boolean }>;
  readonly facts: readonly ChartFact[];
  /** The narratable layer: exactly the v1 primary families of this chart. */
  readonly primaryThemes: readonly PrimaryTheme[];
  /** The complete structural candidate graph. Nuance, never a chapter. */
  readonly candidateThemes: readonly Theme[];
  readonly candidateEdges: readonly ThemeEdge[];
  readonly uncertainty: Readonly<{
    birthTimeKnown: boolean;
    provisionalFields: Readonly<{ bazi: readonly string[]; natal: readonly string[] }>;
    provisionalFactIds: readonly string[];
    /** FuFirE's warning codes, verbatim. Evidence, never a rendered message. */
    sourceWarnings: readonly string[];
  }>;
  readonly methodScope: readonly MethodNote[];
  readonly constraints: NarrativeBriefConstraints;
  readonly structuralHash: string;
}

/** The four derived artefacts of one chart, produced together and in order. */
export interface NarrativeChain {
  readonly featureSet: InterpretationFeatureSet;
  readonly themeGraph: ThemeGraph;
  readonly primaryThemeProjection: PrimaryThemeProjection;
  readonly brief: NarrativeBrief;
}

export function buildNarrativeBrief(
  featureSet: InterpretationFeatureSet,
  themeGraph: ThemeGraph,
  primaryThemeProjection: PrimaryThemeProjection,
  subject: Readonly<{ displayName: string }>,
): NarrativeBrief {
  const core = {
    briefVersion: 'etbz-25.narrative-brief.v1' as const,
    sourceStructuralHash: featureSet.sourceStructuralHash,
    featureSetStructuralHash: featureSet.structuralHash,
    themeGraphStructuralHash: themeGraph.structuralHash,
    primaryThemeProjectionStructuralHash: primaryThemeProjection.structuralHash,
    subject: {
      displayName: subject.displayName,
      birthTimeKnown: featureSet.birthTimeKnown,
    },
    facts: featureSet.facts,
    primaryThemes: primaryThemeProjection.primaryThemes,
    candidateThemes: themeGraph.themes,
    candidateEdges: themeGraph.edges,
    uncertainty: {
      birthTimeKnown: featureSet.birthTimeKnown,
      provisionalFields: featureSet.provisionalFields,
      provisionalFactIds: featureSet.provisionalFactIds,
      sourceWarnings: featureSet.sourceWarnings,
    },
    methodScope: featureSet.methodScope,
    constraints: {
      allowedFactIds: featureSet.factIds,
      narratableThemeIds: primaryThemeProjection.primaryThemes.map((theme) => theme.id),
      candidateThemeIds: themeGraph.themes.map((theme) => theme.id),
      forbiddenMethodIds: NOT_EVALUATED_METHOD_IDS,
      citationRequired: true as const,
      provisionalCitationRequiresNote: true as const,
      numeralsMustBeCited: true as const,
      specificity: SPECIFICITY_POLICY,
    },
  };

  return { ...core, structuralHash: structuralHash(core) };
}

/**
 * The whole free, deterministic half of ETBZ-25 in one call: HoroscopeModel in,
 * feature set + theme graph + primary projection + brief out. Pure — no clock,
 * no randomness, no network, no provider.
 */
export function buildNarrativeChain(model: HoroscopeModel): NarrativeChain {
  const featureSet = deriveInterpretationFeatureSet(model);
  const themeGraph = buildThemeGraph(featureSet);
  const primaryThemeProjection = buildPrimaryThemeProjection(featureSet, themeGraph);
  const brief = buildNarrativeBrief(featureSet, themeGraph, primaryThemeProjection, {
    displayName: model.displayName,
  });
  return { featureSet, themeGraph, primaryThemeProjection, brief };
}
