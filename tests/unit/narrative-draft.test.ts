import { describe, expect, it } from 'vitest';
import {
  NarrativeProviderError,
  ReportError,
} from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import {
  parseNarrativeDraft,
  stripCodeFence,
  toProviderOutput,
} from '../../src/application/interpretation/narrative-draft.js';
import type { NarrativeDraft } from '../../src/application/interpretation/narrative-draft.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import { narrativeProviderOutputSchema } from '../../src/application/ports/narrative-provider.js';
import {
  answerAsProviderText,
  validKnownTimeAnswer,
  validUnknownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type { FixtureSection } from '../support/llmNarrativeFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B — the seam where a language model stops being text.
 *
 * `narrative-draft.ts` is the ONLY place in the slice where untrusted provider
 * output becomes a typed structure, which makes it the only place a defect can
 * enter the chain without being a defect of the chart. Three properties decide
 * whether that seam holds, and each one is measured here rather than reasoned
 * about:
 *
 *   1. THE TOLERANCE IS EXACTLY ONE FENCE. Models wrap JSON in ```json fences
 *      out of habit, and refusing that would spend a run's single shot on a
 *      formatting tic. Everything else about the framing — commentary around
 *      the object, a half-written fence, a JSON5-ism — stays a refusal. A
 *      tolerance nobody has swept from both sides is indistinguishable from a
 *      parser that quietly digs an object out of anything.
 *
 *   2. THE SCHEMA IS STRICT IN BOTH DIRECTIONS. A missing or renamed field is
 *      an incomplete answer; an EXTRA key is a model inventing a channel ETBZ
 *      never asked for and would never read. `uncertaintyNotes` is the single
 *      documented absence the schema fills, so that default is proven to apply
 *      where it should and — the part a default usually gets wrong — to stay
 *      out of the way where a real value exists.
 *
 *   3. THE BINDING BETWEEN ANSWER AND BRIEF IS ETBZ'S BOOKKEEPING, NOT THE
 *      MODEL'S HONESTY. `providerId` and `briefStructuralHash` are stamped by
 *      `toProviderOutput` from ITS arguments. The strong form of that claim is
 *      not "a supplied hash is overwritten" but "a model cannot supply one at
 *      all": the strict schema refuses the key outright, so the hash has no
 *      path into the chain except from ETBZ's own copy of the brief. Both forms
 *      are asserted below, and the stamped value is then shown to be
 *      load-bearing by feeding a wrong one to the real `buildReportModel`.
 *
 * Every refusal here is also read for what it does NOT say. The message travels
 * into logs and evidence records, so it may name the contract (path + code) and
 * must never echo the model's content back.
 *
 * All negative cases below start from `validKnownTimeAnswer()` — the answer
 * verified to pass both the structural and the semantic gate — and change
 * exactly one thing, so a red assertion names one cause.
 */

/** The two stamps ETBZ owns. Distinctive, so a leak into a message is visible. */
const LOCAL_PROVIDER_ID = 'etbz-25b.unit.provider';
const LOCAL_BRIEF_HASH = 'local-brief-hash-0d41a7c2';

/** What a model would have to invent in order to declare the binding itself. */
const MODEL_SUPPLIED_HASH = 'model-supplied-hash-deadbeef';

/** Indexed access under `noUncheckedIndexedAccess`, with a named failure. */
function at<T>(values: readonly T[], index: number, what: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`fixture defect: no ${what} at index ${String(index)}`);
  }
  return value;
}

/** One section of the verified answer, as the baseline every mutation bends. */
function validSection(): FixtureSection {
  return at(validKnownTimeAnswer().sections, 0, 'fixture section');
}

/** Renders an arbitrary payload the way a provider puts it on the wire. */
function wireText(payload: unknown): string {
  return JSON.stringify(payload);
}

/** Runs one parse that is expected to fail, and returns the typed refusal. */
function refusalFrom(text: string): NarrativeProviderError {
  let caught: unknown;
  try {
    parseNarrativeDraft(text);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NarrativeProviderError);
  if (!(caught instanceof NarrativeProviderError)) {
    throw new Error('unreachable: the instance assertion above has already failed');
  }
  return caught;
}

describe('ETBZ-25B N1: a bare JSON answer becomes the draft the port expects', () => {
  it('parses the verified answer into exactly the sections the model wrote', () => {
    const answer = validKnownTimeAnswer();

    const draft = parseNarrativeDraft(answerAsProviderText(answer));

    // Deep equality rather than a spot check: the parser decides whether a
    // shape is acceptable and changes NOTHING about the content.
    expect(draft.sections).toEqual(answer.sections);
    expect(Object.keys(draft)).toEqual(['sections']);
  });

  it('keeps every citation an exact factId/value pair in the order it was written', () => {
    const answer = validKnownTimeAnswer();

    const draft = parseNarrativeDraft(answerAsProviderText(answer));

    const written = at(answer.sections, 0, 'fixture section');
    const parsed = at(draft.sections, 0, 'parsed section');
    expect(parsed.themeId).toBe(written.themeId);
    expect(parsed.prose).toBe(written.prose);
    expect(parsed.citedFacts).toEqual(written.citedFacts);
    expect(Object.keys(parsed)).toEqual(['themeId', 'citedFacts', 'prose', 'uncertaintyNotes']);
    for (const citation of parsed.citedFacts) {
      expect(Object.keys(citation)).toEqual(['factId', 'value']);
    }
  });

  it('carries the unknown-time answer through with its uncertainty note verbatim', () => {
    const answer = validUnknownTimeAnswer();

    const draft = parseNarrativeDraft(answerAsProviderText(answer));

    const notes = draft.sections.flatMap((section) => section.uncertaintyNotes);
    expect(notes).toEqual(answer.sections.flatMap((section) => section.uncertaintyNotes));
    // Guards the assertion above against passing on two empty arrays.
    expect(notes.length).toBeGreaterThan(0);
  });

  it('ignores whitespace the model left around the object', () => {
    const bare = answerAsProviderText(validKnownTimeAnswer());

    expect(parseNarrativeDraft(`\n\n   ${bare}  \n`)).toEqual(parseNarrativeDraft(bare));
  });

  it('leaves emptiness to the later gates: a zero-section answer is a valid SHAPE', () => {
    // Division of labour, stated as a test so it cannot drift: this module
    // proves shape only. "Too few sections" is owned by `report-model.ts`, and
    // asserting it here would duplicate a guard that already has an owner.
    expect(parseNarrativeDraft('{"sections":[]}').sections).toEqual([]);
  });
});

describe('ETBZ-25B N2: the fence is the only framing tolerated', () => {
  const BARE = answerAsProviderText(validKnownTimeAnswer());

  it('returns unfenced text unchanged apart from surrounding whitespace', () => {
    // Positive control: the stripper is not a mangler that happens to leave
    // JSON intact — handed no fence, it hands back the text it was given.
    expect(stripCodeFence(BARE)).toBe(BARE);
    expect(stripCodeFence(`  ${BARE}\n`)).toBe(BARE);
  });

  it('recovers the identical draft from every documented fence spelling', () => {
    const fences = {
      lowercase: `\`\`\`json\n${BARE}\n\`\`\``,
      uppercase: `\`\`\`JSON\n${BARE}\n\`\`\``,
      unmarked: `\`\`\`\n${BARE}\n\`\`\``,
      'no trailing newline': `\`\`\`json\n${BARE}\`\`\``,
      'padded with blank lines': `\n\n\`\`\`json\n${BARE}\n\`\`\`   \n`,
    };
    const fromBare = parseNarrativeDraft(BARE);

    for (const [label, text] of Object.entries(fences)) {
      expect(stripCodeFence(text), label).toBe(BARE);
      expect(parseNarrativeDraft(text), label).toEqual(fromBare);
    }
  });

  it('does not dig the object out of surrounding commentary', () => {
    // A model that wrote prose around its answer did not follow the output
    // contract. Rescuing it here would hide that from the evidence record.
    const commented = `Gern! Hier ist deine Antwort:\n${BARE}\nSag Bescheid, wenn du mehr willst.`;

    expect(stripCodeFence(commented)).toBe(commented);
    expect(refusalFrom(commented).code).toBe('PROVIDER_OUTPUT_NOT_JSON');
  });

  it('treats a fence outside the documented shape as ordinary text', () => {
    const notFences = {
      'mixed-case marker': `\`\`\`Json\n${BARE}\n\`\`\``,
      'no newline after the marker': `\`\`\`json ${BARE}\`\`\``,
      'opened but never closed': `\`\`\`json\n${BARE}`,
    };

    for (const [label, text] of Object.entries(notFences)) {
      expect(stripCodeFence(text), label).toBe(text);
      expect(refusalFrom(text).code, label).toBe('PROVIDER_OUTPUT_NOT_JSON');
    }
  });
});

describe('ETBZ-25B N3: text that is not JSON is refused as PROVIDER_OUTPUT_NOT_JSON', () => {
  it('accepts the baseline answer, so refusal is not the only outcome this parser has', () => {
    expect(() => parseNarrativeDraft(answerAsProviderText(validKnownTimeAnswer()))).not.toThrow();
  });

  it('refuses a model that answered in prose instead of the required object', () => {
    const refusal = refusalFrom('Es tut mir leid, dazu kann ich nichts sagen.');

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('NarrativeProviderError');
    expect(refusal.code).toBe('PROVIDER_OUTPUT_NOT_JSON');
  });

  it('refuses an empty and a whitespace-only answer as that same class of failure', () => {
    for (const text of ['', '   ', '\n\n']) {
      expect(refusalFrom(text).code, JSON.stringify(text)).toBe('PROVIDER_OUTPUT_NOT_JSON');
    }
  });

  it('refuses the truncated object a token ceiling produces', () => {
    const truncated = answerAsProviderText(validKnownTimeAnswer()).slice(0, 120);

    // The cut really is mid-object, so the refusal is about truncation and not
    // about the text having been something else entirely.
    expect(truncated.startsWith('{"sections":[{')).toBe(true);
    expect(refusalFrom(truncated).code).toBe('PROVIDER_OUTPUT_NOT_JSON');
  });

  it('refuses JSON5-isms: a trailing comma, single quotes, an unquoted key', () => {
    for (const text of ['{"sections":[],}', "{'sections':[]}", '{sections:[]}']) {
      expect(refusalFrom(text).code, text).toBe('PROVIDER_OUTPUT_NOT_JSON');
    }
  });

  it('refuses a correctly fenced block whose content is prose', () => {
    expect(refusalFrom('```json\nkeine Ahnung, sorry\n```').code).toBe('PROVIDER_OUTPUT_NOT_JSON');
  });
});

describe('ETBZ-25B N4: JSON of the wrong shape is refused as PROVIDER_OUTPUT_SCHEMA_INVALID', () => {
  it('accepts the unmutated baseline, so each mutation below is the only difference', () => {
    expect(() => parseNarrativeDraft(wireText(validKnownTimeAnswer()))).not.toThrow();
  });

  it('refuses a missing or misspelled top-level field', () => {
    const answer = validKnownTimeAnswer();
    const payloads = {
      missing: {},
      'singular misspelling': { section: answer.sections },
      'capitalised misspelling': { Sections: answer.sections },
    };

    for (const [label, payload] of Object.entries(payloads)) {
      const refusal = refusalFrom(wireText(payload));
      expect(refusal.code, label).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message, label).toContain('sections: invalid_type');
    }
  });

  it('refuses a field of the wrong type and names the path that failed', () => {
    const section = validSection();
    const rows = [
      { label: 'sections keyed instead of listed', payload: { sections: { first: section } }, path: 'sections: invalid_type' },
      { label: 'a section that is a string', payload: { sections: ['eine Deutung'] }, path: 'sections.0: invalid_type' },
      { label: 'prose as a number', payload: { sections: [{ ...section, prose: 42 }] }, path: 'sections.0.prose: invalid_type' },
      { label: 'citedFacts as a single id', payload: { sections: [{ ...section, citedFacts: 'chart.dayMaster.stem' }] }, path: 'sections.0.citedFacts: invalid_type' },
      { label: 'a note that is a number', payload: { sections: [{ ...section, uncertaintyNotes: [7] }] }, path: 'sections.0.uncertaintyNotes.0: invalid_type' },
      { label: 'an empty themeId', payload: { sections: [{ ...section, themeId: '' }] }, path: 'sections.0.themeId: too_small' },
    ];

    for (const row of rows) {
      const refusal = refusalFrom(wireText(row.payload));
      expect(refusal.code, row.label).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message, row.label).toContain(row.path);
    }
  });

  it('refuses a citation that renamed, dropped or emptied a field', () => {
    const section = validSection();
    const citations = {
      'factId misspelled': { factID: 'chart.dayMaster.stem', value: 'Xin' },
      'value dropped': { factId: 'chart.dayMaster.stem' },
      'factId empty': { factId: '', value: 'Xin' },
    };

    for (const [label, citation] of Object.entries(citations)) {
      const refusal = refusalFrom(wireText({ sections: [{ ...section, citedFacts: [citation] }] }));
      expect(refusal.code, label).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message, label).toContain('sections.0.citedFacts.0');
    }
  });

  it('refuses an EXTRA key at every level: an invented key is an invented channel', () => {
    const section = validSection();
    const rows = [
      { label: 'at the root', payload: { ...validKnownTimeAnswer(), providerConfidence: 0.94 }, path: '<root>: unrecognized_keys' },
      { label: 'on a section', payload: { sections: [{ ...section, tone: 'warm' }] }, path: 'sections.0: unrecognized_keys' },
      {
        label: 'on a citation',
        payload: { sections: [{ ...section, citedFacts: [{ factId: 'chart.dayMaster.stem', value: 'Xin', basis: 'memory' }] }] },
        path: 'sections.0.citedFacts.0: unrecognized_keys',
      },
    ];

    for (const row of rows) {
      const refusal = refusalFrom(wireText(row.payload));
      expect(refusal.code, row.label).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message, row.label).toContain(row.path);
    }
  });

  it('separates a contract failure from a formatting one: valid JSON that is not an object', () => {
    // The two refusals want different fixes — a prompt change versus a schema
    // conversation — so a JSON array must NOT be reported as "not JSON".
    for (const text of ['[]', '"sections"', '42', 'null', 'true']) {
      const refusal = refusalFrom(text);
      expect(refusal.code, text).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message, text).toContain('<root>: invalid_type');
    }
  });
});

describe('ETBZ-25B N5: uncertaintyNotes is the one absence the schema fills', () => {
  /** The baseline section with the optional field genuinely absent. */
  function sectionWithoutNotes(): Record<string, unknown> {
    const section = validSection();
    return { themeId: section.themeId, citedFacts: section.citedFacts, prose: section.prose };
  }

  it('keeps supplied notes verbatim, so the default never overwrites real content', () => {
    // Positive control: the default is reachable only where the key is absent.
    const answer = validUnknownTimeAnswer();
    const written = at(answer.sections, 3, 'fixture section');

    const draft = parseNarrativeDraft(answerAsProviderText(answer));

    expect(written.uncertaintyNotes.length).toBeGreaterThan(0);
    expect(at(draft.sections, 3, 'parsed section').uncertaintyNotes).toEqual(
      written.uncertaintyNotes,
    );
  });

  it('defaults an omitted uncertaintyNotes to an empty array', () => {
    const draft = parseNarrativeDraft(wireText({ sections: [sectionWithoutNotes()] }));

    expect(at(draft.sections, 0, 'parsed section').uncertaintyNotes).toEqual([]);
  });

  it('applies the default per section, leaving a sibling section untouched', () => {
    const noted = { ...validSection(), uncertaintyNotes: ['Vorlaeufig: bleibt ungewiss.'] };

    const draft = parseNarrativeDraft(wireText({ sections: [sectionWithoutNotes(), noted] }));

    expect(at(draft.sections, 0, 'parsed section').uncertaintyNotes).toEqual([]);
    expect(at(draft.sections, 1, 'parsed section').uncertaintyNotes).toEqual(
      noted.uncertaintyNotes,
    );
  });

  it('gives every parse its own array instead of sharing one mutable default', () => {
    // A shared default would let one run's note appear in the next run's
    // report. The identity check is the only way to see that from outside.
    const text = wireText({ sections: [sectionWithoutNotes(), sectionWithoutNotes()] });

    const first = parseNarrativeDraft(text);
    const second = parseNarrativeDraft(text);

    const firstNotes = at(first.sections, 0, 'parsed section').uncertaintyNotes;
    expect(firstNotes).not.toBe(at(second.sections, 0, 'parsed section').uncertaintyNotes);
    expect(firstNotes).not.toBe(at(first.sections, 1, 'parsed section').uncertaintyNotes);
  });

  it('does not treat an explicit null as an absent field', () => {
    const refusal = refusalFrom(
      wireText({ sections: [{ ...validSection(), uncertaintyNotes: null }] }),
    );

    expect(refusal.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
    expect(refusal.message).toContain('sections.0.uncertaintyNotes: invalid_type');
  });
});

describe('ETBZ-25B N6: toProviderOutput stamps the bookkeeping the model cannot supply', () => {
  it('stamps providerId and briefStructuralHash from its own arguments', () => {
    const draft = parseNarrativeDraft(answerAsProviderText(validKnownTimeAnswer()));

    const output = toProviderOutput(draft, LOCAL_PROVIDER_ID, LOCAL_BRIEF_HASH);

    expect(output.providerId).toBe(LOCAL_PROVIDER_ID);
    expect(output.briefStructuralHash).toBe(LOCAL_BRIEF_HASH);
    expect(Object.keys(output)).toEqual(['providerId', 'briefStructuralHash', 'sections']);
    expect(output.sections).toEqual(draft.sections);
    // The port's own structural schema, not a restatement of it here.
    expect(narrativeProviderOutputSchema.safeParse(output).success).toBe(true);
  });

  it('refuses provider text that tried to declare the binding itself', () => {
    // The stronger property: neither field can even REACH `toProviderOutput`
    // from provider text, because the strict schema stops the key at the door.
    const answer = validKnownTimeAnswer();
    const contaminated = [
      { ...answer, briefStructuralHash: MODEL_SUPPLIED_HASH },
      { ...answer, providerId: 'i-am-the-provider' },
      { ...answer, briefStructuralHash: MODEL_SUPPLIED_HASH, providerId: 'i-am-the-provider' },
    ];

    for (const payload of contaminated) {
      const refusal = refusalFrom(wireText(payload));
      expect(refusal.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message).toContain('<root>: unrecognized_keys');
    }
  });

  it('ignores those fields even when they are already sitting on the object it is handed', () => {
    const draft: NarrativeDraft = parseNarrativeDraft(
      answerAsProviderText(validKnownTimeAnswer()),
    );
    // Unreachable through `parseNarrativeDraft` (proven directly above), so it
    // is attached here: the stamping is then MEASURED rather than inferred
    // from the parser having refused the key.
    Object.assign(draft, {
      providerId: 'i-am-the-provider',
      briefStructuralHash: MODEL_SUPPLIED_HASH,
    });

    const output = toProviderOutput(draft, LOCAL_PROVIDER_ID, LOCAL_BRIEF_HASH);

    expect(output.providerId).toBe(LOCAL_PROVIDER_ID);
    expect(output.briefStructuralHash).toBe(LOCAL_BRIEF_HASH);
    expect(Object.keys(output)).toEqual(['providerId', 'briefStructuralHash', 'sections']);
    expect(JSON.stringify(output)).not.toContain(MODEL_SUPPLIED_HASH);
    expect(JSON.stringify(output)).not.toContain('i-am-the-provider');
  });

  it('binds one draft to whichever route and brief actually produced it', () => {
    const draft = parseNarrativeDraft(answerAsProviderText(validKnownTimeAnswer()));

    const first = toProviderOutput(draft, 'route-a', 'hash-a');
    const second = toProviderOutput(draft, 'route-b', 'hash-b');

    expect([first.providerId, first.briefStructuralHash]).toEqual(['route-a', 'hash-a']);
    expect([second.providerId, second.briefStructuralHash]).toEqual(['route-b', 'hash-b']);
    expect(first.sections).toEqual(second.sections);
    // Fresh containers per stamp: two outputs must not alias one array.
    expect(first.sections).not.toBe(second.sections);
  });

  it('rebuilds each section and citation as exactly the fields the port declares', () => {
    const draft = parseNarrativeDraft(answerAsProviderText(validKnownTimeAnswer()));

    const output = toProviderOutput(draft, LOCAL_PROVIDER_ID, LOCAL_BRIEF_HASH);

    expect(output.sections.length).toBe(validKnownTimeAnswer().sections.length);
    for (const section of output.sections) {
      expect(Object.keys(section)).toEqual(['themeId', 'citedFacts', 'prose', 'uncertaintyNotes']);
      for (const citation of section.citedFacts) {
        expect(Object.keys(citation)).toEqual(['factId', 'value']);
      }
    }
  });
});

describe('ETBZ-25B N7: a parsed and stamped answer is what the report chain consumes', () => {
  it('builds a real ReportModel out of provider TEXT, carrying both stamps as provenance', () => {
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const answer = validKnownTimeAnswer();

    // The full seam, fence included: text in, report out.
    const draft = parseNarrativeDraft(`\`\`\`json\n${answerAsProviderText(answer)}\n\`\`\``);
    const output = toProviderOutput(draft, LOCAL_PROVIDER_ID, chain.brief.structuralHash);
    const report = buildReportModel({ model, brief: chain.brief, providerOutput: output });

    expect(report.interpretation.map((section) => section.themeId)).toEqual(
      answer.sections.map((section) => section.themeId),
    );
    expect(report.provenance.providerId).toBe(LOCAL_PROVIDER_ID);
    expect(report.provenance.briefStructuralHash).toBe(chain.brief.structuralHash);
  });

  it('makes the stamped hash load-bearing: a wrong one is refused downstream', () => {
    const model = knownTimeModel();
    const chain = buildNarrativeChain(model);
    const draft = parseNarrativeDraft(answerAsProviderText(validKnownTimeAnswer()));

    // Exactly one thing differs from the passing case above: the stamped hash.
    const output = toProviderOutput(draft, LOCAL_PROVIDER_ID, MODEL_SUPPLIED_HASH);
    let caught: unknown;
    try {
      buildReportModel({ model, brief: chain.brief, providerOutput: output });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReportError);
    if (!(caught instanceof ReportError)) return;
    expect(caught.code).toBe('REPORT_BRIEF_HASH_MISMATCH');
  });
});

describe('ETBZ-25B N8: a refusal names the contract, never the untrusted content', () => {
  const SECRET_PROSE = 'GEHEIM-PROSA-7f21c9 die niemals in einem Log stehen darf';
  const INVENTED_KEY = 'providerConfidenceChannel';

  it('names the failing path and the failing code', () => {
    // Positive control for the scans below: the message IS informative, which
    // is what makes "does not contain the value" a finding rather than an
    // artefact of an empty message.
    const refusal = refusalFrom(wireText({ sections: [{ ...validSection(), prose: 42 }] }));

    expect(refusal.message).toContain('sections.0.prose');
    expect(refusal.message).toContain('invalid_type');
    expect(refusal.message).toContain('narrative draft schema');
  });

  it('echoes neither the invented key nor its value when refusing an extra channel', () => {
    const payload = { sections: [{ ...validSection(), [INVENTED_KEY]: SECRET_PROSE }] };

    const refusal = refusalFrom(wireText(payload));

    expect(refusal.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
    expect(refusal.message).toContain('sections.0: unrecognized_keys');
    expect(refusal.message).not.toContain(INVENTED_KEY);
    expect(refusal.message).not.toContain(SECRET_PROSE);
  });

  it('echoes neither the prose nor the note that carried the wrong type', () => {
    const rows = [
      { sections: [{ ...validSection(), prose: { text: SECRET_PROSE } }] },
      { sections: [{ ...validSection(), uncertaintyNotes: SECRET_PROSE }] },
      { sections: [{ ...validSection(), themeId: SECRET_PROSE, prose: 7 }] },
    ];

    for (const payload of rows) {
      const refusal = refusalFrom(wireText(payload));
      expect(refusal.code).toBe('PROVIDER_OUTPUT_SCHEMA_INVALID');
      expect(refusal.message).not.toContain(SECRET_PROSE);
    }
  });

  it('echoes nothing of an answer that was not JSON at all', () => {
    const refusal = refusalFrom(`Tut mir leid. ${SECRET_PROSE}`);

    expect(refusal.code).toBe('PROVIDER_OUTPUT_NOT_JSON');
    expect(refusal.message).not.toContain(SECRET_PROSE);
    expect(refusal.message).not.toContain('Tut mir leid');
  });

  it('stays bounded no matter how much the model wrote', () => {
    const flood = 'x'.repeat(20000);

    const notJson = refusalFrom(flood);
    const wrongShape = refusalFrom(wireText({ sections: flood }));

    expect(notJson.message).not.toContain(flood.slice(0, 200));
    expect(notJson.message.length).toBeLessThan(400);
    expect(wrongShape.message).not.toContain(flood.slice(0, 200));
    expect(wrongShape.message.length).toBeLessThan(400);
  });
});
