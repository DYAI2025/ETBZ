/**
 * ETBZ-25 — PrimaryThemeProjection: the COMPACT layer above the exhaustive
 * candidate ThemeGraph.
 *
 * The ThemeGraph is deliberately exhaustive: every pillar, the day master, the
 * month command, every Ten God and every Wu Xing element the chart names
 * becomes its own candidate node. That is the right shape for a structural
 * index and the wrong shape for a sold report — one customer-facing chapter per
 * candidate node would publish a dozen-odd chapters whose count is an artefact
 * of how many Ten Gods a chart happens to carry.
 *
 * This module projects those candidates onto exactly four v1 PRIMARY THEME
 * FAMILIES. What the projection is, stated precisely so it cannot be read as
 * more than it is:
 *
 *   IT IS      a deterministic re-grouping of candidate themes by their KIND,
 *              carrying the union of their facts and their source-owned labels.
 *   IT IS NOT  a ranking, a strength, a favourability, a significance or a
 *              selection of "the most important" themes. No candidate theme is
 *              dropped: every one of them is a member of exactly one family, and
 *              the whole candidate graph stays available in the brief as
 *              structural nuance.
 *
 * The four family names are ETBZ GROUPING CATEGORIES, not astrological terms
 * and not translations of one. They name where a fact was read from — the self
 * (day master and its Ten God relations), the season (month command), the
 * elemental distribution, the pillar positions — and nothing about what any of
 * it means. Reading them as a hierarchy would be reading something the data
 * does not contain.
 *
 * Nothing here computes a new astrological value, and nothing here consults a
 * rule: the projection is set union over `kind`, and its ordering is
 * lexicographic by id for the same reason the ThemeGraph's is — so that
 * position in the list cannot be mistaken for prominence.
 */

import { structuralHash } from '../../domain/structural-hash.js';
import type { InterpretationFeatureSet } from './feature-set.js';
import type { MethodNote } from './method-scope.js';
import type { Theme, ThemeGraph, ThemeKind } from './theme-graph.js';

export type PrimaryThemeFamily =
  | 'elemental_profile'
  | 'positional_context'
  | 'seasonal_anchor'
  | 'self_role';

export interface PrimaryThemeFamilyDefinition {
  readonly family: PrimaryThemeFamily;
  /** Stable id. `primary.` prefixed so it can never collide with a `theme.` id. */
  readonly id: string;
  /** The candidate ThemeGraph kinds this family groups. */
  readonly sourceThemeKinds: readonly ThemeKind[];
  /**
   * A value-free description of WHAT WAS GROUPED. It states the grouping rule,
   * never a finding about the chart, and carries no chart symbol.
   */
  readonly statement: string;
}

/**
 * The four approved v1 families, declared in the order they are published
 * (lexicographic by id). The declaration order is the published order; it is
 * not a priority list, and `buildPrimaryThemeProjection` sorts by id anyway so
 * a reordering of this array cannot change the artefact.
 */
export const PRIMARY_THEME_FAMILIES: readonly PrimaryThemeFamilyDefinition[] = [
  {
    family: 'elemental_profile',
    id: 'primary.elemental_profile',
    sourceThemeKinds: ['wu_xing_element'],
    statement:
      'Groups the candidate themes built from the elemental distribution facts. A grouping of where element values were read, never a statement about balance, excess or lack.',
  },
  {
    family: 'positional_context',
    id: 'primary.positional_context',
    sourceThemeKinds: ['pillar'],
    statement:
      'Groups the candidate themes built per pillar position. A grouping by position in the chart, never a statement that one position outweighs another.',
  },
  {
    family: 'seasonal_anchor',
    id: 'primary.seasonal_anchor',
    sourceThemeKinds: ['month_command'],
    statement:
      'Groups the candidate theme built from the month-command facts. A grouping by the seasonal anchor the source states, never a seasonal strength assessment.',
  },
  {
    family: 'self_role',
    id: 'primary.self_role',
    sourceThemeKinds: ['day_master', 'ten_god_relation'],
    statement:
      'Groups the candidate themes built from the day master and from the Ten God relations to it. A grouping by what the source relates to the day master, never a claim about the day master itself.',
  },
] as const;

/**
 * One primary theme: a family, the candidate themes it groups, and the union of
 * their evidence.
 *
 * It carries NO number at all. Not a score, not a rank, not a weight, not a
 * confidence, not a prominence — and, since ETBZ-25A-R2, not a cardinality
 * either. The fact REFERENCES are published in full; the count of them is not.
 *
 * That last removal is the load-bearing one. This structure is handed to a
 * narrative provider, and a future provider may be a language model: a numeric
 * field beside a theme is exactly the kind of thing such a consumer reads as
 * "this theme matters more", however the field is named and however carefully
 * its doc comment disclaims it. The count was only `factIds.length` — how many
 * rows FuFirE happened to state — so publishing it invited an importance
 * reading that the number could not support. A shape with no number in it
 * cannot be misread that way, which makes this a property of the boundary
 * rather than of a provider's good behaviour.
 */
export interface PrimaryTheme {
  readonly id: string;
  readonly family: PrimaryThemeFamily;
  /** The value-free grouping rule, copied from the family definition. */
  readonly statement: string;
  /** The candidate ThemeGraph ids this theme groups, sorted. Never invented. */
  readonly sourceThemeIds: readonly string[];
  readonly sourceThemeKinds: readonly ThemeKind[];
  /** The source-owned labels of those candidate themes, in `sourceThemeIds` order. */
  readonly sourceThemeLabels: readonly string[];
  /** Union of the members' fact ids, sorted. The theme's entire evidence. */
  readonly factIds: readonly string[];
  readonly provisionalFactIds: readonly string[];
  readonly containsProvisionalFacts: boolean;
  /**
   * The EVALUATED methods whose source facts this theme actually carries.
   *
   * Derived by intersecting the feature set's own method scope with this
   * theme's facts, so a downstream consumer can state which method a chapter
   * rests on without re-deriving it — and so a method with no fact in the
   * theme is never listed.
   */
  readonly methodIds: readonly string[];
}

export interface PrimaryThemeProjection {
  readonly projectionVersion: 'etbz-25.primary-theme-projection.v1';
  readonly featureSetStructuralHash: string;
  readonly themeGraphStructuralHash: string;
  readonly primaryThemes: readonly PrimaryTheme[];
  readonly structuralHash: string;
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * `kind -> family`, built once and refused if two families claimed one kind.
 *
 * A kind claimed twice would put the same candidate facts into two primary
 * themes and make the projection's fact union ambiguous, so it fails at module
 * load rather than producing a plausible-looking artefact.
 */
const FAMILY_BY_THEME_KIND: ReadonlyMap<ThemeKind, PrimaryThemeFamilyDefinition> = (() => {
  const map = new Map<ThemeKind, PrimaryThemeFamilyDefinition>();
  for (const definition of PRIMARY_THEME_FAMILIES) {
    for (const kind of definition.sourceThemeKinds) {
      const existing = map.get(kind);
      if (existing !== undefined) {
        throw new RangeError(
          `primary-theme: theme kind "${kind}" is claimed by both "${existing.id}" and "${definition.id}"`,
        );
      }
      map.set(kind, definition);
    }
  }
  return map;
})();

/**
 * The family that groups a candidate theme kind, or `undefined` when no family
 * claims it. Exported so exhaustiveness over `THEME_KINDS` is a testable
 * property rather than an unverifiable comment.
 */
export function primaryThemeFamilyForThemeKind(
  kind: ThemeKind,
): PrimaryThemeFamilyDefinition | undefined {
  return FAMILY_BY_THEME_KIND.get(kind);
}

/**
 * The projection's structural anchor, re-derivable from the projection itself.
 *
 * Every field that describes WHAT WAS GROUPED is inside it — the family ids,
 * the source theme ids, the fact unions, the provisional lineage — so a change
 * to any of them moves the hash, and with it the brief hash and the report
 * hash that carry it.
 */
export function hashPrimaryThemeProjection(
  projection: Omit<PrimaryThemeProjection, 'structuralHash'>,
): string {
  return structuralHash({
    projectionVersion: projection.projectionVersion,
    featureSetStructuralHash: projection.featureSetStructuralHash,
    themeGraphStructuralHash: projection.themeGraphStructuralHash,
    primaryThemes: projection.primaryThemes,
  });
}

function methodIdsFor(
  factIds: readonly string[],
  methodScope: readonly MethodNote[],
): readonly string[] {
  const owned = new Set(factIds);
  return sortStrings(
    methodScope
      .filter(
        (note) =>
          note.status === 'evaluated' && note.sourceFactIds.some((factId) => owned.has(factId)),
      )
      .map((note) => note.methodId),
  );
}

function toPrimaryTheme(
  definition: PrimaryThemeFamilyDefinition,
  members: readonly Theme[],
  methodScope: readonly MethodNote[],
): PrimaryTheme {
  if (members.length === 0) {
    // Not a validation branch for untrusted input. Every one of the four
    // families is non-empty for any chart that produced a feature set at all:
    // the four pillar themes, the day-master theme and the month-command theme
    // are built unconditionally, and `buildMethodScope` in `feature-set.ts`
    // already refuses a chart carrying no Ten God or no Wu Xing weight fact. So
    // this is a programming-error guard against a future kind losing its
    // family, never a case a FuFirE response can reach.
    throw new RangeError(
      `primary-theme: family "${definition.id}" grouped no candidate theme; the projection would publish an empty chapter`,
    );
  }
  const sourceThemeIds = members.map((theme) => theme.id);
  const factIds = sortStrings([...new Set(members.flatMap((theme) => theme.factIds))]);
  const provisionalFactIds = sortStrings([
    ...new Set(members.flatMap((theme) => theme.provisionalFactIds)),
  ]);
  return {
    id: definition.id,
    family: definition.family,
    statement: definition.statement,
    sourceThemeIds,
    sourceThemeKinds: definition.sourceThemeKinds,
    // In `sourceThemeIds` order, so a label can always be traced back to the
    // candidate theme — and through it to the chart fact — it was copied from.
    sourceThemeLabels: members.map((theme) => theme.label),
    factIds,
    provisionalFactIds,
    containsProvisionalFacts: provisionalFactIds.length > 0,
    methodIds: methodIdsFor(factIds, methodScope),
  };
}

/**
 * Builds the primary projection. Pure: same feature set and theme graph in,
 * byte-identical projection out.
 *
 * The candidate ThemeGraph is READ, never modified: this function returns a new
 * artefact beside it and leaves `themeGraph` exactly as `buildThemeGraph`
 * produced it.
 */
export function buildPrimaryThemeProjection(
  featureSet: InterpretationFeatureSet,
  themeGraph: ThemeGraph,
): PrimaryThemeProjection {
  const byFamily = new Map<PrimaryThemeFamily, Theme[]>();
  for (const theme of themeGraph.themes) {
    const definition = FAMILY_BY_THEME_KIND.get(theme.kind);
    if (definition === undefined) {
      // Same class of guard as above: a candidate kind with no family would
      // vanish from the customer-facing layer while still being counted as
      // covered. Refuse rather than silently narrow.
      throw new RangeError(
        `primary-theme: candidate theme "${theme.id}" has kind "${theme.kind}", which no primary family claims`,
      );
    }
    const bucket = byFamily.get(definition.family);
    if (bucket === undefined) {
      byFamily.set(definition.family, [theme]);
    } else {
      bucket.push(theme);
    }
  }

  const primaryThemes = PRIMARY_THEME_FAMILIES.map((definition) =>
    toPrimaryTheme(definition, byFamily.get(definition.family) ?? [], featureSet.methodScope),
  ).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const core = {
    projectionVersion: 'etbz-25.primary-theme-projection.v1' as const,
    featureSetStructuralHash: featureSet.structuralHash,
    themeGraphStructuralHash: themeGraph.structuralHash,
    primaryThemes,
  };

  return { ...core, structuralHash: hashPrimaryThemeProjection(core) };
}
