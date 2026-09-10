import { describe, expect, it } from 'vitest';
import { composeDeterministicNarrative } from '../../src/application/interpretation/deterministic-narrative-provider.js';
import { ReportError } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import { SPECIFICITY_POLICY } from '../../src/application/interpretation/specificity-policy.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 H — a candidate theme is not a chapter.
 *
 * This is the guard for the defect this slice was repaired for: the candidate
 * ThemeGraph is an exhaustive structural index, and a report that publishes one
 * chapter per candidate node is not a compact reading of a chart, it is the
 * index with paragraphs around it.
 *
 * The candidate themes stay in the brief and a provider may read every one of
 * them. What is refused is naming one as a report section.
 */

const MODEL = knownTimeModel();
const CHAIN = buildNarrativeChain(MODEL);

interface MutableSection {
  themeId: string;
  citedFacts: { factId: string; value: string }[];
  prose: string;
  uncertaintyNotes: string[];
}
interface MutableOutput {
  providerId: string;
  briefStructuralHash: string;
  sections: MutableSection[];
}

function draft(): MutableOutput {
  return structuredClone(composeDeterministicNarrative(CHAIN.brief)) as unknown as MutableOutput;
}

function expectRefusal(code: string, output: MutableOutput): ReportError {
  try {
    buildReportModel({ model: MODEL, brief: CHAIN.brief, providerOutput: output });
  } catch (error) {
    if (error instanceof ReportError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  expect.unreachable(`expected the report to be refused with ${code}`);
}

describe('ETBZ-25 H1: the candidate layer is available but not narratable', () => {
  it('offers every candidate theme to the provider', () => {
    // The precondition of the whole group: nothing was hidden from the
    // provider. Refusing a chapter it could not have seen would be a different,
    // much weaker claim.
    expect(CHAIN.brief.candidateThemes.length).toBe(CHAIN.themeGraph.themes.length);
    expect(CHAIN.brief.candidateThemes.length).toBeGreaterThan(
      SPECIFICITY_POLICY.maxSections,
    );
  });

  it('refuses a section that names a candidate theme id', () => {
    const output = draft();
    const section = output.sections[0];
    expect(section).toBeDefined();
    if (section === undefined) return;
    section.themeId = 'theme.dayMaster';

    const error = expectRefusal('REPORT_CANDIDATE_THEME_NOT_NARRATABLE', output);
    expect(error.message).toContain('theme.dayMaster');
  });

  it('refuses EVERY candidate theme id, not a sampled few', () => {
    // One case would prove one id is refused. The claim is about the layer.
    let checked = 0;
    for (const candidate of CHAIN.brief.candidateThemes) {
      const output = draft();
      const section = output.sections[0];
      if (section === undefined) continue;
      section.themeId = candidate.id;
      expectRefusal('REPORT_CANDIDATE_THEME_NOT_NARRATABLE', output);
      checked += 1;
    }

    expect(checked).toBe(CHAIN.themeGraph.themes.length);
    expect(checked).toBeGreaterThan(SPECIFICITY_POLICY.maxSections);
  });

  it('separates a candidate id from an id no chart carries', () => {
    // A different code, because it is a different mistake: the candidate theme
    // exists and is in the brief, it is simply not a chapter.
    const output = draft();
    const section = output.sections[0];
    expect(section).toBeDefined();
    if (section === undefined) return;
    section.themeId = 'theme.inventedByTheProvider';

    expectRefusal('REPORT_UNKNOWN_THEME', output);
  });
});

describe('ETBZ-25 H2: the ETBZ-25A shape - one chapter per candidate node - is refused', () => {
  it('refuses an answer that narrates the whole candidate graph', () => {
    // This is exactly what the deterministic provider used to emit: one section
    // per ThemeGraph node. It is refused on size before anything else, which is
    // the honest finding - the report is not compact.
    const output = draft();
    output.sections = CHAIN.brief.candidateThemes.map((theme): MutableSection => ({
      themeId: theme.id,
      citedFacts: theme.factIds.map((factId) => {
        const fact = CHAIN.brief.facts.find((candidate) => candidate.id === factId);
        if (fact === undefined) throw new Error(`fixture defect: no fact "${factId}"`);
        return { factId: fact.id, value: fact.value };
      }),
      prose: `Kandidat ${theme.id}.`,
      uncertaintyNotes: [],
    }));
    expect(output.sections.length).toBe(CHAIN.themeGraph.themes.length);

    expectRefusal('REPORT_TOO_MANY_SECTIONS', output);
  });

  it('still refuses that shape when it is trimmed to a legal section count', () => {
    // Trimming the count does not make candidate chapters acceptable: the size
    // gate and the layer gate are two independent refusals, and this proves the
    // second one is not hiding behind the first.
    const output = draft();
    output.sections = CHAIN.brief.candidateThemes
      .slice(0, SPECIFICITY_POLICY.minSections)
      .map((theme): MutableSection => ({
        themeId: theme.id,
        citedFacts: theme.factIds.map((factId) => {
          const fact = CHAIN.brief.facts.find((candidate) => candidate.id === factId);
          if (fact === undefined) throw new Error(`fixture defect: no fact "${factId}"`);
          return { factId: fact.id, value: fact.value };
        }),
        prose: `Kandidat ${theme.id}.`,
        uncertaintyNotes: [],
      }));
    expect(output.sections.length).toBe(SPECIFICITY_POLICY.minSections);

    expectRefusal('REPORT_CANDIDATE_THEME_NOT_NARRATABLE', output);
  });

  it('accepts the primary answer for the same chart (the guard is not always red)', () => {
    const report = buildReportModel({
      model: MODEL,
      brief: CHAIN.brief,
      providerOutput: draft(),
    });

    expect(report.interpretation.map((section) => section.themeId)).toEqual(
      CHAIN.primaryThemeProjection.primaryThemes.map((theme) => theme.id),
    );
  });
});
