/**
 * ETBZ-25 — ThemeGraph: STRUCTURAL groupings of facts that already exist.
 *
 * A "theme" here is not a reading and not a claim. It is a named SET of
 * feature-set facts plus the source's own label for that set, and it exists for
 * exactly one reason: a later narrative sentence must be attachable to a
 * bounded group of facts rather than to the chart at large.
 *
 * What this module deliberately does NOT do:
 *  - it applies no astrological rule and derives no new symbolic value;
 *  - it computes no strength, dominance, favourability or ranking, and it does
 *    not sum the source's Qi weights into a new number — a total nobody
 *    measured would be an invented finding;
 *  - it orders themes lexicographically by id, NOT by size, so that position in
 *    the list cannot be read as prominence.
 *
 * Edges are set intersection and nothing else: two themes are linked when they
 * literally share a fact. That relation is decidable, reproducible and carries
 * no interpretation.
 */

import { structuralHash } from '../../domain/structural-hash.js';
import type { PillarName } from '../horoscope-model.js';
import { InterpretationError } from './errors.js';
import { PILLAR_NAMES } from './feature-set.js';
import type { ChartFact, InterpretationFeatureSet } from './feature-set.js';

export type ThemeKind =
  | 'pillar'
  | 'day_master'
  | 'month_command'
  | 'ten_god_relation'
  | 'wu_xing_element';

/**
 * The same union, enumerable at runtime.
 *
 * It exists so the primary-theme projection can be PROVEN exhaustive over the
 * candidate kinds instead of assumed exhaustive: a kind added to the union
 * without a primary family is caught by a test rather than silently dropped out
 * of the customer-facing layer. `satisfies` keeps the two spellings in
 * lockstep, so a wrong entry is a compile error rather than a runtime surprise.
 */
export const THEME_KINDS = [
  'day_master',
  'month_command',
  'pillar',
  'ten_god_relation',
  'wu_xing_element',
] as const satisfies readonly ThemeKind[];

export interface Theme {
  readonly id: string;
  readonly kind: ThemeKind;
  /** The SOURCE's own label for this grouping, never an ETBZ coinage. */
  readonly label: string;
  /** The feature-set fact the label was taken from. */
  readonly labelFactId: string;
  /**
   * Which field of that fact the label is: its source VALUE (e.g. the animal
   * tier FuFirE reports for a branch) or its source LABEL (e.g. FuFirE's own
   * German Ten God label, or the element name FuFirE keys its Wu Xing vector
   * by). Stating this makes "the label is source-owned" checkable instead of
   * asserted.
   */
  readonly labelFrom: 'value' | 'sourceLabel';
  /** Feature-set fact ids, sorted. This is the theme's entire evidence. */
  readonly factIds: readonly string[];
  readonly provisionalFactIds: readonly string[];
  readonly containsProvisionalFacts: boolean;
  /**
   * How many facts support the theme. Structural cardinality ONLY — it is not
   * a strength, a weight or a confidence, and nothing downstream ranks by it.
   */
  readonly supportCount: number;
}

export interface ThemeEdge {
  readonly from: string;
  readonly to: string;
  /** The only relation this slice can prove: the two themes share a fact. */
  readonly kind: 'shares_fact';
  readonly sharedFactIds: readonly string[];
}

export interface ThemeGraph {
  readonly themeGraphVersion: 'etbz-25.theme-graph.v1';
  readonly featureSetStructuralHash: string;
  readonly themes: readonly Theme[];
  readonly edges: readonly ThemeEdge[];
  readonly structuralHash: string;
}

function sortIds(ids: readonly string[]): readonly string[] {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

interface ThemeDraft {
  readonly id: string;
  readonly kind: ThemeKind;
  readonly label: string;
  readonly labelFactId: string;
  readonly labelFrom: 'value' | 'sourceLabel';
  readonly facts: readonly ChartFact[];
}

function finalize(draft: ThemeDraft): Theme {
  const factIds = sortIds(draft.facts.map((fact) => fact.id));
  const provisionalFactIds = sortIds(
    draft.facts.filter((fact) => fact.provisional).map((fact) => fact.id),
  );
  return {
    id: draft.id,
    kind: draft.kind,
    label: draft.label,
    labelFactId: draft.labelFactId,
    labelFrom: draft.labelFrom,
    factIds,
    provisionalFactIds,
    containsProvisionalFacts: provisionalFactIds.length > 0,
    supportCount: factIds.length,
  };
}

function requireFact(facts: readonly ChartFact[], id: string): ChartFact {
  const fact = facts.find((candidate) => candidate.id === id);
  if (fact === undefined) {
    // Not a validation branch for untrusted input: the feature set is produced
    // by `deriveInterpretationFeatureSet` in the same call chain, so this is a
    // programming-error guard that must never silently produce a smaller theme.
    throw new RangeError(`theme-graph: feature set does not carry the fact "${id}"`);
  }
  return fact;
}

function pillarThemes(facts: readonly ChartFact[]): ThemeDraft[] {
  return PILLAR_NAMES.map((pillar: PillarName): ThemeDraft => {
    const tier = requireFact(facts, `chart.pillar.${pillar}.tier`);
    return {
      id: `theme.pillar.${pillar}`,
      kind: 'pillar',
      // FuFirE's own German tier label for that pillar's branch.
      label: tier.value,
      labelFactId: tier.id,
      labelFrom: 'value',
      facts: facts.filter((fact) => fact.pillar === pillar),
    };
  });
}

function dayMasterTheme(facts: readonly ChartFact[]): ThemeDraft {
  const stem = requireFact(facts, 'chart.dayMaster.stem');
  return {
    id: 'theme.dayMaster',
    kind: 'day_master',
    label: stem.value,
    labelFactId: stem.id,
    labelFrom: 'value',
    facts: facts.filter(
      (fact) =>
        fact.kind === 'day_master' ||
        fact.kind === 'day_master_hanzi' ||
        fact.kind === 'day_master_pinyin' ||
        fact.kind === 'day_master_element' ||
        fact.kind === 'day_master_polarity' ||
        fact.id === 'chart.pillar.day.stem' ||
        fact.id === 'chart.pillar.day.stemElement',
    ),
  };
}

function monthCommandTheme(facts: readonly ChartFact[]): ThemeDraft {
  const branch = requireFact(facts, 'chart.natal.monthCommand.branch');
  return {
    id: 'theme.monthCommand',
    kind: 'month_command',
    label: branch.value,
    labelFactId: branch.id,
    labelFrom: 'value',
    facts: facts.filter(
      (fact) =>
        fact.kind === 'month_command_branch' ||
        fact.kind === 'month_command_principal_qi_stem' ||
        fact.id === 'chart.pillar.month.branch' ||
        fact.id === 'chart.pillar.month.tier',
    ),
  };
}

/**
 * One theme per Ten God the chart actually carries.
 *
 * The label is FuFirE's own `label_de` for that Ten God. Two facts naming the
 * same Ten God with DIFFERENT labels is contract drift, and the theme is
 * refused rather than silently resolved in favour of whichever came first.
 */
function tenGodThemes(facts: readonly ChartFact[]): ThemeDraft[] {
  const tenGodFacts = facts.filter(
    (fact) => fact.kind === 'ten_god' || fact.kind === 'hidden_stem_ten_god',
  );
  const byName = new Map<string, ChartFact[]>();
  for (const fact of tenGodFacts) {
    const bucket = byName.get(fact.value);
    if (bucket === undefined) {
      byName.set(fact.value, [fact]);
    } else {
      bucket.push(fact);
    }
  }
  const drafts: ThemeDraft[] = [];
  for (const [name, bucket] of byName) {
    const labels = new Set(bucket.map((fact) => fact.sourceLabel ?? ''));
    if (labels.size !== 1) {
      throw new InterpretationError(
        'THEME_LABEL_CONTRADICTION',
        `Ten God "${name}" carries ${String(labels.size)} different source labels in one chart; ETBZ does not pick a winner`,
      );
    }
    // The bucket is non-empty by construction (it exists because a fact was put
    // in it), so the label is read positionally and the ONLY failure written
    // out is the one a real response can produce: a label that is absent or
    // blank. A branch no input can reach would not be a guard.
    const first = bucket[0] ?? null;
    const label = first?.sourceLabel ?? '';
    if (first === null || label.trim().length === 0) {
      throw new InterpretationError(
        'THEME_LABEL_CONTRADICTION',
        `Ten God "${name}" carries no usable source label; ETBZ never invents one`,
      );
    }
    drafts.push({
      id: `theme.tenGod.${name}`,
      kind: 'ten_god_relation',
      label,
      labelFactId: first.id,
      labelFrom: 'sourceLabel',
      facts: bucket,
    });
  }
  return drafts;
}

/**
 * One theme per Wu Xing element the chart names, built ONLY from facts stated
 * in FuFirE's German element vocabulary. The natal endpoint's English element
 * vocabulary is deliberately NOT bridged in here: mixing the two would make a
 * theme depend on a translation step rather than on stated facts.
 */
function wuXingThemes(facts: readonly ChartFact[]): ThemeDraft[] {
  const weights = facts.filter((fact) => fact.kind === 'wu_xing_weight');
  return weights.map((weight): ThemeDraft => {
    const element = weight.sourceLabel ?? '';
    return {
      id: `theme.wuXing.${element}`,
      kind: 'wu_xing_element',
      label: element,
      labelFactId: weight.id,
      labelFrom: 'sourceLabel',
      facts: facts.filter(
        (fact) =>
          fact.id === weight.id ||
          (fact.kind === 'wu_xing_dominant' && fact.value === element) ||
          (fact.kind === 'pillar_stem_element' && fact.value === element) ||
          (fact.kind === 'day_master_element' && fact.value === element),
      ),
    };
  });
}

function buildEdges(themes: readonly Theme[]): readonly ThemeEdge[] {
  const edges: ThemeEdge[] = [];
  for (let i = 0; i < themes.length; i += 1) {
    for (let j = i + 1; j < themes.length; j += 1) {
      const left = themes[i];
      const right = themes[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      const rightIds = new Set(right.factIds);
      const shared = left.factIds.filter((id) => rightIds.has(id));
      if (shared.length === 0) {
        continue;
      }
      edges.push({ from: left.id, to: right.id, kind: 'shares_fact', sharedFactIds: shared });
    }
  }
  return edges;
}

/**
 * Builds the ThemeGraph. Pure: same feature set in, byte-identical graph out.
 */
export function buildThemeGraph(featureSet: InterpretationFeatureSet): ThemeGraph {
  const facts = featureSet.facts;
  const drafts: ThemeDraft[] = [
    ...pillarThemes(facts),
    dayMasterTheme(facts),
    monthCommandTheme(facts),
    ...tenGodThemes(facts),
    ...wuXingThemes(facts),
  ];

  // Lexicographic by id. Ordering by supportCount would publish a ranking this
  // slice has no basis for.
  const themes = drafts
    .map(finalize)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const core = {
    themeGraphVersion: 'etbz-25.theme-graph.v1' as const,
    featureSetStructuralHash: featureSet.structuralHash,
    themes,
    edges: buildEdges(themes),
  };

  return { ...core, structuralHash: structuralHash(core) };
}
