import { describe, expect, it } from 'vitest';
import { composeDeterministicNarrative } from '../../src/application/interpretation/deterministic-narrative-provider.js';
import { ReportError } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import { SPECIFICITY_POLICY } from '../../src/application/interpretation/specificity-policy.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 F — the first structural QA gate for specificity and synthesis.
 *
 * A report that would fit any chart is the failure mode this gate exists for.
 * Each case below is a real shape a lazy or generic provider produces: one
 * paragraph, a handful of citations, or several sections that each restate one
 * kind of fact and never combine anything.
 *
 * The last case is the counterexample: a report sitting EXACTLY on the floor
 * must pass, so the gate cannot be satisfied by being permanently red.
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

function keepThemes(themeIds: readonly string[]): MutableOutput {
  const output = draft();
  const kept = themeIds.map((themeId) => {
    const section = output.sections.find((candidate) => candidate.themeId === themeId);
    if (section === undefined) {
      throw new Error(`fixture defect: no section for "${themeId}"`);
    }
    return section;
  });
  output.sections = kept;
  return output;
}

/** Prose that names no chart symbol at all — a genuinely generic paragraph. */
const GENERIC_PROSE =
  'Dieser Abschnitt beschreibt allgemeine Tendenzen, die auf viele Menschen zutreffen koennen.';

function build(output: MutableOutput): void {
  buildReportModel({ model: MODEL, brief: CHAIN.brief, providerOutput: output });
}

function expectSpecificityRefusal(output: MutableOutput): ReportError {
  try {
    build(output);
  } catch (error) {
    if (error instanceof ReportError) {
      expect(error.code).toBe('REPORT_INSUFFICIENT_SPECIFICITY');
      return error;
    }
    throw error;
  }
  expect.unreachable('a generic report must be refused');
}

describe('ETBZ-25 F1: a generic report is refused', () => {
  it('refuses a single-paragraph report', () => {
    const output = keepThemes(['theme.pillar.year']);

    const error = expectSpecificityRefusal(output);
    expect(error.message).toContain('sections');
  });

  it('refuses a report that cites too few distinct chart facts', () => {
    // Two sections, one citation each, and prose that names nothing specific.
    const output = keepThemes(['theme.wuXing.Erde', 'theme.tenGod.RobWealth']);
    for (const section of output.sections) {
      section.prose = GENERIC_PROSE;
    }
    const distinct = new Set(
      output.sections.flatMap((section) => section.citedFacts.map((cited) => cited.factId)),
    );
    expect(distinct.size).toBeLessThan(SPECIFICITY_POLICY.minDistinctCitedFacts);

    const error = expectSpecificityRefusal(output);
    expect(error.message).toContain('distinct chart facts');
  });

  it('refuses a report in which no section combines different kinds of fact', () => {
    // Both themes group Ten God facts of ONE kind, so there is enough material
    // but no synthesis anywhere: every section restates a single kind.
    const output = keepThemes(['theme.tenGod.SevenKilling', 'theme.tenGod.IndirectRes']);
    const kindsPerSection = output.sections.map((section) => {
      const kinds = new Set(
        section.citedFacts.map((cited) => {
          const fact = CHAIN.featureSet.facts.find((candidate) => candidate.id === cited.factId);
          return fact?.kind ?? '';
        }),
      );
      return kinds.size;
    });
    expect(Math.max(...kindsPerSection)).toBeLessThan(SPECIFICITY_POLICY.minSynthesisFactKinds);
    const distinct = new Set(
      output.sections.flatMap((section) => section.citedFacts.map((cited) => cited.factId)),
    );
    expect(distinct.size).toBeGreaterThanOrEqual(SPECIFICITY_POLICY.minDistinctCitedFacts);

    const error = expectSpecificityRefusal(output);
    expect(error.message).toContain('combining at least');
  });
});

describe('ETBZ-25 F1b: one paragraph reused under several themes is boilerplate', () => {
  it('refuses two sections that carry the identical paragraph', () => {
    // Every count is satisfied - two sections, many distinct facts, synthesis
    // present - and the report is still generic, because it says one thing
    // twice. Counting alone cannot see that.
    const output = keepThemes(['theme.pillar.year', 'theme.pillar.month']);
    for (const section of output.sections) {
      section.prose = GENERIC_PROSE;
    }

    try {
      build(output);
      expect.unreachable('a repeated paragraph must be refused');
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      expect(error.code).toBe('REPORT_DUPLICATE_PROSE');
    }
  });

  it('accepts the same two sections when each carries its own paragraph', () => {
    const output = keepThemes(['theme.pillar.year', 'theme.pillar.month']);
    const proses = output.sections.map((section) => section.prose);

    expect(new Set(proses).size).toBe(proses.length);
    expect(() => { build(output); }).not.toThrow();
  });
});

describe('ETBZ-25 F2: the gate is passable, not permanently red', () => {
  it('accepts a report sitting exactly on the policy floor', () => {
    const output = keepThemes(['theme.pillar.year', 'theme.pillar.month']);
    expect(output.sections.length).toBe(SPECIFICITY_POLICY.minSections);

    const report = buildReportModel({
      model: MODEL,
      brief: CHAIN.brief,
      providerOutput: output,
    });

    expect(report.interpretation.map((section) => section.themeId)).toEqual([
      'theme.pillar.year',
      'theme.pillar.month',
    ]);
    const distinct = new Set(report.interpretation.flatMap((section) => section.citedFactIds));
    expect(distinct.size).toBeGreaterThanOrEqual(SPECIFICITY_POLICY.minDistinctCitedFacts);
  });

  it('accepts the deterministic provider’s full answer', () => {
    expect(() => build(draft())).not.toThrow();
  });
});
