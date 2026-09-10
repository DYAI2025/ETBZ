import { describe, expect, it } from 'vitest';
import { composeDeterministicNarrative } from '../../src/application/interpretation/deterministic-narrative-provider.js';
import { ReportError } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import { SPECIFICITY_POLICY } from '../../src/application/interpretation/specificity-policy.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 F — the first structural QA gate for specificity, synthesis and size.
 *
 * A report that would fit any chart is one failure mode this gate exists for;
 * a report that publishes the whole structural index as chapters is the other.
 * Each case below is a real shape a lazy, generic or over-eager provider
 * produces: one paragraph, a handful of citations, several sections that each
 * restate one kind of fact, or more chapters than a compact report may carry.
 *
 * The last group is the counterexample: a report sitting EXACTLY on the floor
 * must pass, and the deterministic provider's own full answer must pass, so the
 * gate cannot be satisfied by being permanently red.
 */

const MODEL = knownTimeModel();
const CHAIN = buildNarrativeChain(MODEL);
const FACTS_BY_ID = new Map(CHAIN.featureSet.facts.map((fact) => [fact.id, fact]));

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

/**
 * Narrows a section to citations of ONE fact kind, so a report can be built
 * that carries plenty of material and still synthesises nothing.
 */
function citeOnlyKind(section: MutableSection, kind: string, limit: number): void {
  const narrowed = section.citedFacts
    .filter((cited) => FACTS_BY_ID.get(cited.factId)?.kind === kind)
    .slice(0, limit);
  if (narrowed.length !== limit) {
    throw new Error(
      `fixture defect: section "${section.themeId}" carries ${String(narrowed.length)} facts of kind "${kind}", needed ${String(limit)}`,
    );
  }
  section.citedFacts = narrowed;
}

/** Prose that names no chart symbol at all — a genuinely generic paragraph. */
const GENERIC_PROSE =
  'Dieser Abschnitt beschreibt allgemeine Tendenzen, die auf viele Menschen zutreffen koennen.';

/** The three primary themes used wherever a report must sit on the floor. */
const FLOOR_THEMES = [
  'primary.elemental_profile',
  'primary.positional_context',
  'primary.seasonal_anchor',
];

function build(output: MutableOutput): void {
  buildReportModel({ model: MODEL, brief: CHAIN.brief, providerOutput: output });
}

function expectRefusal(code: string, output: MutableOutput): ReportError {
  try {
    build(output);
  } catch (error) {
    if (error instanceof ReportError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  expect.unreachable(`expected the report to be refused with ${code}`);
}

function expectSpecificityRefusal(output: MutableOutput): ReportError {
  return expectRefusal('REPORT_INSUFFICIENT_SPECIFICITY', output);
}

describe('ETBZ-25 F1: a generic report is refused', () => {
  it('refuses a single-paragraph report', () => {
    const output = keepThemes(['primary.positional_context']);

    const error = expectSpecificityRefusal(output);
    expect(error.message).toContain('sections');
    expect(error.message).toContain(String(SPECIFICITY_POLICY.minSections));
  });

  it('refuses a report that carries one section fewer than the floor', () => {
    // The floor is a real edge, not a slogan: minSections - 1 is refused and
    // minSections is accepted (asserted in F3 below).
    const output = keepThemes(FLOOR_THEMES.slice(0, SPECIFICITY_POLICY.minSections - 1));
    expect(output.sections.length).toBe(SPECIFICITY_POLICY.minSections - 1);

    expectSpecificityRefusal(output);
  });

  it('refuses a report that cites too few distinct chart facts', () => {
    // Enough sections, one citation each, and prose that names nothing specific.
    const output = keepThemes(FLOOR_THEMES);
    output.sections.forEach((section, index) => {
      section.citedFacts = section.citedFacts.slice(0, 1);
      section.prose = `${GENERIC_PROSE} Variante ${String.fromCharCode(65 + index)}.`;
    });
    const distinct = new Set(
      output.sections.flatMap((section) => section.citedFacts.map((cited) => cited.factId)),
    );
    expect(distinct.size).toBeLessThan(SPECIFICITY_POLICY.minDistinctCitedFacts);

    const error = expectSpecificityRefusal(output);
    expect(error.message).toContain('distinct chart facts');
  });

  it('refuses a report in which no section combines different kinds of fact', () => {
    // Every section restates ONE kind of fact, so there is plenty of material
    // and no synthesis anywhere.
    const output = keepThemes(FLOOR_THEMES);
    const kindPerTheme: Readonly<Record<string, string>> = {
      'primary.elemental_profile': 'wu_xing_weight',
      'primary.positional_context': 'pillar_stem',
      'primary.seasonal_anchor': 'month_command_branch',
    };
    output.sections.forEach((section, index) => {
      const kind = kindPerTheme[section.themeId] ?? '';
      citeOnlyKind(section, kind, kind === 'month_command_branch' ? 1 : 2);
      section.prose = `${GENERIC_PROSE} Variante ${String.fromCharCode(65 + index)}.`;
    });
    const kindsPerSection = output.sections.map(
      (section) =>
        new Set(section.citedFacts.map((cited) => FACTS_BY_ID.get(cited.factId)?.kind ?? '')).size,
    );
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
  it('refuses sections that carry the identical paragraph', () => {
    // Every count is satisfied - enough sections, many distinct facts,
    // synthesis present - and the report is still generic, because it says one
    // thing three times. Counting alone cannot see that.
    const output = keepThemes(FLOOR_THEMES);
    for (const section of output.sections) {
      section.prose = GENERIC_PROSE;
    }

    expectRefusal('REPORT_DUPLICATE_PROSE', output);
  });

  it('accepts the same sections when each carries its own paragraph', () => {
    const output = keepThemes(FLOOR_THEMES);
    const proses = output.sections.map((section) => section.prose);

    expect(new Set(proses).size).toBe(proses.length);
    expect(() => { build(output); }).not.toThrow();
  });
});

describe('ETBZ-25 F2: an oversized report is refused', () => {
  it('refuses more sections than the compact-report ceiling', () => {
    const output = draft();
    const first = output.sections[0];
    const second = output.sections[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    // Two more chapters than the four primary themes this chart has.
    output.sections.push(structuredClone(first), structuredClone(second));
    expect(output.sections.length).toBeGreaterThan(SPECIFICITY_POLICY.maxSections);

    const error = expectRefusal('REPORT_TOO_MANY_SECTIONS', output);
    expect(error.message).toContain(String(SPECIFICITY_POLICY.maxSections));
  });

  it('does not fire on a report sitting exactly on the ceiling', () => {
    // maxSections sections is allowed, so the ceiling is an edge rather than a
    // blanket refusal of anything longer than the provider happens to emit.
    // This chart has four primary themes, so a fifth section can only be a
    // repeat - and it is then refused for BEING a repeat, not for the count.
    const output = draft();
    const first = output.sections[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    output.sections.push(structuredClone(first));
    expect(output.sections.length).toBe(SPECIFICITY_POLICY.maxSections);

    expectRefusal('REPORT_DUPLICATE_THEME_SECTION', output);
  });
});

describe('ETBZ-25 F3: the gate is passable, not permanently red', () => {
  it('accepts a report sitting exactly on the policy floor', () => {
    const output = keepThemes(FLOOR_THEMES);
    expect(output.sections.length).toBe(SPECIFICITY_POLICY.minSections);

    const report = buildReportModel({
      model: MODEL,
      brief: CHAIN.brief,
      providerOutput: output,
    });

    expect(report.interpretation.map((section) => section.themeId)).toEqual(FLOOR_THEMES);
    const distinct = new Set(report.interpretation.flatMap((section) => section.citedFactIds));
    expect(distinct.size).toBeGreaterThanOrEqual(SPECIFICITY_POLICY.minDistinctCitedFacts);
  });

  it('accepts the deterministic provider’s full answer, inside both bounds', () => {
    const output = draft();

    expect(output.sections.length).toBeGreaterThanOrEqual(SPECIFICITY_POLICY.minSections);
    expect(output.sections.length).toBeLessThanOrEqual(SPECIFICITY_POLICY.maxSections);
    expect(() => { build(output); }).not.toThrow();
  });
});
