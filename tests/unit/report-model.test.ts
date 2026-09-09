import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_NARRATIVE_PROVIDER_ID,
  composeDeterministicNarrative,
  createDeterministicNarrativeProvider,
} from '../../src/application/interpretation/deterministic-narrative-provider.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type { ReportModel } from '../../src/application/interpretation/report-model.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import { ALTERNATE_TEN_GOD_ROW } from '../support/natalFixture.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 D — ReportModel.
 *
 * The report is the sellable artefact. What is asserted here is that it is
 * SEPARATED (facts, interpretation, uncertainty, method notes never merge),
 * BOUND (every section points at facts of this chart), DETERMINISTIC (same
 * chart, same report, same hash) and SENSITIVE (a relevant change moves the
 * hash, a volatile source timestamp does not).
 */

function reportFor(model: HoroscopeModel): ReportModel {
  const chain = buildNarrativeChain(model);
  return buildReportModel({
    model,
    brief: chain.brief,
    providerOutput: composeDeterministicNarrative(chain.brief),
  });
}

describe('ETBZ-25 D1: the report separates its four blocks', () => {
  it('carries facts, interpretation, uncertainty and method notes as distinct blocks', () => {
    const report = reportFor(knownTimeModel());

    expect(Object.keys(report).sort()).toEqual([
      'canonicalJson',
      'facts',
      'interpretation',
      'methodNotes',
      'provenance',
      'reportVersion',
      'structuralHash',
      'subject',
      'uncertainty',
    ]);
    expect(report.reportVersion).toBe('etbz-25.report-model.v1');
  });

  it('keeps provider prose out of the facts block and facts out of the prose block', () => {
    const report = reportFor(knownTimeModel());

    const factsText = JSON.stringify(report.facts);
    for (const section of report.interpretation) {
      expect(factsText).not.toContain(section.prose);
    }
    for (const fact of report.facts.chart) {
      expect(fact.path.length).toBeGreaterThan(0);
      expect(Object.keys(fact)).not.toContain('prose');
    }
  });

  it('keeps source-owned uncertainty apart from provider-authored notes', () => {
    const model = unknownTimeModel();
    const report = reportFor(model);

    // Source-owned: FuFirE's array, verbatim.
    expect(report.uncertainty.sourceWarnings).toEqual(model.sourceWarnings);
    // Provider-owned: separately labelled, never mixed into the warnings.
    expect(report.uncertainty.providerNotes.length).toBeGreaterThan(0);
    for (const note of report.uncertainty.providerNotes) {
      expect(report.uncertainty.sourceWarnings).not.toContain(note.notes[0]);
    }
  });

  it('states the unimplemented methods as method notes rather than omitting them', () => {
    const notEvaluated = reportFor(knownTimeModel()).methodNotes.filter(
      (note) => note.status === 'not_evaluated',
    );

    expect(notEvaluated.map((note) => note.methodId)).toEqual(
      expect.arrayContaining(['day_master_strength', 'useful_god', 'luck_pillars']),
    );
    expect(notEvaluated.every((note) => note.reason === 'insufficient_method_scope')).toBe(true);
  });
});

describe('ETBZ-25 D2: every section is bound to facts of this chart', () => {
  it('cites only allowed facts, and only facts of the section theme', () => {
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const report = reportFor(model);
    const themesById = new Map(
      chain.primaryThemeProjection.primaryThemes.map((theme) => [theme.id, theme]),
    );

    expect(report.interpretation.length).toBeGreaterThanOrEqual(2);
    for (const section of report.interpretation) {
      const theme = themesById.get(section.themeId);
      expect(theme, section.themeId).toBeDefined();
      expect(section.citedFactIds.length).toBeGreaterThan(0);
      expect(section.prose.trim().length).toBeGreaterThan(0);
      for (const factId of section.citedFactIds) {
        expect(chain.featureSet.factIds).toContain(factId);
        expect(theme?.factIds).toContain(factId);
      }
    }
  });

  it('publishes one section per PRIMARY theme, not one per candidate theme', () => {
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const report = reportFor(model);

    expect(report.interpretation.map((section) => section.themeId)).toEqual(
      chain.primaryThemeProjection.primaryThemes.map((theme) => theme.id),
    );
    // The distinction is real on this chart: the candidate graph carries many
    // more nodes than the report carries chapters.
    expect(chain.themeGraph.themes.length).toBeGreaterThan(report.interpretation.length);
    expect(report.interpretation.length).toBeLessThanOrEqual(
      chain.brief.constraints.specificity.maxSections,
    );
    expect(report.interpretation.length).toBeGreaterThanOrEqual(
      chain.brief.constraints.specificity.minSections,
    );
  });

  it('carries the candidate themes each chapter groups, with their source labels', () => {
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const report = reportFor(model);
    const candidatesById = new Map(chain.themeGraph.themes.map((theme) => [theme.id, theme]));

    for (const section of report.interpretation) {
      expect(section.sourceThemeIds.length, section.themeId).toBeGreaterThan(0);
      expect(section.sourceThemeLabels.length).toBe(section.sourceThemeIds.length);
      section.sourceThemeIds.forEach((sourceId, index) => {
        // The label is the candidate theme's own, which theme-graph.ts has
        // already tied back to a HoroscopeModel value: no ETBZ step in between.
        expect(section.sourceThemeLabels[index], sourceId).toBe(
          candidatesById.get(sourceId)?.label,
        );
      });
    }
  });

  it('binds the report to the primary projection it was built from', () => {
    const model = knownTimeModel();

    expect(reportFor(model).provenance.primaryThemeProjectionStructuralHash).toBe(
      buildNarrativeChain(model).primaryThemeProjection.structuralHash,
    );
  });

  it('records which provider produced the interpretation', () => {
    expect(reportFor(knownTimeModel()).provenance.providerId).toBe(
      DETERMINISTIC_NARRATIVE_PROVIDER_ID,
    );
  });

  it('accepts the same output through the async port', async () => {
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const provider = createDeterministicNarrativeProvider();

    const output = await provider.generate(chain.brief);
    const report = buildReportModel({ model, brief: chain.brief, providerOutput: output });

    expect(report.provenance.providerId).toBe(provider.id);
    expect(report.structuralHash).toBe(reportFor(model).structuralHash);
  });
});

describe('ETBZ-25 D3: the report hash is deterministic and sensitive', () => {
  it('is the plain sha256 of the canonical text published next to it', () => {
    // A hash nobody can re-derive from the artefact it ships with is not
    // evidence. This asserts the exact property an independent verifier would
    // check: sha256 of report.canonicalJson, computed with node:crypto.
    const model = knownTimeModel();
    const report = reportFor(model);
    const chain = buildNarrativeChain(model);

    expect(report.structuralHash).toBe(
      `sha256:${createHash('sha256').update(report.canonicalJson, 'utf8').digest('hex')}`,
    );
    // The same must hold for the chart anchor the whole chain hangs from.
    expect(chain.featureSet.sourceStructuralHash).toBe(
      `sha256:${createHash('sha256').update(model.canonicalJson, 'utf8').digest('hex')}`,
    );
    expect(report.facts.sourceStructuralHash).toBe(chain.featureSet.sourceStructuralHash);
  });

  it('is identical for an identical chart', () => {
    expect(reportFor(knownTimeModel()).structuralHash).toBe(
      reportFor(knownTimeModel()).structuralHash,
    );
  });

  it('ignores the two volatile source timestamps, and keeps them as evidence', () => {
    const base = knownTimeModel();
    const later = knownTimeModel({
      bazi: { provenance: { computationTimestamp: '2027-01-01T00:00:00.000000+00:00' } },
      natal: { provenance: { computedAt: '2027-01-01T00:00:00Z' } },
    });

    expect(reportFor(later).structuralHash).toBe(reportFor(base).structuralHash);
    // Preserved, not deleted: the report still carries what the source said.
    expect(reportFor(later).provenance.computationTimestamp).toBe(
      '2027-01-01T00:00:00.000000+00:00',
    );
    expect(reportFor(later).provenance.natalComputedAt).toBe('2027-01-01T00:00:00Z');
  });

  it('changes when a theme changes (a different Ten God row)', () => {
    const base = reportFor(knownTimeModel());
    const drifted = reportFor(
      knownTimeModel({ natal: { pillars: { hour: { tenGod: ALTERNATE_TEN_GOD_ROW } } } }),
    );

    expect(drifted.structuralHash).not.toBe(base.structuralHash);
    expect(drifted.provenance.themeGraphStructuralHash).not.toBe(
      base.provenance.themeGraphStructuralHash,
    );
  });

  it('carries duplicate and unknown warning codes into the report in source order', () => {
    // FuFirE's array is EVIDENCE, and it survives the primary projection
    // unchanged: no deduplication, no sorting, no reclassification of a code
    // ETBZ does not recognise.
    const warnings = ['DAY_ANCHOR_UNVERIFIED', 'AN_UNKNOWN_CODE', 'DAY_ANCHOR_UNVERIFIED'];
    const model = knownTimeModel({ natal: { warnings } });

    expect(model.sourceWarnings).toEqual(warnings);
    expect(reportFor(model).uncertainty.sourceWarnings).toEqual(warnings);
  });

  it('changes when a source warning changes', () => {
    const base = reportFor(knownTimeModel({ natal: { warnings: ['DAY_ANCHOR_UNVERIFIED'] } }));
    const extra = reportFor(
      knownTimeModel({ natal: { warnings: ['DAY_ANCHOR_UNVERIFIED', 'ANOTHER_CODE'] } }),
    );

    expect(extra.structuralHash).not.toBe(base.structuralHash);
    expect(extra.uncertainty.sourceWarnings).toEqual([
      'DAY_ANCHOR_UNVERIFIED',
      'ANOTHER_CODE',
    ]);
  });

  it('keeps every non-volatile field inside the hash anchor', () => {
    // The canonical anchor is a hand-written allowlist. Without this assertion a
    // newly added field would silently fall OUTSIDE the hash, and a real change
    // to it would leave the report hash unmoved.
    const report = reportFor(knownTimeModel());
    const anchored = JSON.parse(report.canonicalJson) as Record<string, unknown>;

    expect(Object.keys(anchored).sort()).toEqual([
      'facts',
      'interpretation',
      'methodNotes',
      'provenance',
      'reportVersion',
      'subject',
      'uncertainty',
    ]);
    // Exactly the two volatile source timestamps are outside, and nothing else.
    const anchoredProvenance = Object.keys(anchored['provenance'] as Record<string, unknown>);
    const outside = Object.keys(report.provenance).filter(
      (key) => !anchoredProvenance.includes(key),
    );
    expect(outside.sort()).toEqual(['computationTimestamp', 'natalComputedAt']);
  });

  it('moves when only the interpretation changes', () => {
    // The chart is identical; only the provider's answer differs. A report hash
    // that ignored the narrative would make two different products share one
    // identity.
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const full = composeDeterministicNarrative(chain.brief);
    const shorter = {
      ...full,
      sections: full.sections.slice(0, 3),
    };

    const a = buildReportModel({ model, brief: chain.brief, providerOutput: full });
    const b = buildReportModel({ model, brief: chain.brief, providerOutput: shorter });

    expect(b.facts.sourceStructuralHash).toBe(a.facts.sourceStructuralHash);
    expect(b.structuralHash).not.toBe(a.structuralHash);
  });

  it('binds the report to the chart it was built from', () => {
    const model = knownTimeModel();
    const report = reportFor(model);
    const chain = buildNarrativeChain(model);

    expect(report.facts.sourceCanonicalJson).toBe(model.canonicalJson);
    expect(report.provenance.briefStructuralHash).toBe(chain.brief.structuralHash);
    expect(report.provenance.featureSetStructuralHash).toBe(chain.featureSet.structuralHash);
  });
});

describe('ETBZ-25 D4: known time and unknown time are different reports', () => {
  it('keeps a known-time report free of provisional claims', () => {
    const report = reportFor(knownTimeModel());

    expect(report.uncertainty.birthTimeKnown).toBe(true);
    expect(report.uncertainty.provisionalFactIds).toEqual([]);
    expect(report.interpretation.every((section) => !section.citesProvisionalFacts)).toBe(true);
    expect(report.uncertainty.providerNotes).toEqual([]);
    expect(report.subject.birth.time).toBe('14:30:00');
  });

  it('carries hour provisionality all the way into the unknown-time report', () => {
    const report = reportFor(unknownTimeModel());

    expect(report.uncertainty.birthTimeKnown).toBe(false);
    expect(report.subject.birth.time).toBeUndefined();
    expect(report.uncertainty.provisionalFields.bazi).toContain('hour');
    expect(report.uncertainty.provisionalFields.natal).toContain('hour');
    expect(report.uncertainty.provisionalFactIds.length).toBeGreaterThan(0);

    const provisionalSections = report.interpretation.filter(
      (section) => section.citesProvisionalFacts,
    );
    expect(provisionalSections.length).toBeGreaterThan(0);
    // Every section that leans on a provisional fact says so in the report.
    for (const section of provisionalSections) {
      const note = report.uncertainty.providerNotes.find(
        (candidate) => candidate.themeId === section.themeId,
      );
      expect(note, section.themeId).toBeDefined();
      expect(note?.notes.length).toBeGreaterThan(0);
    }
    // And FuFirE's own unknown-time warning is still there, verbatim.
    expect(report.uncertainty.sourceWarnings).toContain('BIRTH_TIME_UNKNOWN');
  });

  it('produces different reports for the two certainty levels', () => {
    expect(reportFor(unknownTimeModel()).structuralHash).not.toBe(
      reportFor(knownTimeModel()).structuralHash,
    );
  });
});
