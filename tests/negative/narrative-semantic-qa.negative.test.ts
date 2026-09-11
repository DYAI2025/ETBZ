import { describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../../src/application/interpretation/chart-symbol-lexicon.js';
import { NarrativeQaError } from '../../src/application/interpretation/errors.js';
import type { NarrativeQaErrorCode } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type { ReportModel } from '../../src/application/interpretation/report-model.js';
import {
  BARNUM_PHRASES,
  CERTAINTY_TERMS,
  PROHIBITED_CLAIM_CLASSES,
  PROVISIONALITY_TERMS,
} from '../../src/application/interpretation/semantic-qa-lexicon.js';
import {
  NARRATIVE_QA_GATES,
  NARRATIVE_QA_POLICY,
  NARRATIVE_QA_VERSION,
  assertSemanticNarrativeQa,
  runSemanticNarrativeQa,
} from '../../src/application/interpretation/semantic-qa.js';
import type {
  NarrativeQaFinding,
  NarrativeQaGate,
  NarrativeQaResult,
} from '../../src/application/interpretation/semantic-qa.js';
import {
  validKnownTimeAnswer,
  validUnknownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type { FixtureAnswer, FixtureSection } from '../support/llmNarrativeFixture.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B AC-4 — the semantic Narrative QA refuses what the structural gate
 * cannot see.
 *
 * ETBZ-25A proves ATTACHMENT: every sentence is bound to cited facts of this
 * chart. `report-model.ts` names, in its own docblock, the two semantic
 * failures that survive all of that — a cited symbol given the wrong ROLE, and
 * a sentence that asserts CERTAINTY beside a structurally correct uncertainty
 * note — and ETBZ-25B adds three product gates on top (specificity/anti-Barnum,
 * synthesis depth, product safety). This file is the evidence that each of
 * those five gates actually blocks, on a report the structural gate has already
 * accepted.
 *
 * THE METHOD, and why it is the only one that proves anything here:
 *
 *  - Every case starts from `validKnownTimeAnswer()` / `validUnknownTimeAnswer()`,
 *    answers that are verified to pass BOTH gates, and changes EXACTLY ONE
 *    thing. Each refusal is therefore attributable to that one change and to
 *    nothing else — which is why almost every negative asserts the whole
 *    finding list equals a single expected code rather than merely asserting
 *    "BLOCKED".
 *  - The mutated prose must still survive the STRUCTURAL gate, which runs first
 *    and is stricter about symbols, digits and method vocabulary than it is
 *    about meaning. A mutation that tripped `buildReportModel` would prove
 *    nothing about semantic QA, so every mutation below keeps all chart terms
 *    cited and states no number.
 *  - Every negative is accompanied by a POSITIVE CONTROL in the same describe
 *    block: the same shape of sentence, minus the one defect, must pass. A
 *    guard that is always red refuses nothing in particular.
 *  - Prose edits go through `replaceOnce`, which refuses to run when its needle
 *    is missing or ambiguous. Without it a typo would turn a PASS-expecting
 *    control into a test of the unmutated baseline — green, and evidence of
 *    nothing.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It proves the listed forms of each failure are
 * refused, not that every paraphrase of them is: the gates are closed
 * vocabularies and say so. The exhaustiveness assertions below are therefore
 * over the vocabulary the module DECLARES (its gate list, its claim classes),
 * never over the infinite space of sentences.
 */

type FixtureChart = 'known' | 'unknown';
type Mutation = (answer: FixtureAnswer) => void;

const KNOWN = knownTimeModel();
const KNOWN_CHAIN = buildNarrativeChain(KNOWN);
const UNKNOWN = unknownTimeModel();
const UNKNOWN_CHAIN = buildNarrativeChain(UNKNOWN);

const SELF_ROLE = 'primary.self_role';
const SEASONAL = 'primary.seasonal_anchor';
const ELEMENTAL = 'primary.elemental_profile';
const POSITIONAL = 'primary.positional_context';

function baselineAnswer(chart: FixtureChart): FixtureAnswer {
  return chart === 'known' ? validKnownTimeAnswer() : validUnknownTimeAnswer();
}

/** Runs the real structural gate; a mutation it refuses never reaches QA. */
function reportOf(chart: FixtureChart, answer: FixtureAnswer): ReportModel {
  const model = chart === 'known' ? KNOWN : UNKNOWN;
  const chain = chart === 'known' ? KNOWN_CHAIN : UNKNOWN_CHAIN;
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
    throw new Error(`fixture defect: the valid answer has no section "${themeId}"`);
  }
  return section;
}

/**
 * Replaces `needle` once, and REFUSES to do anything else.
 *
 * A silent no-op here would be the worst kind of green: a control that expects
 * PASS would pass by testing the unmutated baseline, and a negative would fail
 * for a reason nobody could read off the assertion.
 */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const first = haystack.indexOf(needle);
  if (first === -1) {
    throw new Error(`fixture defect: "${needle}" does not occur in the baseline text`);
  }
  if (haystack.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`fixture defect: "${needle}" occurs more than once; the edit would be ambiguous`);
  }
  return `${haystack.slice(0, first)}${replacement}${haystack.slice(first + needle.length)}`;
}

function editProse(themeId: string, needle: string, replacement: string): Mutation {
  return (answer) => {
    const section = sectionOf(answer, themeId);
    section.prose = replaceOnce(section.prose, needle, replacement);
  };
}

function appendToProse(themeId: string, sentence: string): Mutation {
  return (answer) => {
    const section = sectionOf(answer, themeId);
    section.prose = `${section.prose} ${sentence}`;
  };
}

function appendToNote(themeId: string, sentence: string): Mutation {
  return (answer) => {
    const section = sectionOf(answer, themeId);
    const note = section.uncertaintyNotes[0];
    if (note === undefined) {
      throw new Error(`fixture defect: section "${themeId}" carries no uncertainty note`);
    }
    section.uncertaintyNotes = [`${note} ${sentence}`, ...section.uncertaintyNotes.slice(1)];
  };
}

interface MutatedRun {
  readonly report: ReportModel;
  readonly qa: NarrativeQaResult;
}

function runMutated(chart: FixtureChart, mutate: Mutation): MutatedRun {
  const answer = baselineAnswer(chart);
  mutate(answer);
  const report = reportOf(chart, answer);
  const qa = runSemanticNarrativeQa(report);
  // The verdict is bound to the exact report it judged: a result carrying some
  // other report's hash would be evidence about some other candidate.
  expect(qa.reportStructuralHash).toBe(report.structuralHash);
  expect(qa.qaVersion).toBe(NARRATIVE_QA_VERSION);
  return { report, qa };
}

interface SingleFinding {
  readonly report: ReportModel;
  readonly finding: NarrativeQaFinding;
}

/**
 * Asserts the mutation produced EXACTLY the expected refusal and nothing else.
 *
 * Comparing the whole code list rather than "contains the code" is the point:
 * one change to a valid answer must produce one finding, and a second finding
 * would mean the case is no longer isolating what its name claims.
 */
function expectSingleFinding(
  chart: FixtureChart,
  mutate: Mutation,
  code: NarrativeQaErrorCode,
): SingleFinding {
  const { report, qa } = runMutated(chart, mutate);
  expect(qa.findings.map((finding) => finding.code)).toEqual([code]);
  expect(qa.status).toBe('BLOCKED');
  // Every gate still RAN. The module reports all findings rather than stopping
  // at the first refusal, and a shortened `gatesRun` would mean the rest of the
  // picture was never computed.
  expect(qa.gatesRun).toEqual(NARRATIVE_QA_GATES);
  const finding = qa.findings[0];
  if (finding === undefined) {
    throw new Error('unreachable: the code list above already asserted one finding');
  }
  expect(finding.severity).toBe('blocking');
  return { report, finding };
}

function expectPasses(chart: FixtureChart, mutate: Mutation): ReportModel {
  const { report, qa } = runMutated(chart, mutate);
  // Findings first: when a control goes red, the finding list is the message
  // that says why, and a bare `status` assertion would hide it.
  expect(qa.findings).toEqual([]);
  expect(qa.status).toBe('PASS');
  return report;
}

/** The normalized text a finding's `surface` label points at. */
function normalizedSurfaceOf(report: ReportModel, themeId: string, surface: string): string {
  if (surface === 'prose') {
    const section = report.interpretation.find((candidate) => candidate.themeId === themeId);
    if (section === undefined) {
      throw new Error(`report has no section "${themeId}"`);
    }
    return normalizeForMatch(section.prose);
  }
  const matched = /^uncertaintyNotes\[(\d+)\]$/u.exec(surface);
  const index = matched?.[1];
  if (index === undefined) {
    throw new Error(`unrecognised surface label "${surface}"`);
  }
  const note = report.uncertainty.providerNotes.find((candidate) => candidate.themeId === themeId);
  const text = note?.notes[Number(index)];
  if (text === undefined) {
    throw new Error(`report has no "${surface}" for section "${themeId}"`);
  }
  return normalizeForMatch(text);
}

/**
 * A finding that carries a span must point AT its term, in the surface it
 * names — the module documents the span as an index into the NORMALIZED text,
 * and an off-by-normalization span would send a human to the wrong character.
 */
function expectSpanQuotesTheTerm(report: ReportModel, finding: NarrativeQaFinding): void {
  const { span, term, themeId, surface } = finding;
  if (span === null || term === null || themeId === null || surface === null) {
    throw new Error(`finding ${finding.code} was expected to be locatable, but carries no span`);
  }
  expect(normalizedSurfaceOf(report, themeId, surface).slice(span.start, span.end)).toBe(term);
}

// ---------------------------------------------------------------------------
// The named mutations. Each one changes a single property of a valid answer and
// is reused by the per-gate describe blocks and by the coverage sweep at the
// end, so the two can never drift apart.
// ---------------------------------------------------------------------------

/** (a) Geng is a stem of this chart; the sentence calls it a branch. */
const nameTheYearStemAsABranch: Mutation = editProse(
  POSITIONAL,
  'der Himmelsstamm Geng',
  'der Erdzweig Geng',
);

/** (b) The hour pillar is provisional in the unknown-time chart. */
function assertCertaintyOverTheProvisionalHour(word: string): Mutation {
  return editProse(
    POSITIONAL,
    'In der Stunde erscheint der Himmelsstamm Yi',
    `In der Stunde erscheint ${word} der Himmelsstamm Yi`,
  );
}

/** (c) A note that is present, legal, and states no unknown at all. */
const NOTE_WITHOUT_UNCERTAINTY =
  'Diese Schicht der Deutung ruht auf einer schmalen Grundlage und wird hier nur angedeutet.';
const replaceTheNoteWithOneThatStatesNothing: Mutation = (answer) => {
  sectionOf(answer, POSITIONAL).uncertaintyNotes = [NOTE_WITHOUT_UNCERTAINTY];
};

/** (d) A canonical Forer statement, inserted verbatim from the lexicon. */
const insertABarnumPhrase: Mutation = appendToProse(SELF_ROLE, 'Tief in dir kennst du das bereits.');

/** (e) A paragraph that would read identically for any chart. */
const replaceProseWithUnanchoredText: Mutation = (answer) => {
  sectionOf(answer, SELF_ROLE).prose =
    'Diese Schicht der Deutung bleibt hier bewusst allgemein gehalten und beschreibt den Ton, in dem du dich selbst wahrnimmst. Was davon erkennst du wieder?';
};

/**
 * (e2) Every chapter still names a cited term — so no chapter is unanchored —
 * but the reading as a whole names only two distinct chart terms. This is the
 * generic reading that anchors nothing while passing every per-section check.
 */
const narrowTheReadingToTwoChartTerms: Mutation = (answer) => {
  // ISOLATING THE REPORT-WIDE HALF of the specificity gate is fiddly on purpose,
  // and the constraints are worth stating because they are what makes the case
  // meaningful rather than incidental:
  //
  //   - every chapter must clear `minChartTermsPerSection`, otherwise the
  //     per-section anchoring check fires first and this stops being a test of
  //     the report-wide floor;
  //   - the reading as a whole must still name FEWER than
  //     `minDistinctChartTermsInProse` distinct terms;
  //   - the structural gate must stay green, which needs at least three sections
  //     and at least four DISTINCT CITED facts.
  //
  // The way to satisfy all three at once is to have the chapters name the SAME
  // small set of terms — `metall`, `xin`, `feuer` — while citing a fourth fact
  // that no sentence mentions. That is exactly the shape the gate exists to
  // catch: a reading that cites enough of the chart and talks about almost none
  // of it.
  answer.sections = [
    {
      themeId: SELF_ROLE,
      citedFacts: [
        { factId: 'chart.dayMaster.element', value: 'Metall' },
        { factId: 'chart.dayMaster.stem', value: 'Xin' },
        // Cited and never named: the fourth distinct fact the structural gate
        // requires, which deliberately adds nothing to the prose.
        { factId: 'chart.dayMaster.polarity', value: 'yin' },
      ],
      prose:
        'Das Element Metall bildet hier den Grundzug, zusammen mit dem Tagesmeister Xin ergibt das eine genaue, eher zurückhaltende Art.',
      uncertaintyNotes: [],
    },
    {
      themeId: POSITIONAL,
      citedFacts: [
        { factId: 'chart.dayMaster.element', value: 'Metall' },
        { factId: 'chart.dayMaster.stem', value: 'Xin' },
      ],
      prose:
        'Auch in den Positionen bleibt das Element Metall der Bezugspunkt, und der Tagesmeister Xin ordnet die Schichten um sich herum.',
      uncertaintyNotes: [],
    },
    {
      themeId: ELEMENTAL,
      citedFacts: [
        { factId: 'chart.dayMaster.element', value: 'Metall' },
        { factId: 'chart.wuxing.dominant', value: 'Feuer' },
      ],
      prose:
        'In der Verteilung steht das Element Feuer vorn, während das Element Metall den ruhigeren Gegenpol hält.',
      uncertaintyNotes: [],
    },
  ];
};

/**
 * (f) The lookup reading: every symbol correctly named and correctly roled, and
 * not one sentence that relates two of them. Synthesis is a property of the
 * whole reading, so no single-chapter edit can produce it — all four chapters
 * have to become lookup entries for the floor of one to be missed.
 */
const LOOKUP_ELEMENTAL =
  'Das Element Feuer trägt in dieser Verteilung das größte Gewicht. Das Element Metall bleibt ruhiger. Das Element Holz steht am dünnsten da.';
const rewriteAsLookupOnly: Mutation = (answer) => {
  sectionOf(answer, SELF_ROLE).prose =
    'Der Tagesmeister Xin bildet den Kern dieser Karte. Sein Element Metall beschreibt die Art, in der er sich zeigt.';
  sectionOf(answer, SEASONAL).prose =
    'Das Monatskommando ruht auf dem Erdzweig Wu. Ihm ist das Tierzeichen Pferd zugeordnet. Der Himmelsstamm Ding steht darin.';
  sectionOf(answer, ELEMENTAL).prose = LOOKUP_ELEMENTAL;
  sectionOf(answer, POSITIONAL).prose =
    'Im Jahr steht der Himmelsstamm Geng. Das Tierzeichen Pferd ist ihm beigeordnet. In der Tagessäule liegt der Erdzweig Hai, dem das Tierzeichen Schwein zugeordnet ist. In der Stunde steht der Himmelsstamm Yi.';
};

/** (g) One prohibited claim, in the class named by the case. */
function insertAProhibitedClaim(sentence: string): Mutation {
  return appendToProse(SELF_ROLE, sentence);
}

/** The four claim classes, one sentence each, each carrying exactly one term. */
const PROHIBITED_CLAIM_CASES: readonly (readonly [string, string, string])[] = [
  ['deterministic_fate', 'Dieser Weg ist vorbestimmt.', 'vorbestimmt'],
  ['medical', 'Dahinter steht eine Erkrankung.', 'erkrankung'],
  ['legal', 'Hier hilft nur ein Anwalt.', 'anwalt'],
  ['financial', 'Aktien bringen dir den entscheidenden Vorteil.', 'aktien'],
];

describe('ETBZ-25B Q0: the unmutated answers pass, so none of these gates is always red', () => {
  it('passes the known-time answer with an empty finding list and every gate run', () => {
    const report = reportOf('known', validKnownTimeAnswer());
    const qa = runSemanticNarrativeQa(report);

    expect(qa.findings).toEqual([]);
    expect(qa.status).toBe('PASS');
    expect(qa.gatesRun).toEqual(NARRATIVE_QA_GATES);
    expect(qa.policy).toEqual(NARRATIVE_QA_POLICY);
    expect(qa.qaVersion).toBe(NARRATIVE_QA_VERSION);
    expect(qa.reportStructuralHash).toBe(report.structuralHash);
    expect(qa.briefStructuralHash).toBe(KNOWN_CHAIN.brief.structuralHash);
  });

  it('passes the unknown-time answer, whose positional chapter really does rest on a provisional fact', () => {
    const report = reportOf('unknown', validUnknownTimeAnswer());
    const qa = runSemanticNarrativeQa(report);

    expect(qa.findings).toEqual([]);
    expect(qa.status).toBe('PASS');
    // Without this the provisionality negatives below would be vacuous: they
    // would be mutating a section the gate never examines.
    const positional = report.interpretation.find((section) => section.themeId === POSITIONAL);
    expect(positional?.citesProvisionalFacts).toBe(true);
  });

  it('returns a byte-identical verdict for the same report twice (the gate reads no clock)', () => {
    const report = reportOf('known', validKnownTimeAnswer());

    expect(runSemanticNarrativeQa(report).structuralHash).toBe(
      runSemanticNarrativeQa(report).structuralHash,
    );
  });

  it('lets the fail-closed wrapper return the PASS result rather than throwing', () => {
    const report = reportOf('known', validKnownTimeAnswer());

    expect(assertSemanticNarrativeQa(report).status).toBe('PASS');
  });
});

describe('ETBZ-25B Q1: a cited symbol may not be given a role its facts do not carry', () => {
  it.each([
    [
      'a stem called a branch',
      POSITIONAL,
      'der Himmelsstamm Geng',
      'der Erdzweig Geng',
      'chart.pillar.year.stem',
      'geng',
    ],
    [
      'a branch called a stem',
      POSITIONAL,
      'Der Erdzweig Hai',
      'Der Himmelsstamm Hai',
      'chart.pillar.day.branch',
      'hai',
    ],
    [
      'an animal tier called an element',
      POSITIONAL,
      'dem das Tierzeichen Schwein zugeordnet ist',
      'dem das Element Schwein zugeordnet ist',
      'chart.pillar.day.tier',
      'schwein',
    ],
    [
      'an element called a branch',
      SELF_ROLE,
      'im Element Metall',
      'im Erdzweig Metall',
      'chart.dayMaster.element',
      'metall',
    ],
  ])('refuses %s, naming the fact and the span it read', (
    _label,
    themeId,
    needle,
    replacement,
    factId,
    term,
  ) => {
    const { report, finding } = expectSingleFinding(
      'known',
      editProse(themeId, needle, replacement),
      'QA_FACT_ROLE_MISMATCH',
    );

    expect(finding.gate).toBe('fact_role');
    expect(finding.themeId).toBe(themeId);
    expect(finding.surface).toBe('prose');
    expect(finding.factId).toBe(factId);
    expect(finding.term).toBe(term);
    expectSpanQuotesTheTerm(report, finding);
  });

  it('refuses a role mismatch in an uncertainty note, not only in prose', () => {
    // A note is published beside the chart facts in the sold artefact, so it
    // can misclassify a symbol exactly as a paragraph can. Yi is the hour stem
    // of this chart; the note calls it a branch.
    const { report, finding } = expectSingleFinding(
      'unknown',
      appendToNote(POSITIONAL, 'Der Erdzweig Yi bleibt offen.'),
      'QA_FACT_ROLE_MISMATCH',
    );

    expect(finding.surface).toBe('uncertaintyNotes[0]');
    expect(finding.themeId).toBe(POSITIONAL);
    expect(finding.factId).toBe('chart.pillar.hour.stem');
    expect(finding.term).toBe('yi');
    expectSpanQuotesTheTerm(report, finding);
  });

  it('accepts the day master named as a plain stem, because that fact carries both roles', () => {
    // The union in ROLES_BY_FACT_KIND is not permissiveness: the day master IS
    // the day stem, so `Himmelsstamm Xin` is as correct as `Tagesmeister Xin`.
    expectPasses('known', editProse(SELF_ROLE, 'Der Tagesmeister Xin', 'Der Himmelsstamm Xin'));
  });

  it('accepts a symbol named with no role word beside it (the gate is conservative)', () => {
    // A sentence that mentions a symbol without classifying it has not
    // misclassified it. `Geng` keeps its citation; only the role word moves out
    // of the window.
    expectPasses(
      'known',
      editProse(
        POSITIONAL,
        'Im Jahr steht der Himmelsstamm Geng, dem das Tierzeichen Pferd beigeordnet ist:',
        'Im Jahr steht Geng; diese Schicht beschreibt Herkunft, und ihr ist das Tierzeichen Pferd beigeordnet:',
      ),
    );
  });

  it('accepts a window in which one named role fits even though another does not', () => {
    // A DELIBERATE limit, asserted so it stays a decision rather than a
    // surprise: the gate refuses only when NO role named near the symbol is one
    // the symbol carries. Here `Polarität` is wrong for Feuer, and `Element`
    // in the same window is right, so nothing is refused.
    expectPasses('known', editProse(ELEMENTAL, 'das größte Gewicht', 'die größte Polarität'));
  });
});

describe('ETBZ-25B Q2: provisionality must survive into the sentence and into the note', () => {
  it.each([
    ['zweifellos', 'zweifellos'],
    ['definitiv', 'definitiv'],
    ['eindeutig', 'eindeutig'],
    ['mit Sicherheit', 'mit sicherheit'],
  ])('refuses prose that launders a provisional fact with "%s"', (word, term) => {
    // The lexicon is the authority on what counts as certainty; a test that
    // invented its own word would pass while proving nothing about the gate.
    expect(CERTAINTY_TERMS).toContain(term);

    const { report, finding } = expectSingleFinding(
      'unknown',
      assertCertaintyOverTheProvisionalHour(word),
      'QA_PROVISIONAL_CERTAINTY',
    );

    expect(finding.gate).toBe('provisionality');
    expect(finding.themeId).toBe(POSITIONAL);
    expect(finding.surface).toBe('prose');
    expect(finding.term).toBe(term);
    expectSpanQuotesTheTerm(report, finding);
  });

  it('refuses an uncertainty note that states no uncertainty at all', () => {
    // The replacement is legal in every other respect - it names no uncited
    // symbol, no number and no unevaluated method, which is why the structural
    // gate hands it through to QA.
    expect(
      PROVISIONALITY_TERMS.some((term) =>
        normalizeForMatch(NOTE_WITHOUT_UNCERTAINTY).includes(term),
      ),
    ).toBe(false);

    const { finding } = expectSingleFinding(
      'unknown',
      replaceTheNoteWithOneThatStatesNothing,
      'QA_PROVISIONAL_NOTE_WITHOUT_UNCERTAINTY',
    );

    expect(finding.gate).toBe('provisionality');
    expect(finding.themeId).toBe(POSITIONAL);
    expect(finding.surface).toBe('uncertaintyNotes[0]');
    // A report-wide vocabulary failure, not a located one: the note as a whole
    // is what says nothing.
    expect(finding.term).toBeNull();
    expect(finding.span).toBeNull();
  });

  it('accepts a differently worded note that still states the uncertainty', () => {
    // The gate asks for uncertainty VOCABULARY, not for the fixture's sentence.
    const reworded = 'Diese Schicht bleibt ungewiss, weil die Stundenangabe fehlt.';
    expect(
      PROVISIONALITY_TERMS.some((term) => normalizeForMatch(reworded).includes(term)),
    ).toBe(true);

    expectPasses('unknown', (answer) => {
      sectionOf(answer, POSITIONAL).uncertaintyNotes = [reworded];
    });
  });

  it('accepts the same certainty word in a chapter that rests on no provisional fact', () => {
    // The gate is scoped to provisional sections on purpose. The known-time
    // chart has no provisional fact, so the identical word is not a refusal
    // there - which is what makes the four refusals above about provisionality
    // rather than about the word.
    const report = expectPasses(
      'known',
      editProse(SELF_ROLE, 'Das erzeugt Reibung', 'Das erzeugt zweifellos Reibung'),
    );

    expect(
      report.interpretation.every((section) => !section.citesProvisionalFacts),
    ).toBe(true);
  });
});

describe('ETBZ-25B Q3: the text itself must depend on this chart', () => {
  it('refuses a chapter whose prose names none of the facts it cites', () => {
    const { finding } = expectSingleFinding(
      'known',
      replaceProseWithUnanchoredText,
      'QA_UNANCHORED_PROSE',
    );

    expect(finding.gate).toBe('specificity');
    expect(finding.themeId).toBe(SELF_ROLE);
    expect(finding.surface).toBe('prose');
    expect(finding.factId).toBeNull();
    expect(finding.span).toBeNull();
  });

  it.each([
    ['tief in dir', 'Tief in dir kennst du das bereits.'],
    ['ungenutztes potenzial', 'Hier liegt ungenutztes Potenzial.'],
    ['wie die meisten menschen', 'Wie die meisten Menschen kennst du das.'],
    ['jeder mensch trägt', 'Jeder Mensch trägt diesen Zug in sich.'],
  ])('refuses the canonical Barnum statement "%s"', (phrase, sentence) => {
    expect(BARNUM_PHRASES).toContain(phrase);

    const { report, finding } = expectSingleFinding(
      'known',
      appendToProse(SELF_ROLE, sentence),
      'QA_BARNUM_PHRASE',
    );

    expect(finding.gate).toBe('specificity');
    expect(finding.themeId).toBe(SELF_ROLE);
    expect(finding.surface).toBe('prose');
    expect(finding.term).toBe(phrase);
    expectSpanQuotesTheTerm(report, finding);
  });

  it('refuses a Barnum statement hidden in an uncertainty note', () => {
    const { report, finding } = expectSingleFinding(
      'unknown',
      appendToNote(POSITIONAL, 'Tief in dir bleibt das offen.'),
      'QA_BARNUM_PHRASE',
    );

    expect(finding.surface).toBe('uncertaintyNotes[0]');
    expect(finding.themeId).toBe(POSITIONAL);
    expect(finding.term).toBe('tief in dir');
    expectSpanQuotesTheTerm(report, finding);
  });

  it('refuses a reading in which every chapter is anchored but the reading names too few chart terms', () => {
    // The report-wide half of the gate. Each chapter passes its own anchoring
    // check; the reading still names only `metall` and `pferd`, so it would
    // read almost identically for a different chart.
    const { finding } = expectSingleFinding(
      'known',
      narrowTheReadingToTwoChartTerms,
      'QA_INSUFFICIENT_CHART_DEPENDENCE',
    );

    expect(finding.gate).toBe('specificity');
    // Report-wide, so it belongs to no chapter and no surface.
    expect(finding.themeId).toBeNull();
    expect(finding.surface).toBeNull();
    // The reading names `metall`, `xin` and `feuer` — three, below the floor of
    // four. The message has to state the measured number, because a refusal that
    // does not say how far short it fell is not actionable.
    expect(finding.message).toContain('names 3 distinct chart terms');
    expect(finding.message).toContain(
      `the policy floor is ${String(NARRATIVE_QA_POLICY.minDistinctChartTermsInProse)}`,
    );
  });

  it('accepts a sentence carrying a Barnum WORD without the Barnum phrase', () => {
    // `BARNUM_PHRASES` matches phrases rather than words precisely so that an
    // ordinary sentence containing `Potenzial` is not refused. Without this
    // control the Barnum refusals above would be consistent with a gate that
    // simply refuses the word.
    expectPasses('known', appendToProse(SELF_ROLE, 'Dein Potenzial zeigt sich hier.'));
  });
});

describe('ETBZ-25B Q4: a reading must relate chart signals, not look them up', () => {
  it('refuses a reading in which no chapter relates two fact roles with a connective', () => {
    const { finding } = expectSingleFinding(
      'known',
      rewriteAsLookupOnly,
      'QA_SYNTHESIS_INSUFFICIENT',
    );

    expect(finding.gate).toBe('synthesis_depth');
    expect(finding.themeId).toBeNull();
    expect(finding.surface).toBeNull();
    expect(finding.message).toContain('carries 0 section(s)');
    expect(finding.message).toContain(
      `the policy floor is ${String(NARRATIVE_QA_POLICY.minSynthesisSections)}`,
    );
  });

  it('still refuses when a connective is present but only one fact role is named', () => {
    // Both halves are required. This chapter says `zusammen mit`, and both
    // symbols it relates are animal tiers - one role, so it relates nothing.
    const { finding } = expectSingleFinding(
      'known',
      (answer) => {
        rewriteAsLookupOnly(answer);
        sectionOf(answer, POSITIONAL).prose =
          'Das Tierzeichen Pferd steht im Jahr, zusammen mit dem Tierzeichen Schwein in der Tagessäule. Beide Schichten melden sich nacheinander.';
      },
      'QA_SYNTHESIS_INSUFFICIENT',
    );

    expect(finding.message).toContain('carries 0 section(s)');
  });

  it('accepts the same lookup reading once one chapter regains a single connective', () => {
    // Exactly one thing differs from the refused reading above: `Gewicht. Das
    // Element Metall bleibt ruhiger.` becomes `Gewicht, während das Element
    // Metall ruhiger bleibt.` The chapter then names two roles (element and
    // weight) and relates them, which is the whole difference between a lookup
    // entry and a reading.
    expectPasses('known', (answer) => {
      rewriteAsLookupOnly(answer);
      const section = sectionOf(answer, ELEMENTAL);
      section.prose = replaceOnce(
        section.prose,
        'das größte Gewicht. Das Element Metall bleibt ruhiger.',
        'das größte Gewicht, während das Element Metall ruhiger bleibt.',
      );
    });
  });
});

describe('ETBZ-25B Q5: a reading may carry no high-risk or deterministic claim', () => {
  it.each(PROHIBITED_CLAIM_CASES)(
    'refuses a %s claim and publishes the class statement with the finding',
    (classId, sentence, term) => {
      const claimClass = PROHIBITED_CLAIM_CLASSES.find(
        (candidate) => candidate.classId === classId,
      );
      if (claimClass === undefined) {
        throw new Error(`lexicon carries no claim class "${classId}"`);
      }
      // The sentence must trip THIS class through a term the lexicon declares,
      // not through a word this test invented.
      expect(claimClass.terms).toContain(term);

      const { report, finding } = expectSingleFinding(
        'known',
        insertAProhibitedClaim(sentence),
        'QA_PROHIBITED_CLAIM',
      );

      expect(finding.gate).toBe('product_safety');
      expect(finding.themeId).toBe(SELF_ROLE);
      expect(finding.surface).toBe('prose');
      expect(finding.term).toBe(term);
      // The refusal has to tell a human WHICH promise the product never makes.
      expect(finding.message).toContain(classId);
      expect(finding.message).toContain(claimClass.statement);
      expectSpanQuotesTheTerm(report, finding);
    },
  );

  it('covers every claim class the lexicon declares', () => {
    // An exhaustiveness claim over the module's own vocabulary: adding a fifth
    // class without a case here turns this test red instead of shipping an
    // untested safety class.
    expect(PROHIBITED_CLAIM_CASES.map(([classId]) => classId).sort()).toEqual(
      PROHIBITED_CLAIM_CLASSES.map((claimClass) => claimClass.classId).slice().sort(),
    );
  });

  it('refuses a prohibited claim in an uncertainty note, not only in prose', () => {
    const { report, finding } = expectSingleFinding(
      'unknown',
      appendToNote(POSITIONAL, 'Ein Anwalt kann das klären.'),
      'QA_PROHIBITED_CLAIM',
    );

    expect(finding.surface).toBe('uncertaintyNotes[0]');
    expect(finding.themeId).toBe(POSITIONAL);
    expect(finding.term).toBe('anwalt');
    expect(finding.message).toContain('legal');
    expectSpanQuotesTheTerm(report, finding);
  });

  it('accepts an ordinary word that merely contains a prohibited term', () => {
    // `gericht` is a prohibited legal term and `ausgerichtet` contains it.
    // Matching is bounded by non-letters, so the reflective sentence survives -
    // without this control the refusals above would be consistent with a gate
    // that refuses every substring and would therefore refuse the product.
    expectPasses('known', appendToProse(SELF_ROLE, 'Du bist darauf ausgerichtet, genau hinzusehen.'));
  });
});

describe('ETBZ-25B Q6: the fail-closed wrapper refuses with every finding, not the first', () => {
  it('throws NarrativeQaError carrying both independent defects of one candidate', () => {
    const answer = validKnownTimeAnswer();
    nameTheYearStemAsABranch(answer);
    insertAProhibitedClaim('Hier hilft nur ein Anwalt.')(answer);
    const report = reportOf('known', answer);

    try {
      assertSemanticNarrativeQa(report);
      expect.unreachable('a candidate carrying two blocking defects must not produce a reading');
    } catch (error) {
      if (!(error instanceof NarrativeQaError)) {
        throw error;
      }
      expect(error.code).toBe('NARRATIVE_QA_BLOCKED');
      // BOTH, in one refusal: a human fixing a prompt needs the whole picture,
      // and one refusal per run would hide the second defect until the first is
      // fixed.
      expect(error.findings.map((finding) => finding.code).slice().sort()).toEqual([
        'QA_FACT_ROLE_MISMATCH',
        'QA_PROHIBITED_CLAIM',
      ]);
      expect(error.message).toContain('QA_FACT_ROLE_MISMATCH');
      expect(error.message).toContain('QA_PROHIBITED_CLAIM');
    }
  });

  it('leaves the same two defects as a reported verdict when the pure function is used', () => {
    // `runSemanticNarrativeQa` is total: it REPORTS a bad reading rather than
    // throwing for one, so a caller that wants the findings never has to catch.
    const answer = validKnownTimeAnswer();
    nameTheYearStemAsABranch(answer);
    insertAProhibitedClaim('Hier hilft nur ein Anwalt.')(answer);

    const qa = runSemanticNarrativeQa(reportOf('known', answer));

    expect(qa.status).toBe('BLOCKED');
    expect(qa.findings).toHaveLength(2);
  });

  it('returns the result instead of throwing for the unmutated answer', () => {
    expect(assertSemanticNarrativeQa(reportOf('known', validKnownTimeAnswer())).status).toBe(
      'PASS',
    );
  });
});

describe('ETBZ-25B Q7: every gate the module declares is proven blocking here', () => {
  it('reaches all five gates and all eight refusal codes from a valid baseline', () => {
    // The sweep re-runs one representative mutation per code. Its value is the
    // EXHAUSTIVENESS claim, derived from the module's own exported gate list:
    // a sixth gate, or a gate no case can trip, turns this red.
    const sweep: readonly (readonly [NarrativeQaErrorCode, FixtureChart, Mutation])[] = [
      ['QA_FACT_ROLE_MISMATCH', 'known', nameTheYearStemAsABranch],
      ['QA_PROVISIONAL_CERTAINTY', 'unknown', assertCertaintyOverTheProvisionalHour('zweifellos')],
      ['QA_PROVISIONAL_NOTE_WITHOUT_UNCERTAINTY', 'unknown', replaceTheNoteWithOneThatStatesNothing],
      ['QA_UNANCHORED_PROSE', 'known', replaceProseWithUnanchoredText],
      ['QA_INSUFFICIENT_CHART_DEPENDENCE', 'known', narrowTheReadingToTwoChartTerms],
      ['QA_BARNUM_PHRASE', 'known', insertABarnumPhrase],
      ['QA_SYNTHESIS_INSUFFICIENT', 'known', rewriteAsLookupOnly],
      ['QA_PROHIBITED_CLAIM', 'known', insertAProhibitedClaim('Dieser Weg ist vorbestimmt.')],
    ];

    const gatesProven = new Set<NarrativeQaGate>();
    const codesProven = new Set<NarrativeQaErrorCode>();
    for (const [code, chart, mutate] of sweep) {
      const { finding } = expectSingleFinding(chart, mutate, code);
      gatesProven.add(finding.gate);
      codesProven.add(finding.code);
    }

    expect([...codesProven].sort()).toEqual(sweep.map(([code]) => code).slice().sort());
    expect([...gatesProven].sort()).toEqual([...NARRATIVE_QA_GATES].sort());
  });
});
