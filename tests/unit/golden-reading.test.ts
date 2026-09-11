import { describe, expect, it } from 'vitest';
import {
  GOLDEN_READING_VERSION,
  GoldenReadingError,
  buildGoldenReading,
  extractReflectionQuestions,
  renderGoldenReadingText,
} from '../../src/application/interpretation/golden-reading.js';
import type {
  GoldenReading,
  GoldenReadingSection,
} from '../../src/application/interpretation/golden-reading.js';
import { NOT_EVALUATED_METHOD_IDS } from '../../src/application/interpretation/method-scope.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type { ReportModel } from '../../src/application/interpretation/report-model.js';
import {
  NARRATIVE_QA_POLICY,
  runSemanticNarrativeQa,
} from '../../src/application/interpretation/semantic-qa.js';
import type { NarrativeQaResult } from '../../src/application/interpretation/semantic-qa.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import {
  validKnownTimeAnswer,
  validUnknownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type { FixtureAnswer, FixtureSection } from '../support/llmNarrativeFixture.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B G — the Golden Reading: the artefact a HUMAN judges.
 *
 * Acceptance criterion 8 ends the slice at a person answering
 * `SELLABLE | NOT_SELLABLE`. That judgement is only worth something if the text
 * in front of the reviewer is provably the text the gates cleared — so what is
 * asserted here is not "a reading was produced" but the four properties that
 * make a reading REVIEWABLE EVIDENCE rather than a rendering:
 *
 *  1. COMPLETE AND ORDERED. Exactly the seven Product Owner blocks, in the
 *     Product Owner's order. A reading missing a block, or reordering them, is
 *     a different product and the reviewer would be judging something else.
 *  2. FAIL-CLOSED. A reading is never assembled on a verdict that was computed
 *     for a different report, and never on a BLOCKED verdict. Both refusals are
 *     tested from a baseline that IS assemblable, changing exactly one thing,
 *     so neither can pass because the guard is simply always red.
 *  3. UNMIXED. Provider prose lives in block 5 and nowhere else. Blocks 1-4 and
 *     7 are chart facts, provenance and scope statements; if provider text
 *     could reach them, "the facts are separated from the interpretation" would
 *     be a claim about intent rather than about the artefact.
 *  4. NON-AUTHORING. Block 6 quotes block 5 and can hold nothing else. A
 *     reflection impulse is extracted from prose that already survived both
 *     gates, so the reading cannot smuggle in an ungated sentence — and when no
 *     section asks a question, the absence is PUBLISHED instead of papered over.
 *
 * Plus the two publication duties the contract names explicitly: a method with
 * no source facts appears in block 7 as a scope statement with its reason, and
 * the rendered text carries all four hashes a reviewer needs to tie the page
 * back to the reading, the report, the brief and the QA verdict it came from.
 *
 * No real person's data is involved: both charts are the synthetic fixtures
 * ETBZ-24 / ETBZ-25A already use.
 */

/** The seven blocks, written out here so a src-side rename fails loudly. */
const EXPECTED_BLOCK_IDS: readonly string[] = [
  'data_basis',
  'four_pillars',
  'day_master',
  'wu_xing',
  'interpretation',
  'reflection',
  'method_and_uncertainty',
];

/** The customer-facing headings, in the same order. */
const EXPECTED_BLOCK_TITLES: readonly string[] = [
  '1. Deine Daten & Berechnungsgrundlage',
  '2. Deine vier Säulen',
  '3. Dein Day Master',
  '4. Deine Wu-Xing-Balance',
  '5. Deine persönliche BaZi-Interpretation',
  '6. Reflexionsimpulse',
  '7. Methodik, Unsicherheit & Hinweise',
];

/** Every block that must contain NO provider prose at all. */
const PROSE_FREE_BLOCK_IDS: readonly string[] = [
  'data_basis',
  'four_pillars',
  'day_master',
  'wu_xing',
  'method_and_uncertainty',
];

/**
 * One phrase per baseline section that appears nowhere but in that section's
 * prose.
 *
 * A "block X contains no provider prose" assertion is only as good as the
 * needle it looks for, so each phrase is first asserted to be IN the prose and
 * in block 5 before its absence elsewhere is asserted — an absence test whose
 * needle does not exist anywhere is green for the wrong reason.
 */
const DISTINCTIVE_PROSE_PHRASES: readonly (readonly [string, string])[] = [
  ['primary.self_role', 'Das erzeugt Reibung'],
  ['primary.seasonal_anchor', 'Aufbruch und sichtbarer Bewegung'],
  ['primary.elemental_profile', 'das schnelle Entflammen'],
  ['primary.positional_context', 'sie melden sich nacheinander'],
];

/**
 * The four questions the verified known-time answer already contains.
 *
 * Written out rather than re-derived with `extractReflectionQuestions`: a test
 * that extracted its own expectation with the function under test would agree
 * with any extractor, including a broken one.
 */
const BASELINE_REFLECTION_QUESTIONS: readonly string[] = [
  'Wo hörst du auf, dich zu vergleichen, und fängst an, zu gestalten?',
  'Was in deinem Leben verdient gerade eher Geduld als einen neuen Start?',
  'Welcher davon verdient deine Kraft?',
  'Welche davon meldet sich bei dir, wenn es eng wird?',
];

function reportFor(model: HoroscopeModel, answer: FixtureAnswer): ReportModel {
  const chain = buildNarrativeChain(model);
  // The structural gate runs first and re-derives the chain from the model, so
  // a report existing at all already proves the answer survived ETBZ-25A.
  return buildReportModel({
    model,
    brief: chain.brief,
    providerOutput: {
      providerId: 'test',
      briefStructuralHash: chain.brief.structuralHash,
      sections: answer.sections,
    },
  });
}

function sectionOf(answer: FixtureAnswer, themeId: string): FixtureSection {
  const section = answer.sections.find((candidate) => candidate.themeId === themeId);
  if (section === undefined) {
    throw new Error(`fixture defect: the valid answer carries no section "${themeId}"`);
  }
  return section;
}

function blockOf(reading: GoldenReading, id: string): GoldenReadingSection {
  const block = reading.sections.find((section) => section.id === id);
  if (block === undefined) {
    throw new Error(`the reading carries no block "${id}"`);
  }
  return block;
}

function bodyTextOf(reading: GoldenReading, id: string): string {
  return blockOf(reading, id).body.join('\n');
}

/** Asserts the refusal AND that it is the refusal the caller meant. */
function expectNotAssemblable(
  report: ReportModel,
  qa: NarrativeQaResult,
  messageFragment: string,
): void {
  try {
    buildGoldenReading(report, qa);
  } catch (error) {
    if (error instanceof GoldenReadingError) {
      expect(error.name).toBe('GoldenReadingError');
      expect(error.code).toBe('GOLDEN_READING_NOT_ASSEMBLABLE');
      expect(error.message).toContain(messageFragment);
      return;
    }
    throw error;
  }
  expect.unreachable('expected the reading to be refused with GoldenReadingError');
}

const KNOWN_REPORT = reportFor(knownTimeModel(), validKnownTimeAnswer());
const KNOWN_QA = runSemanticNarrativeQa(KNOWN_REPORT);
const UNKNOWN_REPORT = reportFor(unknownTimeModel(), validUnknownTimeAnswer());
const UNKNOWN_QA = runSemanticNarrativeQa(UNKNOWN_REPORT);

describe('ETBZ-25B G1: the reading is the seven Product Owner blocks, in order', () => {
  it('assembles a CANDIDATE_READY_FOR_HUMAN_REVIEW reading from the verified known-time answer', () => {
    // The control for this whole file: the baseline really does clear both
    // gates, so every refusal asserted below is caused by its own mutation.
    expect(KNOWN_QA.status).toBe('PASS');
    expect(KNOWN_QA.findings).toEqual([]);

    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    expect(reading.status).toBe('CANDIDATE_READY_FOR_HUMAN_REVIEW');
    expect(reading.goldenReadingVersion).toBe(GOLDEN_READING_VERSION);
  });

  it('publishes exactly the seven blocks the Product Owner listed, in that order', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    expect(reading.sections.map((section) => section.id)).toEqual(EXPECTED_BLOCK_IDS);
    expect(reading.sections).toHaveLength(7);
    expect(new Set(reading.sections.map((section) => section.id)).size).toBe(7);
  });

  it('numbers and titles every block so a reviewer can name what they judged', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    expect(reading.sections.map((section) => section.title)).toEqual(EXPECTED_BLOCK_TITLES);
    for (const section of reading.sections) {
      expect(section.body.length).toBeGreaterThan(0);
      // A block whose every line is blank is a heading, not a block.
      expect(section.body.some((line) => line.trim().length > 0)).toBe(true);
    }
  });

  it('carries the subject, the provider and the three upstream hashes it was assembled from', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    expect(reading.subjectDisplayName).toBe(KNOWN_REPORT.subject.displayName);
    expect(reading.providerId).toBe(KNOWN_REPORT.provenance.providerId);
    expect(reading.reportStructuralHash).toBe(KNOWN_REPORT.structuralHash);
    expect(reading.briefStructuralHash).toBe(KNOWN_REPORT.provenance.briefStructuralHash);
    expect(reading.qaStructuralHash).toBe(KNOWN_QA.structuralHash);
    // The brief the QA verdict names and the brief the report names are the
    // same brief; the reading would otherwise tie two chains together.
    expect(KNOWN_QA.briefStructuralHash).toBe(KNOWN_REPORT.provenance.briefStructuralHash);
    // Four distinct anchors, not one value copied into four fields.
    expect(
      new Set([
        reading.structuralHash,
        reading.reportStructuralHash,
        reading.briefStructuralHash,
        reading.qaStructuralHash,
      ]).size,
    ).toBe(4);
  });

  it('is deterministic: the same report and verdict produce a byte-identical reading', () => {
    const first = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const rebuiltReport = reportFor(knownTimeModel(), validKnownTimeAnswer());
    const second = buildGoldenReading(rebuiltReport, runSemanticNarrativeQa(rebuiltReport));

    expect(second).toEqual(first);
    expect(second.structuralHash).toBe(first.structuralHash);
  });

  it('reads the report without mutating it', () => {
    const before = structuredClone(KNOWN_REPORT);

    buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    expect(KNOWN_REPORT).toEqual(before);
  });

  it('assembles the unknown-time chart too, stating the missing time instead of substituting one', () => {
    expect(UNKNOWN_QA.status).toBe('PASS');
    const reading = buildGoldenReading(UNKNOWN_REPORT, UNKNOWN_QA);

    expect(reading.status).toBe('CANDIDATE_READY_FOR_HUMAN_REVIEW');
    expect(bodyTextOf(reading, 'data_basis')).toContain(
      'Geburtszeit: nicht bekannt — keine Ersatzzeit wurde eingesetzt',
    );
    // Provisionality reaches the reader twice: beside the fact, and as a list.
    expect(bodyTextOf(reading, 'four_pillars')).toContain('[vorläufig]');
    expect(bodyTextOf(reading, 'method_and_uncertainty')).toContain('Geburtszeit bekannt: nein');
    expect(bodyTextOf(reading, 'method_and_uncertainty')).toContain(
      `Vorläufige Fakten: ${UNKNOWN_REPORT.uncertainty.provisionalFactIds.join(', ')}`,
    );
  });
});

describe('ETBZ-25B G2: a reading is never assembled on a foreign or blocked verdict', () => {
  it('accepts the verdict computed for its own report — for BOTH charts (the guard is not always red)', () => {
    expect(() => buildGoldenReading(KNOWN_REPORT, KNOWN_QA)).not.toThrow();
    expect(() => buildGoldenReading(UNKNOWN_REPORT, UNKNOWN_QA)).not.toThrow();
  });

  it('refuses the unknown-time verdict for the known-time report', () => {
    // The premise of this test, measured rather than assumed: two different
    // charts really do produce two different reports.
    expect(UNKNOWN_REPORT.structuralHash).not.toBe(KNOWN_REPORT.structuralHash);
    expect(UNKNOWN_QA.reportStructuralHash).toBe(UNKNOWN_REPORT.structuralHash);
    expect(UNKNOWN_QA.status).toBe('PASS');

    // Only ONE thing differs from the accepted pairing above: the verdict was
    // computed for the other report. It is a PASS, and it is still refused.
    expectNotAssemblable(KNOWN_REPORT, UNKNOWN_QA, 'computed for a different report');
  });

  it('refuses the mirrored pairing too, so the check is on identity and not on chart shape', () => {
    expectNotAssemblable(UNKNOWN_REPORT, KNOWN_QA, 'computed for a different report');
  });

  it('refuses a BLOCKED verdict that does belong to this report', () => {
    // One policy field moved, nothing else: the same report, the same prose,
    // the same gates. The chart-dependence floor is raised above what any
    // reading can name, so this report's verdict flips to BLOCKED.
    const blocked = runSemanticNarrativeQa(KNOWN_REPORT, {
      ...NARRATIVE_QA_POLICY,
      minDistinctChartTermsInProse: 99,
    });

    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.findings).toHaveLength(1);
    // The verdict belongs to this report, so ONLY the status can be the reason
    // for the refusal below.
    expect(blocked.reportStructuralHash).toBe(KNOWN_REPORT.structuralHash);

    expectNotAssemblable(KNOWN_REPORT, blocked, 'blocked this candidate with 1 finding(s)');
  });

  it('refuses a blocked verdict before it looks at anything else, producing nothing partial', () => {
    const blocked = runSemanticNarrativeQa(KNOWN_REPORT, {
      ...NARRATIVE_QA_POLICY,
      minSynthesisSections: 99,
    });

    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.findings.map((finding) => finding.code)).toEqual(['QA_SYNTHESIS_INSUFFICIENT']);
    // No half-assembled reading is returned in place of a refusal.
    expect(() => buildGoldenReading(KNOWN_REPORT, blocked)).toThrow(GoldenReadingError);
  });
});

describe('ETBZ-25B G3: provider prose lives in block 5 and nowhere else', () => {
  it('carries every section of provider prose into block 5 verbatim, with its fact basis', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const block = blockOf(reading, 'interpretation');

    expect(KNOWN_REPORT.interpretation.length).toBeGreaterThan(0);
    for (const section of KNOWN_REPORT.interpretation) {
      // Verbatim: the exact string the gates cleared, not a reflowed copy.
      expect(block.body).toContain(`  ${section.prose}`);
      expect(block.body).toContain(`  [${section.themeFamily}]`);
      expect(block.body).toContain(`  Faktenbasis: ${section.citedFactIds.join(', ')}`);
    }
  });

  it('places each distinctive phrase in block 5 (the needles the absence test uses exist)', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const interpretationText = bodyTextOf(reading, 'interpretation');
    const answer = validKnownTimeAnswer();

    for (const [themeId, phrase] of DISTINCTIVE_PROSE_PHRASES) {
      expect(sectionOf(answer, themeId).prose).toContain(phrase);
      expect(interpretationText).toContain(phrase);
    }
  });

  it('keeps blocks 1-4 and 7 free of provider prose', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    for (const blockId of PROSE_FREE_BLOCK_IDS) {
      const text = bodyTextOf(reading, blockId);
      for (const [, phrase] of DISTINCTIVE_PROSE_PHRASES) {
        expect(text, `block "${blockId}" quotes provider prose`).not.toContain(phrase);
      }
      for (const section of KNOWN_REPORT.interpretation) {
        expect(text).not.toContain(section.prose);
      }
    }
  });

  it('keeps a provider-authored uncertainty note in block 5 and out of block 7', () => {
    const reading = buildGoldenReading(UNKNOWN_REPORT, UNKNOWN_QA);
    const [providerNote] = UNKNOWN_REPORT.uncertainty.providerNotes;
    if (providerNote === undefined) {
      expect.unreachable('fixture defect: the unknown-time answer carries no provider note');
      return;
    }
    const [noteText] = providerNote.notes;
    if (noteText === undefined) {
      expect.unreachable('fixture defect: the provider note is empty');
      return;
    }

    // The provider's own note is published, labelled, next to the prose it
    // qualifies — and never inside the source-owned uncertainty block, where a
    // reader would take it for a FuFirE statement.
    expect(blockOf(reading, 'interpretation').body).toContain(`  Hinweis: ${noteText}`);
    expect(bodyTextOf(reading, 'method_and_uncertainty')).not.toContain(noteText);
    // Source-owned warnings go the other way: block 7, verbatim, unchanged.
    expect(bodyTextOf(reading, 'method_and_uncertainty')).toContain(
      UNKNOWN_REPORT.uncertainty.sourceWarnings.join(', '),
    );
  });
});

describe('ETBZ-25B G4: the reflection block quotes block 5 and cannot author a question', () => {
  it('extracts the question sentences of a paragraph verbatim', () => {
    expect(extractReflectionQuestions('Erste Frage? Zweite Frage?')).toEqual([
      'Erste Frage?',
      'Zweite Frage?',
    ]);
    expect(extractReflectionQuestions('Ein Satz. Und eine Frage? Noch ein Satz.')).toEqual([
      'Und eine Frage?',
    ]);
  });

  it('returns nothing for prose that asks nothing', () => {
    expect(extractReflectionQuestions('Keine Frage. Nur Aussagen!')).toEqual([]);
    expect(extractReflectionQuestions('')).toEqual([]);
    // A bare question mark is punctuation, not an impulse.
    expect(extractReflectionQuestions('?')).toEqual([]);
  });

  it('lists exactly the questions the interpretation already asks', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);

    expect(blockOf(reading, 'reflection').body).toEqual(
      BASELINE_REFLECTION_QUESTIONS.map((question) => `  - ${question}`),
    );
  });

  it('publishes no line that does not already occur in block 5', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const interpretationText = bodyTextOf(reading, 'interpretation');

    const lines = blockOf(reading, 'reflection').body;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const quoted = line.replace(/^ {2}- /u, '');
      // Every line is a bullet carrying a question and nothing else: the prefix
      // really was stripped, and what remains really is a question.
      expect(quoted).not.toBe(line);
      expect(quoted.endsWith('?')).toBe(true);
      expect(interpretationText, 'the reflection block invented a line').toContain(quoted);
    }
  });

  it('drops exactly one impulse when exactly one section stops asking', () => {
    const answer = validKnownTimeAnswer();
    const section = sectionOf(answer, 'primary.self_role');
    const withoutQuestion = section.prose.replace(/\s*[^.!?]*\?$/u, '');
    if (withoutQuestion === section.prose) {
      // A mutation that silently did nothing would leave this test asserting
      // the baseline it was supposed to differ from.
      throw new Error('fixture defect: the baseline section ends in no question');
    }
    section.prose = withoutQuestion;

    const report = reportFor(knownTimeModel(), answer);
    const qa = runSemanticNarrativeQa(report);
    expect(qa.status).toBe('PASS');
    const reading = buildGoldenReading(report, qa);

    expect(blockOf(reading, 'reflection').body).toEqual(
      BASELINE_REFLECTION_QUESTIONS.slice(1).map((question) => `  - ${question}`),
    );
  });

  it('states the absence rather than inventing one when no section asks a question', () => {
    // Every section has to lose its question for this state to exist at all —
    // block 6 is report-wide — so this is the smallest change that reaches it.
    const answer = validKnownTimeAnswer();
    for (const section of answer.sections) {
      const withoutQuestion = section.prose.replace(/\s*[^.!?]*\?$/u, '');
      if (withoutQuestion === section.prose) {
        throw new Error(`fixture defect: section "${section.themeId}" ends in no question`);
      }
      section.prose = withoutQuestion;
    }

    const report = reportFor(knownTimeModel(), answer);
    const qa = runSemanticNarrativeQa(report);
    // Removing a question is not a gate failure: the candidate still passes, so
    // the fallback below is reached by content and not by a refusal.
    expect(qa.status).toBe('PASS');
    const reading = buildGoldenReading(report, qa);

    expect(blockOf(reading, 'reflection').body).toEqual([
      '  Diese Fassung enthält keine ausformulierte Reflexionsfrage.',
      '  ETBZ ergänzt hier keine eigene: Reflexionsimpulse stammen aus dem',
      '  Interpretationstext oder sie fehlen sichtbar.',
    ]);
  });
});

describe('ETBZ-25B G5: an unevaluated method is published as a scope statement', () => {
  it('prints every not_evaluated method in block 7 with its reason and its statement', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const block = blockOf(reading, 'method_and_uncertainty');
    const notEvaluated = KNOWN_REPORT.methodNotes.filter((note) => note.status === 'not_evaluated');

    expect(notEvaluated.length).toBeGreaterThan(0);
    for (const note of notEvaluated) {
      expect(note.reason).toBe('insufficient_method_scope');
      expect(block.body).toContain(
        `  - ${note.methodId} [insufficient_method_scope]: ${note.statement}`,
      );
    }
  });

  it('omits no unevaluated method: block 7 names every id the method scope declares', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const text = bodyTextOf(reading, 'method_and_uncertainty');
    const printed = KNOWN_REPORT.methodNotes
      .filter((note) => note.status === 'not_evaluated')
      .map((note) => note.methodId);

    expect([...printed].sort()).toEqual([...NOT_EVALUATED_METHOD_IDS].sort());
    for (const methodId of NOT_EVALUATED_METHOD_IDS) {
      expect(text, `block 7 omits "${methodId}"`).toContain(
        `  - ${methodId} [insufficient_method_scope]:`,
      );
    }
  });

  it('separates the two lists and says a missing method is not a finding of "nothing"', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const body = blockOf(reading, 'method_and_uncertainty').body;
    const evaluatedHeading = body.indexOf('  Ausgewertete Methoden');
    const notEvaluatedHeading = body.indexOf(
      '  Nicht ausgewertete Methoden (nicht "kein Befund", sondern keine Datengrundlage)',
    );

    expect(evaluatedHeading).toBeGreaterThanOrEqual(0);
    expect(notEvaluatedHeading).toBeGreaterThan(evaluatedHeading);

    // Positive control: the evaluated methods are printed too, above the
    // heading, and WITHOUT a reason bracket — so the bracket asserted above is
    // the not_evaluated marker and not simply how every line looks.
    const evaluated = KNOWN_REPORT.methodNotes.filter((note) => note.status === 'evaluated');
    expect(evaluated.length).toBeGreaterThan(0);
    for (const note of evaluated) {
      const line = `  - ${note.methodId}: ${note.statement}`;
      expect(body).toContain(line);
      expect(body.indexOf(line)).toBeGreaterThan(evaluatedHeading);
      expect(body.indexOf(line)).toBeLessThan(notEvaluatedHeading);
    }
    for (const note of KNOWN_REPORT.methodNotes.filter(
      (entry) => entry.status === 'not_evaluated',
    )) {
      const line = `  - ${note.methodId} [insufficient_method_scope]: ${note.statement}`;
      expect(body.indexOf(line)).toBeGreaterThan(notEvaluatedHeading);
    }
  });
});

describe('ETBZ-25B G6: the rendered text carries every hash a reviewer needs', () => {
  it('prints the reading, report, brief and QA hashes', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const text = renderGoldenReadingText(reading);

    expect(text).toContain(`Reading-Hash : ${reading.structuralHash}`);
    expect(text).toContain(`Report-Hash  : ${KNOWN_REPORT.structuralHash}`);
    expect(text).toContain(`Brief-Hash   : ${KNOWN_REPORT.provenance.briefStructuralHash}`);
    expect(text).toContain(`QA-Hash      : ${KNOWN_QA.structuralHash}`);
    expect(text).toContain(`Provider     : ${KNOWN_REPORT.provenance.providerId}`);
    expect(text).toContain(`ETBZ GOLDEN READING — ${reading.status}`);
  });

  it('prints every block title and every non-blank body line, losing nothing in the flattening', () => {
    const reading = buildGoldenReading(KNOWN_REPORT, KNOWN_QA);
    const text = renderGoldenReadingText(reading);

    for (const section of reading.sections) {
      expect(text).toContain(section.title);
      for (const line of section.body) {
        if (line.trim().length > 0) {
          expect(text, `the rendered text dropped "${line}"`).toContain(line);
        }
      }
    }
  });

  it('renders the unknown-time reading with its own hashes, not the known-time ones', () => {
    const knownText = renderGoldenReadingText(buildGoldenReading(KNOWN_REPORT, KNOWN_QA));
    const unknownReading = buildGoldenReading(UNKNOWN_REPORT, UNKNOWN_QA);
    const unknownText = renderGoldenReadingText(unknownReading);

    expect(unknownText).toContain(`Report-Hash  : ${UNKNOWN_REPORT.structuralHash}`);
    expect(unknownText).toContain(`QA-Hash      : ${UNKNOWN_QA.structuralHash}`);
    expect(unknownText).not.toContain(KNOWN_REPORT.structuralHash);
    expect(knownText).not.toContain(UNKNOWN_REPORT.structuralHash);
  });
});
