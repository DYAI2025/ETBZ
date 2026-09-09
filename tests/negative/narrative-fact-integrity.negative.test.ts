import { describe, expect, it } from 'vitest';
import { composeDeterministicNarrative } from '../../src/application/interpretation/deterministic-narrative-provider.js';
import { ReportError } from '../../src/application/interpretation/errors.js';
import type { ReportErrorCode } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import type { NarrativeBrief } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 E — fact integrity: what a provider may NOT do.
 *
 * Every case below starts from the deterministic provider's own valid answer
 * and changes exactly ONE thing, so each assertion isolates a single guard. The
 * final case in each group re-runs the UNMUTATED answer and requires a report,
 * which is what proves these guards are not simply always red.
 *
 * Nothing here needs a model, a credential or a network: the "provider" is a
 * plain object literal, which is precisely the point — the validation does not
 * care where the answer came from.
 */

interface MutableCitation {
  factId: string;
  value: string;
}
interface MutableSection {
  themeId: string;
  citedFacts: MutableCitation[];
  prose: string;
  uncertaintyNotes: string[];
}
interface MutableOutput {
  providerId: string;
  briefStructuralHash: string;
  sections: MutableSection[];
}

function draftFor(brief: NarrativeBrief): MutableOutput {
  return structuredClone(composeDeterministicNarrative(brief)) as unknown as MutableOutput;
}

function sectionOf(output: MutableOutput, themeId: string): MutableSection {
  const section = output.sections.find((candidate) => candidate.themeId === themeId);
  if (section === undefined) {
    throw new Error(`fixture defect: the deterministic answer has no section "${themeId}"`);
  }
  return section;
}

function citationOf(section: MutableSection, factId: string): MutableCitation {
  const citation = section.citedFacts.find((candidate) => candidate.factId === factId);
  if (citation === undefined) {
    throw new Error(`fixture defect: section "${section.themeId}" does not cite "${factId}"`);
  }
  return citation;
}

function expectRefusal(
  code: ReportErrorCode,
  model: HoroscopeModel,
  brief: NarrativeBrief,
  providerOutput: unknown,
): void {
  try {
    buildReportModel({ model, brief, providerOutput });
  } catch (error) {
    if (error instanceof ReportError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
  expect.unreachable(`expected the report to be refused with ${code}`);
}

const KNOWN = knownTimeModel();
const KNOWN_CHAIN = buildNarrativeChain(KNOWN);
const UNKNOWN = unknownTimeModel();
const UNKNOWN_CHAIN = buildNarrativeChain(UNKNOWN);

describe('ETBZ-25 E0: the unmutated answer really does produce a report', () => {
  it('builds a report from the deterministic provider (guards are not always red)', () => {
    const report = buildReportModel({
      model: KNOWN,
      brief: KNOWN_CHAIN.brief,
      providerOutput: draftFor(KNOWN_CHAIN.brief),
    });

    expect(report.interpretation.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ETBZ-25 E1: the answer must belong to this chart and this brief', () => {
  it('refuses a brief that is not the one this HoroscopeModel produces', () => {
    // The brief of a DIFFERENT chart, with a provider answer that matches it.
    expectRefusal(
      'REPORT_BRIEF_NOT_DERIVED_FROM_MODEL',
      KNOWN,
      UNKNOWN_CHAIN.brief,
      draftFor(UNKNOWN_CHAIN.brief),
    );
  });

  it('refuses an answer that names a different brief', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    output.briefStructuralHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

    expectRefusal('REPORT_BRIEF_HASH_MISMATCH', KNOWN, KNOWN_CHAIN.brief, output);
  });
});

describe('ETBZ-25 E2: structurally malformed provider output is refused', () => {
  it.each([
    ['not an object', 'a narrative'],
    ['null', null],
    ['missing providerId', { briefStructuralHash: 'x', sections: [] }],
    ['sections of the wrong type', { providerId: 'p', briefStructuralHash: 'x', sections: 'nope' }],
    [
      'an unknown top-level key',
      { providerId: 'p', briefStructuralHash: 'x', sections: [], temperature: 0.9 },
    ],
    [
      'a citation without a value',
      {
        providerId: 'p',
        briefStructuralHash: 'x',
        sections: [{ themeId: 't', citedFacts: [{ factId: 'f' }], prose: 'p', uncertaintyNotes: [] }],
      },
    ],
  ])('refuses provider output that is %s', (_label, providerOutput) => {
    expectRefusal('REPORT_PROVIDER_SCHEMA_INVALID', KNOWN, KNOWN_CHAIN.brief, providerOutput);
  });

  it('reports the schema failure without echoing the received value', () => {
    // The offending value is a harmless marker string on purpose: this
    // repository's secret gate scans tests too, and a fixture that merely looks
    // credential-shaped would make that gate's verdict about the fixture rather
    // than about the code.
    const marker = 'value-that-must-not-appear-in-the-error';
    try {
      buildReportModel({
        model: KNOWN,
        brief: KNOWN_CHAIN.brief,
        providerOutput: {
          providerId: 'p',
          briefStructuralHash: 'x',
          sections: [],
          unexpectedField: marker,
        },
      });
      expect.unreachable('malformed output must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ReportError);
      expect((error as ReportError).code).toBe('REPORT_PROVIDER_SCHEMA_INVALID');
      expect((error as ReportError).message).not.toContain(marker);
    }
  });
});

describe('ETBZ-25 E3: a provider may not change a chart fact', () => {
  it.each([
    ['a pillar stem', 'theme.pillar.year', 'chart.pillar.year.stem', 'Ren'],
    ['the day master', 'theme.dayMaster', 'chart.dayMaster.stem', 'Geng'],
    ['a Ten God', 'theme.tenGod.SevenKilling', 'chart.natal.pillar.year.hiddenStem.0.tenGod', 'DirectWealth'],
    ['a Wu Xing weight', 'theme.wuXing.Feuer', 'chart.wuxing.weight.Feuer', '9.9'],
  ])('refuses a report whose provider restates %s with a different value', (
    _label,
    themeId,
    factId,
    forgedValue,
  ) => {
    const output = draftFor(KNOWN_CHAIN.brief);
    citationOf(sectionOf(output, themeId), factId).value = forgedValue;

    expectRefusal('REPORT_FACT_MUTATED', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses a citation of a fact this chart does not have', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    sectionOf(output, 'theme.pillar.year').citedFacts.push({
      factId: 'chart.pillar.year.doesNotExist',
      value: 'Geng',
    });

    expectRefusal('REPORT_UNKNOWN_FACT', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses a citation of a real fact that belongs to a different theme', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    sectionOf(output, 'theme.wuXing.Erde').citedFacts.push({
      factId: 'chart.pillar.year.stem',
      value: 'Geng',
    });

    expectRefusal('REPORT_FACT_NOT_IN_THEME', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses a section that names a theme this chart does not have', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    sectionOf(output, 'theme.dayMaster').themeId = 'theme.inventedByTheProvider';

    expectRefusal('REPORT_UNKNOWN_THEME', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses the same theme narrated twice', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    output.sections.push(structuredClone(sectionOf(output, 'theme.dayMaster')));

    expectRefusal('REPORT_DUPLICATE_THEME_SECTION', KNOWN, KNOWN_CHAIN.brief, output);
  });
});

describe('ETBZ-25 E3b: the protection is exhaustive, not sampled', () => {
  it('refuses EVERY single-citation mutation the whole report can carry', () => {
    // The four cases above are illustrative. This one is the actual claim: take
    // the provider's valid answer, and for each cited fact in turn, change ONLY
    // that one value. Every one of them must be refused. A guard that protects
    // most facts is not fact integrity.
    const reference = draftFor(KNOWN_CHAIN.brief);
    let mutationsChecked = 0;

    for (let s = 0; s < reference.sections.length; s += 1) {
      const section = reference.sections[s];
      if (section === undefined) continue;
      for (let c = 0; c < section.citedFacts.length; c += 1) {
        const output = draftFor(KNOWN_CHAIN.brief);
        const target = output.sections[s]?.citedFacts[c];
        if (target === undefined) continue;
        // A value this chart demonstrably does not carry at that fact.
        target.value = `${target.value}-forged`;
        expectRefusal('REPORT_FACT_MUTATED', KNOWN, KNOWN_CHAIN.brief, output);
        mutationsChecked += 1;
      }
    }

    // The sweep must actually have run; an empty loop would be a silent pass.
    // Measured on this fixture: 103 mutations, all 103 refused with
    // REPORT_FACT_MUTATED.
    expect(mutationsChecked).toBeGreaterThan(50);
    // Generous, explicit timeout: this sweep builds ~103 reports and runs for
    // seconds, close enough to vitest's 5s default that a slower CI machine
    // would turn a correct test red. A flaky gate is not a gate.
  }, 120_000);

  it('refuses EVERY dropped-citation mutation the whole report can carry', () => {
    // Removing a citation is the other half: a provider that keeps the prose
    // but quietly stops pointing at a fact must not get a report either,
    // because the prose still names the symbol it no longer cites.
    const reference = draftFor(KNOWN_CHAIN.brief);
    let checked = 0;
    let refused = 0;

    for (let s = 0; s < reference.sections.length; s += 1) {
      const section = reference.sections[s];
      if (section === undefined || section.citedFacts.length < 2) continue;
      for (let c = 0; c < section.citedFacts.length; c += 1) {
        const output = draftFor(KNOWN_CHAIN.brief);
        const mutated = output.sections[s];
        if (mutated === undefined) continue;
        const dropped = mutated.citedFacts[c];
        if (dropped === undefined) continue;
        mutated.citedFacts.splice(c, 1);
        checked += 1;
        try {
          buildReportModel({
            model: KNOWN,
            brief: KNOWN_CHAIN.brief,
            providerOutput: output,
          });
        } catch (error) {
          if (!(error instanceof ReportError)) throw error;
          // Either half of the "if you write it, cite it" rule may fire: the
          // dropped fact was a symbol, or it was a quantity whose digits are
          // still standing in the sentence.
          expect(['REPORT_UNCITED_SYMBOL', 'REPORT_UNCITED_NUMBER']).toContain(error.code);
          refused += 1;
        }
      }
    }

    expect(checked).toBeGreaterThan(50);
    // Not every dropped citation must fail: a fact whose value and label are
    // also carried by another cited fact of the same section leaves the prose
    // fully covered, and refusing that would be a false alarm rather than
    // integrity. What must hold is that the guard bites on the large majority
    // and that it is never silent when the symbol really loses its citation.
    expect(refused).toBeGreaterThan(0);
    expect(refused / checked).toBeGreaterThan(0.5);
  }, 120_000);
});

describe('ETBZ-25 E4: interpretation without a fact basis is refused', () => {
  it('refuses a section that cites nothing', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    sectionOf(output, 'theme.dayMaster').citedFacts = [];

    expectRefusal('REPORT_UNGROUNDED_INTERPRETATION', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses a section that carries no prose', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    sectionOf(output, 'theme.dayMaster').prose = '   \n  ';

    expectRefusal('REPORT_UNGROUNDED_INTERPRETATION', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses prose that names a chart symbol the section did not cite', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    // "Geng" is a real stem of this chart, but not a fact of the Erde theme.
    const section = sectionOf(output, 'theme.wuXing.Erde');
    section.prose = `${section.prose} Der Stamm Geng gehoert dazu.`;

    expectRefusal('REPORT_UNCITED_SYMBOL', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses prose that invents a symbol no chart carries', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.wuXing.Erde');
    // A stem that is not in this chart at all.
    section.prose = `${section.prose} Auch Gui zeigt sich hier.`;

    expectRefusal('REPORT_UNCITED_SYMBOL', KNOWN, KNOWN_CHAIN.brief, output);
  });
});

describe('ETBZ-25 E4b: prose may not assert a chart value the section did not cite', () => {
  // These four cases were found by an adversarial review of this slice: a
  // provider can satisfy every structured citation and still write a different
  // value into the sentence that is actually sold. The citation echo does not
  // see that; these guards do.

  it('refuses a prose sentence that states a Wu Xing weight the chart does not carry', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.wuXing.Feuer');
    // The section cites the real weight; the SENTENCE claims a different one.
    section.prose = `${section.prose} Feuer erreicht den Wert 9.9.`;

    expectRefusal('REPORT_UNCITED_NUMBER', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('accepts a prose sentence that states the weight the section actually cites', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.wuXing.Feuer');
    const cited = citationOf(section, 'chart.wuxing.weight.Feuer');
    expect(cited.value).toBe('2.5');
    section.prose = `${section.prose} Der Wert betraegt 2.5.`;

    expect(() =>
      buildReportModel({ model: KNOWN, brief: KNOWN_CHAIN.brief, providerOutput: output }),
    ).not.toThrow();
  });

  it('refuses a prose sentence that asserts the opposite polarity', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.dayMaster');
    // The chart's day master polarity is yin; the sentence says yang.
    section.prose = `${section.prose} Die Polaritaet ist yang.`;

    expectRefusal('REPORT_UNCITED_SYMBOL', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses a prose sentence that asserts a Qi role the branch does not carry', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.pillar.day');
    // The day branch carries a principal and a central hidden stem, no residual.
    section.prose = `${section.prose} Das residual Qi traegt die Karte.`;

    expectRefusal('REPORT_UNCITED_SYMBOL', KNOWN, KNOWN_CHAIN.brief, output);
  });
});

describe('ETBZ-25 E4c: the symbol guard cannot be dodged by rewriting the characters', () => {
  it.each([
    ['upper case', 'GENG'],
    ['a zero-width space inside the word', 'Ge\u200Bng'],
    ['an NFD-decomposed pinyin form', 'g\u0065\u0304ng'],
    ['a soft hyphen inside the word', 'Ge\u00ADng'],
  ])('refuses an uncited stem written with %s', (_label, spelling) => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.wuXing.Erde');
    section.prose = `${section.prose} Auch ${spelling} zeigt sich.`;

    expectRefusal('REPORT_UNCITED_SYMBOL', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it('refuses an uncited Han character (the CJK half of the guard, on its own)', () => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.wuXing.Erde');
    section.prose = `${section.prose} Das Zeichen 庚 steht dafuer.`;

    expectRefusal('REPORT_UNCITED_SYMBOL', KNOWN, KNOWN_CHAIN.brief, output);
  });
});

describe('ETBZ-25 E5: a narrative may not claim a method this slice does not evaluate', () => {
  it('refuses an out-of-scope term split by a non-breaking space', () => {
    // Wrapped prose really does produce these; a matcher that only knows the
    // ASCII space would let the term through in exactly the shape a line break
    // creates.
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.dayMaster');
    section.prose = `${section.prose} Das Yong\u00A0Shen ist eindeutig.`;

    expectRefusal('REPORT_OUT_OF_METHOD_SCOPE', KNOWN, KNOWN_CHAIN.brief, output);
  });

  it.each([
    ['day-master strength', 'Die Wang Shuai Bewertung faellt klar aus.'],
    ['the useful god', 'Das Yong Shen dieser Karte ist eindeutig.'],
    ['luck pillars', 'Die naechste Da Yun Periode bringt eine Wende.'],
    ['rooting', 'Es besteht ein starkes Tong Gen.'],
    ['symbolic stars', 'Ein Shen Sha verstaerkt das Bild.'],
  ])('refuses prose that invokes %s', (_label, sentence) => {
    const output = draftFor(KNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.dayMaster');
    section.prose = `${section.prose} ${sentence}`;

    expectRefusal('REPORT_OUT_OF_METHOD_SCOPE', KNOWN, KNOWN_CHAIN.brief, output);
  });
});

describe('ETBZ-25 E6: provisionality may not be dropped on the way to the report', () => {
  it('refuses a section that leans on a provisional fact and states no uncertainty', () => {
    const output = draftFor(UNKNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.pillar.hour');
    expect(section.uncertaintyNotes.length).toBeGreaterThan(0);
    section.uncertaintyNotes = [];

    expectRefusal('REPORT_PROVISIONAL_WITHOUT_NOTE', UNKNOWN, UNKNOWN_CHAIN.brief, output);
  });

  it('refuses a blank uncertainty note as if it were absent', () => {
    const output = draftFor(UNKNOWN_CHAIN.brief);
    sectionOf(output, 'theme.pillar.hour').uncertaintyNotes = ['   '];

    expectRefusal('REPORT_PROVISIONAL_WITHOUT_NOTE', UNKNOWN, UNKNOWN_CHAIN.brief, output);
  });

  it('refuses an uncertainty note that invokes a method this slice does not evaluate', () => {
    // An uncertainty note is published in the sellable artefact next to the
    // chart facts, so it is exactly as capable of smuggling a claim as a
    // paragraph is. Guarding only `prose` would leave this channel open.
    const output = draftFor(UNKNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.pillar.hour');
    section.uncertaintyNotes = [
      ...section.uncertaintyNotes,
      'Das Yong Shen bleibt davon unberuehrt.',
    ];

    expectRefusal('REPORT_OUT_OF_METHOD_SCOPE', UNKNOWN, UNKNOWN_CHAIN.brief, output);
  });

  it('refuses an uncertainty note that names an uncited chart symbol', () => {
    const output = draftFor(UNKNOWN_CHAIN.brief);
    const section = sectionOf(output, 'theme.pillar.hour');
    // "Geng" is a real stem of this chart, but not a fact of the hour theme.
    section.uncertaintyNotes = [
      ...section.uncertaintyNotes,
      'Der Stamm Geng bleibt hiervon unberuehrt.',
    ];

    expectRefusal('REPORT_UNCITED_SYMBOL', UNKNOWN, UNKNOWN_CHAIN.brief, output);
  });

  it('accepts the same unknown-time answer when the note is present', () => {
    const report = buildReportModel({
      model: UNKNOWN,
      brief: UNKNOWN_CHAIN.brief,
      providerOutput: draftFor(UNKNOWN_CHAIN.brief),
    });

    expect(report.uncertainty.providerNotes.length).toBeGreaterThan(0);
  });
});
