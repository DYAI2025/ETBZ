import { describe, expect, it } from 'vitest';
import {
  findUncitedNumerals,
  findUncitedSymbols,
} from '../../src/application/interpretation/chart-symbol-lexicon.js';
import { deriveInterpretationFeatureSet } from '../../src/application/interpretation/feature-set.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import {
  PRIMARY_THEME_FAMILIES,
  buildPrimaryThemeProjection,
  hashPrimaryThemeProjection,
  primaryThemeFamilyForThemeKind,
} from '../../src/application/interpretation/primary-theme.js';
import type { PrimaryThemeProjection } from '../../src/application/interpretation/primary-theme.js';
import { THEME_KINDS, buildThemeGraph } from '../../src/application/interpretation/theme-graph.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 G — the PrimaryThemeProjection.
 *
 * The projection is the compact layer the sold report is built from. What is
 * asserted here is that it is DERIVED (only candidate theme ids, only chart
 * facts), COMPLETE (no candidate theme is dropped), DETERMINISTIC, TAMPER
 * EVIDENT (its anchor moves when its groupings move), that provisional lineage
 * survives it, and that nothing in it is a ranking.
 */

/** The tamper cases below need a mutable view of the readonly projection shape. */
interface MutablePrimaryTheme {
  sourceThemeIds: string[];
  factIds: string[];
}
interface MutableProjection {
  primaryThemes: MutablePrimaryTheme[];
}

const APPROVED_V1_FAMILY_IDS = [
  'primary.elemental_profile',
  'primary.positional_context',
  'primary.seasonal_anchor',
  'primary.self_role',
];

const projectionOf = (model = knownTimeModel()): PrimaryThemeProjection => {
  const featureSet = deriveInterpretationFeatureSet(model);
  return buildPrimaryThemeProjection(featureSet, buildThemeGraph(featureSet));
};

describe('ETBZ-25 G1: the projection is exactly the four approved v1 families', () => {
  it('produces the four family ids for the synthetic known-time fixture', () => {
    const projection = projectionOf();

    expect(projection.primaryThemes.map((theme) => theme.id)).toEqual(APPROVED_V1_FAMILY_IDS);
    expect(projection.primaryThemes.map((theme) => theme.family)).toEqual([
      'elemental_profile',
      'positional_context',
      'seasonal_anchor',
      'self_role',
    ]);
  });

  it('produces the same four families for the unknown-time fixture', () => {
    expect(projectionOf(unknownTimeModel()).primaryThemes.map((theme) => theme.id)).toEqual(
      APPROVED_V1_FAMILY_IDS,
    );
  });

  it('claims every candidate theme kind exactly once', () => {
    // Exhaustiveness is the property that keeps "nothing is dropped" true as
    // the ThemeGraph grows: a kind added to the graph with no family would
    // vanish from the customer-facing layer.
    for (const kind of THEME_KINDS) {
      expect(primaryThemeFamilyForThemeKind(kind), kind).toBeDefined();
    }
    const claimed = PRIMARY_THEME_FAMILIES.flatMap((family) => family.sourceThemeKinds);
    expect([...claimed].sort()).toEqual([...THEME_KINDS].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe('ETBZ-25 G2: the projection is derived, never invented', () => {
  it('references only candidate theme ids of this chart', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const graph = buildThemeGraph(featureSet);
    const projection = buildPrimaryThemeProjection(featureSet, graph);
    const candidateIds = new Set(graph.themes.map((theme) => theme.id));

    for (const primary of projection.primaryThemes) {
      expect(primary.sourceThemeIds.length, primary.id).toBeGreaterThan(0);
      for (const sourceId of primary.sourceThemeIds) {
        expect(candidateIds, `${primary.id} -> ${sourceId}`).toContain(sourceId);
      }
    }
  });

  it('resolves every primary fact reference to a real feature-set fact', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const projection = buildPrimaryThemeProjection(featureSet, buildThemeGraph(featureSet));
    const known = new Set(featureSet.factIds);

    for (const primary of projection.primaryThemes) {
      expect(primary.factIds.length, primary.id).toBeGreaterThan(0);
      for (const factId of primary.factIds) {
        expect(known, `${primary.id} -> ${factId}`).toContain(factId);
      }
      for (const factId of primary.provisionalFactIds) {
        expect(primary.factIds, `${primary.id} -> ${factId}`).toContain(factId);
      }
      expect(primary.supportCount).toBe(primary.factIds.length);
    }
  });

  it('copies each source theme label from the candidate theme it belongs to', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const graph = buildThemeGraph(featureSet);
    const byId = new Map(graph.themes.map((theme) => [theme.id, theme]));

    for (const primary of buildPrimaryThemeProjection(featureSet, graph).primaryThemes) {
      expect(primary.sourceThemeLabels.length, primary.id).toBe(primary.sourceThemeIds.length);
      primary.sourceThemeIds.forEach((sourceId, index) => {
        expect(primary.sourceThemeLabels[index], sourceId).toBe(byId.get(sourceId)?.label);
      });
    }
  });

  it('names only methods the feature set actually evaluated on those facts', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const projection = buildPrimaryThemeProjection(featureSet, buildThemeGraph(featureSet));
    const evaluated = new Map(
      featureSet.methodScope
        .filter((note) => note.status === 'evaluated')
        .map((note) => [note.methodId, new Set(note.sourceFactIds)]),
    );

    for (const primary of projection.primaryThemes) {
      expect(primary.methodIds.length, primary.id).toBeGreaterThan(0);
      for (const methodId of primary.methodIds) {
        const sourceFactIds = evaluated.get(methodId);
        expect(sourceFactIds, `${primary.id} -> ${methodId}`).toBeDefined();
        expect(
          primary.factIds.some((factId) => sourceFactIds?.has(factId) === true),
          `${primary.id} -> ${methodId}`,
        ).toBe(true);
      }
    }
  });
});

describe('ETBZ-25 G3: the candidate graph survives the projection intact', () => {
  it('groups every candidate theme into exactly one primary theme', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const graph = buildThemeGraph(featureSet);
    const grouped = buildPrimaryThemeProjection(featureSet, graph).primaryThemes.flatMap(
      (primary) => primary.sourceThemeIds,
    );

    expect([...grouped].sort()).toEqual([...graph.themes.map((theme) => theme.id)].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('leaves the ThemeGraph itself unchanged and still deterministic', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const graph = buildThemeGraph(featureSet);
    const before = structuredClone(graph);

    buildPrimaryThemeProjection(featureSet, graph);

    expect(graph).toEqual(before);
    expect(graph.structuralHash).toBe(buildThemeGraph(featureSet).structuralHash);
  });

  it('carries the union of its members facts, not a selection of them', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const graph = buildThemeGraph(featureSet);
    const byId = new Map(graph.themes.map((theme) => [theme.id, theme]));

    for (const primary of buildPrimaryThemeProjection(featureSet, graph).primaryThemes) {
      const union = new Set(
        primary.sourceThemeIds.flatMap((sourceId) => byId.get(sourceId)?.factIds ?? []),
      );
      expect([...primary.factIds].sort()).toEqual([...union].sort());
    }
  });
});

describe('ETBZ-25 G4: the projection is deterministic and tamper evident', () => {
  it('builds byte-identical projections from an identical HoroscopeModel', () => {
    const first = projectionOf();
    const second = projectionOf();

    expect(second).toEqual(first);
    expect(second.structuralHash).toBe(first.structuralHash);
  });

  it('re-derives its own published hash', () => {
    const projection = projectionOf();

    expect(hashPrimaryThemeProjection(projection)).toBe(projection.structuralHash);
  });

  it.each([
    [
      'a dropped sourceThemeId',
      (projection: MutableProjection): void => {
        projection.primaryThemes[3]?.sourceThemeIds.pop();
      },
    ],
    [
      'an added sourceThemeId',
      (projection: MutableProjection): void => {
        projection.primaryThemes[2]?.sourceThemeIds.push('theme.pillar.year');
      },
    ],
    [
      'a dropped factId',
      (projection: MutableProjection): void => {
        projection.primaryThemes[0]?.factIds.pop();
      },
    ],
    [
      'a moved factId',
      (projection: MutableProjection): void => {
        projection.primaryThemes[2]?.factIds.push('chart.pillar.year.stem');
      },
    ],
  ])('moves the structural anchor when a primary theme carries %s', (_label, mutate) => {
    const projection = projectionOf();
    const tampered = structuredClone(projection) as unknown as MutableProjection;
    mutate(tampered);

    expect(hashPrimaryThemeProjection(tampered as unknown as PrimaryThemeProjection)).not.toBe(
      projection.structuralHash,
    );
  });

  it('carries the anchor into the brief', () => {
    const chain = buildNarrativeChain(knownTimeModel());

    expect(chain.brief.primaryThemeProjectionStructuralHash).toBe(
      chain.primaryThemeProjection.structuralHash,
    );
  });
});

describe('ETBZ-25 G5: provisional lineage survives the projection', () => {
  it('marks no primary theme provisional for a known-time chart', () => {
    const projection = projectionOf();

    expect(projection.primaryThemes.every((theme) => !theme.containsProvisionalFacts)).toBe(true);
    expect(projection.primaryThemes.flatMap((theme) => theme.provisionalFactIds)).toEqual([]);
  });

  it('keeps every provisional fact provisional for an unknown-time chart', () => {
    const featureSet = deriveInterpretationFeatureSet(unknownTimeModel());
    const projection = buildPrimaryThemeProjection(featureSet, buildThemeGraph(featureSet));
    const provisional = new Set(featureSet.provisionalFactIds);

    expect(provisional.size).toBeGreaterThan(0);
    const carried = new Set(projection.primaryThemes.flatMap((theme) => theme.provisionalFactIds));
    // Every provisional fact of the chart is still marked provisional somewhere
    // in the primary layer - the projection narrows no uncertainty.
    for (const factId of provisional) {
      expect(carried, factId).toContain(factId);
    }
    // And a primary theme calls itself provisional exactly when it holds one.
    for (const theme of projection.primaryThemes) {
      expect(theme.containsProvisionalFacts, theme.id).toBe(theme.provisionalFactIds.length > 0);
      expect(theme.provisionalFactIds, theme.id).toEqual(
        theme.factIds.filter((factId) => provisional.has(factId)),
      );
    }
    // The guard is not vacuous in the other direction either: at least one
    // family holds no provisional fact at all.
    expect(projection.primaryThemes.some((theme) => !theme.containsProvisionalFacts)).toBe(true);
  });
});

describe('ETBZ-25 G6: nothing in the projection is a ranking', () => {
  it('orders primary themes lexicographically, never by support count', () => {
    const themes = projectionOf().primaryThemes;
    const ids = themes.map((theme) => theme.id);
    const counts = themes.map((theme) => theme.supportCount);

    expect(ids).toEqual([...ids].sort());
    // Proof the order is NOT support-driven: on this chart the published order
    // is neither the descending nor the ascending support order.
    expect(counts).not.toEqual([...counts].sort((left, right) => right - left));
    expect(counts).not.toEqual([...counts].sort((left, right) => left - right));
  });

  it('exposes no score, rank, weight or prominence field', () => {
    const [first] = projectionOf().primaryThemes;

    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'containsProvisionalFacts',
      'factIds',
      'family',
      'id',
      'methodIds',
      'provisionalFactIds',
      'sourceThemeIds',
      'sourceThemeKinds',
      'sourceThemeLabels',
      'statement',
      'supportCount',
    ]);
  });

  it('states a grouping rule that names no chart symbol and no quantity', () => {
    // The family names and their statements are ETBZ-owned GROUPING CATEGORIES.
    // Measured with the repository’s own guard, against an empty covered set:
    // if a category text named a stem, a branch, a Ten God, an element, a Qi
    // role or a number, the category would be asserting a finding about the
    // chart instead of describing how facts were grouped.
    for (const theme of projectionOf().primaryThemes) {
      expect(theme.statement.length, theme.id).toBeGreaterThan(0);
      for (const [where, text] of [
        [`${theme.id}.family`, theme.family],
        [`${theme.id}.statement`, theme.statement],
      ] as const) {
        expect(findUncitedSymbols(text, new Set()), where).toEqual([]);
        expect(findUncitedNumerals(text, new Set()), where).toEqual([]);
      }
    }
  });
});
