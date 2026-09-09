import { describe, expect, it } from 'vitest';
import {
  buildNarrativeChain,
} from '../../src/application/interpretation/narrative-brief.js';
import { NOT_EVALUATED_METHOD_IDS } from '../../src/application/interpretation/method-scope.js';
import { SPECIFICITY_POLICY } from '../../src/application/interpretation/specificity-policy.js';
import { ALTERNATE_TEN_GOD_ROW } from '../support/natalFixture.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 C — NarrativeBrief.
 *
 * The brief is the only thing a provider ever sees, so the properties that
 * matter are: it is a pure function of the chart, it carries the uncertainty
 * whole, it states closed allow-lists, and it leaks no channel through which an
 * unlisted chart value could reach a provider.
 */

describe('ETBZ-25 C1: the brief is a pure function of the chart', () => {
  it('produces byte-identical chains from an identical HoroscopeModel', () => {
    const first = buildNarrativeChain(knownTimeModel());
    const second = buildNarrativeChain(knownTimeModel());

    expect(second.featureSet.structuralHash).toBe(first.featureSet.structuralHash);
    expect(second.themeGraph.structuralHash).toBe(first.themeGraph.structuralHash);
    expect(second.brief.structuralHash).toBe(first.brief.structuralHash);
    expect(second.brief).toEqual(first.brief);
  });

  it('carries the hashes of the two stages it was built from', () => {
    const chain = buildNarrativeChain(knownTimeModel());

    expect(chain.brief.featureSetStructuralHash).toBe(chain.featureSet.structuralHash);
    expect(chain.brief.themeGraphStructuralHash).toBe(chain.themeGraph.structuralHash);
    expect(chain.brief.sourceStructuralHash).toBe(chain.featureSet.sourceStructuralHash);
  });

  it('changes its hash when a single chart fact changes', () => {
    const base = buildNarrativeChain(knownTimeModel()).brief;
    // A contract-VALID alternative Ten God row: one fact of the chart differs.
    const drifted = buildNarrativeChain(
      knownTimeModel({ natal: { pillars: { hour: { tenGod: ALTERNATE_TEN_GOD_ROW } } } }),
    ).brief;

    expect(drifted.structuralHash).not.toBe(base.structuralHash);
  });

  it('changes its hash when a source warning changes', () => {
    const base = buildNarrativeChain(
      knownTimeModel({ natal: { warnings: ['DAY_ANCHOR_UNVERIFIED'] } }),
    ).brief;
    const extra = buildNarrativeChain(
      knownTimeModel({ natal: { warnings: ['DAY_ANCHOR_UNVERIFIED', 'ANOTHER_CODE'] } }),
    ).brief;

    expect(extra.structuralHash).not.toBe(base.structuralHash);
  });
});

describe('ETBZ-25 C2: the brief states closed sets, not suggestions', () => {
  it('allows exactly the facts and themes of this chart', () => {
    const chain = buildNarrativeChain(knownTimeModel());

    expect(chain.brief.constraints.allowedFactIds).toEqual(chain.featureSet.factIds);
    expect(chain.brief.constraints.allowedThemeIds).toEqual(
      chain.themeGraph.themes.map((theme) => theme.id),
    );
    expect(chain.brief.facts).toEqual(chain.featureSet.facts);
    expect(chain.brief.themes).toEqual(chain.themeGraph.themes);
    expect(chain.brief.edges).toEqual(chain.themeGraph.edges);
  });

  it('names every method a narrative must not invoke', () => {
    const constraints = buildNarrativeChain(knownTimeModel()).brief.constraints;

    expect([...constraints.forbiddenMethodIds].sort()).toEqual([...NOT_EVALUATED_METHOD_IDS].sort());
    expect(constraints.citationRequired).toBe(true);
    expect(constraints.provisionalCitationRequiresNote).toBe(true);
    expect(constraints.specificity).toEqual(SPECIFICITY_POLICY);
  });

  it('gives the provider no channel to the raw model text', () => {
    const model = knownTimeModel();
    const brief = buildNarrativeChain(model).brief;

    expect(Object.keys(brief)).not.toContain('canonicalJson');
    expect(Object.keys(brief)).not.toContain('sourceCanonicalJson');
    // The model's own canonical text is nowhere inside the brief: a provider
    // cannot read a chart value that is not an explicitly listed fact.
    expect(JSON.stringify(brief)).not.toContain(model.canonicalJson);
    expect(model.canonicalJson.length).toBeGreaterThan(100);
  });
});

describe('ETBZ-25 C3: uncertainty reaches the brief whole', () => {
  it('carries the source warnings verbatim', () => {
    const model = unknownTimeModel();
    const brief = buildNarrativeChain(model).brief;

    expect(brief.uncertainty.sourceWarnings).toEqual(model.sourceWarnings);
  });

  it('keeps hour provisionality for an unknown-time chart', () => {
    const brief = buildNarrativeChain(unknownTimeModel()).brief;

    expect(brief.subject.birthTimeKnown).toBe(false);
    expect(brief.uncertainty.birthTimeKnown).toBe(false);
    expect(brief.uncertainty.provisionalFields.bazi).toContain('hour');
    expect(brief.uncertainty.provisionalFields.natal).toContain('hour');
    expect(brief.uncertainty.provisionalFactIds.length).toBeGreaterThan(0);
    expect(
      brief.uncertainty.provisionalFactIds.every((id) => id.includes('hour')),
    ).toBe(true);
  });

  it('states no provisionality for a known-time chart', () => {
    const brief = buildNarrativeChain(knownTimeModel()).brief;

    expect(brief.uncertainty.birthTimeKnown).toBe(true);
    expect(brief.uncertainty.provisionalFactIds).toEqual([]);
    expect(brief.uncertainty.provisionalFields.bazi).toEqual([]);
    expect(brief.uncertainty.provisionalFields.natal).toEqual([]);
  });
});
