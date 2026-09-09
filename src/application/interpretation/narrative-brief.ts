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
import { SPECIFICITY_POLICY } from './specificity-policy.js';
import type { SpecificityPolicy } from './specificity-policy.js';
import { buildThemeGraph } from './theme-graph.js';
import type { Theme, ThemeEdge, ThemeGraph } from './theme-graph.js';

export interface NarrativeBriefConstraints {
  /** The only fact ids a section may cite. */
  readonly allowedFactIds: readonly string[];
  /** The only theme ids a section may claim. */
  readonly allowedThemeIds: readonly string[];
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
  readonly subject: Readonly<{ displayName: string; birthTimeKnown: boolean }>;
  readonly facts: readonly ChartFact[];
  readonly themes: readonly Theme[];
  readonly edges: readonly ThemeEdge[];
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

/** The three derived artefacts of one chart, produced together and in order. */
export interface NarrativeChain {
  readonly featureSet: InterpretationFeatureSet;
  readonly themeGraph: ThemeGraph;
  readonly brief: NarrativeBrief;
}

export function buildNarrativeBrief(
  featureSet: InterpretationFeatureSet,
  themeGraph: ThemeGraph,
  subject: Readonly<{ displayName: string }>,
): NarrativeBrief {
  const core = {
    briefVersion: 'etbz-25.narrative-brief.v1' as const,
    sourceStructuralHash: featureSet.sourceStructuralHash,
    featureSetStructuralHash: featureSet.structuralHash,
    themeGraphStructuralHash: themeGraph.structuralHash,
    subject: {
      displayName: subject.displayName,
      birthTimeKnown: featureSet.birthTimeKnown,
    },
    facts: featureSet.facts,
    themes: themeGraph.themes,
    edges: themeGraph.edges,
    uncertainty: {
      birthTimeKnown: featureSet.birthTimeKnown,
      provisionalFields: featureSet.provisionalFields,
      provisionalFactIds: featureSet.provisionalFactIds,
      sourceWarnings: featureSet.sourceWarnings,
    },
    methodScope: featureSet.methodScope,
    constraints: {
      allowedFactIds: featureSet.factIds,
      allowedThemeIds: themeGraph.themes.map((theme) => theme.id),
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
 * feature set + theme graph + brief out. Pure — no clock, no randomness, no
 * network, no provider.
 */
export function buildNarrativeChain(model: HoroscopeModel): NarrativeChain {
  const featureSet = deriveInterpretationFeatureSet(model);
  const themeGraph = buildThemeGraph(featureSet);
  const brief = buildNarrativeBrief(featureSet, themeGraph, {
    displayName: model.displayName,
  });
  return { featureSet, themeGraph, brief };
}
