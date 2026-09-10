import { describe, expect, it } from 'vitest';
import { InterpretationError } from '../../src/application/interpretation/errors.js';
import { deriveInterpretationFeatureSet } from '../../src/application/interpretation/feature-set.js';
import { buildThemeGraph } from '../../src/application/interpretation/theme-graph.js';
import { factText, resolveFactPath } from '../support/factPath.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 B — ThemeGraph.
 *
 * A theme is a SET of facts plus the source's own label for that set. The
 * assertions below hold the module to exactly that: labels resolve back into
 * the HoroscopeModel, memberships resolve back into the feature set, edges are
 * literal set intersection, and nothing is ranked.
 */

const graphOf = (model = knownTimeModel()) =>
  buildThemeGraph(deriveInterpretationFeatureSet(model));

/** A full replacement of the year pillar's hidden stems (arrays REPLACE). */
const YEAR_HIDDEN_STEMS_WITH_DRIFTED_LABEL = [
  {
    stem: 'Ding',
    stemCn: '丁',
    element: 'fire',
    qi: 'principal',
    weight: 1,
    tenGod: {
      name: 'SevenKilling',
      pinyin: 'Qi Sha',
      elementRelation: 'controls_day_master',
      // The SAME Ten God the month and hour pillars carry, with a DIFFERENT
      // source label. Internally well-formed; contract drift nonetheless.
      labelDe: 'Ein anderer Text',
    },
  },
  {
    stem: 'Ji',
    stemCn: '己',
    element: 'earth',
    qi: 'central',
    weight: 0.5,
    tenGod: {
      name: 'IndirectRes',
      pinyin: 'Pian Yin',
      elementRelation: 'produces_day_master',
      labelDe: 'Indirekte Quelle',
    },
  },
];

describe('ETBZ-25 B1: the graph is a pure function of the feature set', () => {
  it('builds byte-identical graphs from an identical model', () => {
    const first = graphOf();
    const second = graphOf();

    expect(second).toEqual(first);
    expect(second.structuralHash).toBe(first.structuralHash);
  });

  it('changes the graph hash when a theme membership changes', () => {
    const base = graphOf();
    // A different dominant element moves one fact between wu-xing themes.
    const drifted = graphOf(knownTimeModel({ wuxing: { dominant: 'Metall' } }));

    expect(drifted.structuralHash).not.toBe(base.structuralHash);
  });

  it('binds itself to the feature set it was built from', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());

    expect(buildThemeGraph(featureSet).featureSetStructuralHash).toBe(featureSet.structuralHash);
  });
});

describe('ETBZ-25 B2: themes are grounded and unranked', () => {
  it('references only facts that exist in the feature set', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const graph = buildThemeGraph(featureSet);
    const known = new Set(featureSet.factIds);

    expect(graph.themes.length).toBeGreaterThan(4);
    for (const theme of graph.themes) {
      expect(theme.factIds.length, theme.id).toBeGreaterThan(0);
      for (const factId of theme.factIds) {
        expect(known, `${theme.id} -> ${factId}`).toContain(factId);
      }
    }
  });

  it('takes every theme label from a fact of this chart, never from an ETBZ coinage', () => {
    const model = knownTimeModel();
    const featureSet = deriveInterpretationFeatureSet(model);
    const byId = new Map(featureSet.facts.map((fact) => [fact.id, fact]));

    for (const theme of buildThemeGraph(featureSet).themes) {
      const fact = byId.get(theme.labelFactId);
      expect(fact, theme.id).toBeDefined();
      if (fact === undefined) continue;
      // The label is that fact's source value or its source label...
      expect(
        theme.labelFrom === 'value' ? fact.value : fact.sourceLabel,
        theme.id,
      ).toBe(theme.label);
      // ...and the fact itself is the HoroscopeModel value at its own path,
      // so the label chain reaches the source with no ETBZ step in between.
      expect(factText(resolveFactPath(model, fact.path)), fact.id).toBe(fact.value);
      expect(theme.factIds, theme.id).toContain(theme.labelFactId);
    }
  });

  it('orders themes lexicographically, so position cannot be read as prominence', () => {
    const themes = graphOf().themes;
    const ids = themes.map((theme) => theme.id);

    expect(ids).toEqual([...ids].sort());
    // Proof that the order is NOT support-driven: the sorted order really does
    // put a smaller theme before a larger one in this chart. The count is
    // measured HERE, from the published `factIds`; the theme itself no longer
    // carries one (ETBZ-25A-R2), and this test is where that stays checkable
    // without the artefact having to state it.
    const counts = themes.map((theme) => theme.factIds.length);
    expect(counts).not.toEqual([...counts].sort((a, b) => b - a));
  });

  it('covers the pillars, the day master, the month command, ten gods and wu xing', () => {
    const kinds = new Set(graphOf().themes.map((theme) => theme.kind));

    expect([...kinds].sort()).toEqual([
      'day_master',
      'month_command',
      'pillar',
      'ten_god_relation',
      'wu_xing_element',
    ]);
  });
});

describe('ETBZ-25 B3: edges are literal shared facts, nothing more', () => {
  it('emits an edge exactly when two themes share at least one fact', () => {
    const graph = graphOf();
    const byId = new Map(graph.themes.map((theme) => [theme.id, theme]));

    for (const edge of graph.edges) {
      expect(edge.kind).toBe('shares_fact');
      expect(edge.from < edge.to, `${edge.from} -> ${edge.to}`).toBe(true);
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      if (from === undefined || to === undefined) continue;
      const intersection = from.factIds.filter((id) => to.factIds.includes(id));
      expect(edge.sharedFactIds).toEqual(intersection);
      expect(edge.sharedFactIds.length).toBeGreaterThan(0);
    }
  });

  it('emits no edge for themes that share no fact (guard is not vacuous)', () => {
    const graph = graphOf();
    const byId = new Map(graph.themes.map((theme) => [theme.id, theme]));
    const linked = new Set(graph.edges.map((edge) => `${edge.from}|${edge.to}`));

    let disjointPairsChecked = 0;
    const ids = [...byId.keys()].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const left = byId.get(ids[i] ?? '');
        const right = byId.get(ids[j] ?? '');
        if (left === undefined || right === undefined) continue;
        const shares = left.factIds.some((id) => right.factIds.includes(id));
        if (!shares) {
          expect(linked.has(`${left.id}|${right.id}`)).toBe(false);
          disjointPairsChecked += 1;
        }
      }
    }
    // The negative half of the assertion must actually have been exercised.
    expect(disjointPairsChecked).toBeGreaterThan(0);
  });

  it('links the day master to the day pillar through their shared facts', () => {
    const edge = graphOf().edges.find(
      (candidate) => candidate.from === 'theme.dayMaster' && candidate.to === 'theme.pillar.day',
    );

    expect(edge).toBeDefined();
    expect(edge?.sharedFactIds).toContain('chart.pillar.day.stem');
  });
});

describe('ETBZ-25 B4: provisionality reaches the theme level', () => {
  it('marks no theme provisional for a known-time chart', () => {
    expect(graphOf().themes.every((theme) => !theme.containsProvisionalFacts)).toBe(true);
  });

  it('marks the hour pillar theme provisional when the birth time is unknown', () => {
    const themes = graphOf(unknownTimeModel()).themes;
    const hour = themes.find((theme) => theme.id === 'theme.pillar.hour');

    expect(hour).toBeDefined();
    expect(hour?.containsProvisionalFacts).toBe(true);
    expect(hour?.provisionalFactIds).toEqual(hour?.factIds);

    const year = themes.find((theme) => theme.id === 'theme.pillar.year');
    expect(year?.containsProvisionalFacts).toBe(false);
  });
});

describe('ETBZ-25 B5: a contradicted source label is refused, not resolved', () => {
  it('fails closed when one Ten God carries two different source labels', () => {
    const model = knownTimeModel({
      natal: { pillars: { year: { hiddenStems: YEAR_HIDDEN_STEMS_WITH_DRIFTED_LABEL } } },
    });
    const featureSet = deriveInterpretationFeatureSet(model);

    try {
      buildThemeGraph(featureSet);
      expect.unreachable('a contradicted Ten God label must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationError);
      expect((error as InterpretationError).code).toBe('THEME_LABEL_CONTRADICTION');
    }
  });

  it('fails closed when a Ten God carries a blank source label', () => {
    // RobWealth appears exactly once in this chart, so this isolates the
    // blank-label branch from the contradicting-label branch above.
    const model = knownTimeModel({
      natal: { pillars: { year: { tenGod: { labelDe: '   ' } } } },
    });

    try {
      buildThemeGraph(deriveInterpretationFeatureSet(model));
      expect.unreachable('a blank Ten God label must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationError);
      expect((error as InterpretationError).code).toBe('THEME_LABEL_CONTRADICTION');
    }
  });

  it('accepts the same chart when the labels agree (the guard is not always red)', () => {
    expect(() => graphOf()).not.toThrow();
  });
});
