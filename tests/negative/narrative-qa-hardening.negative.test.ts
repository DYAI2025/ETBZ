/**
 * ETBZ-25B — the holes an adversarial review actually opened, closed and held.
 *
 * Every case in this file was first CONSTRUCTED AND EXECUTED as a working
 * bypass of a gate that was already green, in a review whose brief was to
 * defeat the guards rather than to confirm them. Each one shipped a defect that
 * would have reached a paying customer, and each is now a regression test.
 *
 * That provenance is the reason the file exists separately from
 * `narrative-semantic-qa.negative.test.ts`: those cases prove the gates do what
 * they were designed to do, these prove the gates survived somebody trying to
 * get past them. A guard that has only ever been tested by the person who wrote
 * it has been confirmed, not challenged.
 *
 * Each block states the bypass in its own comment, so a future reader can see
 * what the rule is actually defending against rather than only what it does.
 */

import { describe, expect, it } from 'vitest';
import { isIncompleteFinishReason } from '../../src/adapters/llm/llm-narrative-provider.js';
import {
  LlmProviderError,
  requestChatCompletion,
} from '../../src/adapters/llm/openai-compatible-client.js';
import type { LlmChatRequest, Transport } from '../../src/adapters/llm/openai-compatible-client.js';
import {
  buildLlmRoutePlan,
  isAcceptableBaseUrl,
} from '../../src/app/configuration/llm-routes.js';
import { ReportError } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type { ReportModel } from '../../src/application/interpretation/report-model.js';
import { CERTAINTY_TERMS } from '../../src/application/interpretation/semantic-qa-lexicon.js';
import { runSemanticNarrativeQa } from '../../src/application/interpretation/semantic-qa.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';
import {
  FIXTURE_LLM_ENV,
  validKnownTimeAnswer,
  validUnknownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type { FixtureAnswer, FixtureSection } from '../support/llmNarrativeFixture.js';

type Chart = 'known' | 'unknown';

function modelFor(chart: Chart): HoroscopeModel {
  return chart === 'known' ? knownTimeModel() : unknownTimeModel();
}

function answerFor(chart: Chart): FixtureAnswer {
  return chart === 'known' ? validKnownTimeAnswer() : validUnknownTimeAnswer();
}

function reportOf(chart: Chart, answer: FixtureAnswer): ReportModel {
  const model = modelFor(chart);
  const chain = buildNarrativeChain(model);
  return buildReportModel({
    model,
    brief: chain.brief,
    providerOutput: {
      providerId: 'hardening-fixture',
      briefStructuralHash: chain.brief.structuralHash,
      sections: answer.sections,
    },
  });
}

function sectionOf(answer: FixtureAnswer, themeId: string): FixtureSection {
  const section = answer.sections.find((candidate) => candidate.themeId === themeId);
  if (section === undefined) {
    throw new Error(`fixture defect: no section "${themeId}"`);
  }
  return section;
}

/** Runs one mutated answer and returns the refusal codes, in order. */
function codesFor(chart: Chart, mutate: (answer: FixtureAnswer) => void): readonly string[] {
  const answer = answerFor(chart);
  mutate(answer);
  return runSemanticNarrativeQa(reportOf(chart, answer)).findings.map((finding) => finding.code);
}

const SELF_ROLE = 'primary.self_role';
const SEASONAL = 'primary.seasonal_anchor';
const ELEMENTAL = 'primary.elemental_profile';
const POSITIONAL = 'primary.positional_context';

describe('ETBZ-25B hardening H1: certainty is checked on EVERY surface, not only prose', () => {
  // THE BYPASS: the certainty scan ran against the surface labelled `prose` and
  // skipped the uncertainty notes entirely — so the one surface whose whole job
  // is to state an unknown was the one surface allowed to assert certainty. A
  // note reading "die Stundenangabe ist unbekannt, aber diese Deutung gilt
  // zweifellos" passed every gate.
  it('refuses a certainty word placed inside the uncertainty note', () => {
    const codes = codesFor('unknown', (answer) => {
      sectionOf(answer, POSITIONAL).uncertaintyNotes = [
        'Vorläufig: die Stundenangabe ist unbekannt, doch diese Deutung gilt zweifellos.',
      ];
    });

    expect(codes).toContain('QA_PROVISIONAL_CERTAINTY');
  });

  it('names the note as the offending surface, so the refusal can be located', () => {
    const answer = validUnknownTimeAnswer();
    sectionOf(answer, POSITIONAL).uncertaintyNotes = [
      'Vorläufig: die Stunde ist unbekannt, die Wirkung ist aber definitiv vorhanden.',
    ];

    const finding = runSemanticNarrativeQa(reportOf('unknown', answer)).findings.find(
      (candidate) => candidate.code === 'QA_PROVISIONAL_CERTAINTY',
    );

    expect(finding?.surface).toBe('uncertaintyNotes[0]');
    expect(finding?.themeId).toBe(POSITIONAL);
  });

  it('positive control: the unmutated unknown-time answer still passes', () => {
    expect(runSemanticNarrativeQa(reportOf('unknown', validUnknownTimeAnswer())).status).toBe(
      'PASS',
    );
  });
});

describe('ETBZ-25B hardening H2: multi-word terms survive whitespace variation', () => {
  // THE BYPASS: matching ran against text that was NFC-normalised and case-folded
  // but NOT whitespace-collapsed, while the terms worth catching are mostly
  // multi-word ("mit sicherheit", "tief in dir", "dein schicksal"). Any writer
  // or model producing a line break, a double space or a non-breaking space
  // between the words defeated the lexicon for free — and got a clean PASS.
  const SEPARATORS: readonly (readonly [string, string])[] = [
    ['double space', '  '],
    ['line break', '\n'],
    ['non-breaking space', ' '],
    ['thin space', ' '],
    ['tab', '\t'],
  ];

  it.each(SEPARATORS)('still catches a certainty phrase split by a %s', (_label, separator) => {
    const codes = codesFor('unknown', (answer) => {
      const section = sectionOf(answer, POSITIONAL);
      section.prose = `${section.prose} Das gilt mit${separator}Sicherheit.`;
    });

    expect(codes).toContain('QA_PROVISIONAL_CERTAINTY');
  });

  it.each(SEPARATORS)('still catches a Barnum phrase split by a %s', (_label, separator) => {
    const codes = codesFor('known', (answer) => {
      const section = sectionOf(answer, SELF_ROLE);
      section.prose = `${section.prose} Tief${separator}in${separator}dir weißt du das.`;
    });

    expect(codes).toContain('QA_BARNUM_PHRASE');
  });

  it.each(SEPARATORS)(
    'still catches a prohibited claim split by a %s',
    (_label, separator) => {
      const codes = codesFor('known', (answer) => {
        const section = sectionOf(answer, SELF_ROLE);
        section.prose = `${section.prose} Dein${separator}Schicksal liegt darin.`;
      });

      expect(codes).toContain('QA_PROHIBITED_CLAIM');
    },
  );
});

describe('ETBZ-25B hardening H3: a SWAPPED role pair is refused', () => {
  // THE BYPASS: the gate accepted a symbol if ANY compatible role word appeared
  // anywhere in its window. A sentence naming two symbols with their roles
  // EXCHANGED therefore passed — each symbol found a compatible role word right
  // there, because it was the OTHER symbol's correct one. Two wrong statements
  // read as two right ones, and the sentence shipped.
  it('refuses "der Erdzweig Xin und der Himmelsstamm Hai"', () => {
    const codes = codesFor('known', (answer) => {
      const section = sectionOf(answer, POSITIONAL);
      section.citedFacts = [
        { factId: 'chart.pillar.day.stem', value: 'Xin' },
        { factId: 'chart.pillar.day.branch', value: 'Hai' },
        { factId: 'chart.pillar.year.stem', value: 'Geng' },
      ];
      // Both classifiers present, both attached to the wrong symbol.
      section.prose =
        'Der Erdzweig Xin und der Himmelsstamm Hai stehen in deiner Tagessäule zusammen mit dem Himmelsstamm Geng und beschreiben, wie du dich privat zeigst.';
      section.uncertaintyNotes = [];
    });

    expect(codes).toContain('QA_FACT_ROLE_MISMATCH');
  });

  it('refuses a misclassification rescued by a later apposition', () => {
    // The old rule was also defeated by appending the correct role word after
    // the wrong one: "der Erdzweig Xin, ein Himmelsstamm" passed. Only the
    // NEAREST classifier counts now, and it is the wrong one.
    const codes = codesFor('known', (answer) => {
      const section = sectionOf(answer, POSITIONAL);
      section.citedFacts = [
        { factId: 'chart.pillar.day.stem', value: 'Xin' },
        { factId: 'chart.pillar.year.stem', value: 'Geng' },
      ];
      section.prose =
        'Der Erdzweig Xin, ein Himmelsstamm, steht zusammen mit dem Himmelsstamm Geng für die Art, in der du dich zeigst.';
      section.uncertaintyNotes = [];
    });

    expect(codes).toContain('QA_FACT_ROLE_MISMATCH');
  });

  it('positive control: the correctly roled baseline still passes', () => {
    expect(runSemanticNarrativeQa(reportOf('known', validKnownTimeAnswer())).status).toBe('PASS');
  });
});

describe('ETBZ-25B hardening H4: a mail-merged reading is refused', () => {
  // THE BYPASS: the anchoring rule asked for at least ONE cited term per
  // chapter. That is satisfiable by writing one universal paragraph and dropping
  // a different chart symbol into each copy: every chapter is "anchored", every
  // chapter differs textually so the duplicate-prose guard stays silent, and the
  // whole reading is a template. Requiring two terms per chapter means a chapter
  // has to be about a COMBINATION, which one merge slot cannot fake.
  it('refuses four chapters that each name exactly one chart term', () => {
    const codes = codesFor('known', (answer) => {
      const merge = (themeId: string, term: string, roleWord: string, tail: string): void => {
        const section = sectionOf(answer, themeId);
        section.prose = `Viele Menschen tragen einen inneren Widerspruch mit sich herum. ${roleWord} ${term} ${tail}`;
        section.uncertaintyNotes = [];
      };
      merge(SELF_ROLE, 'Xin', 'Der Tagesmeister', 'steht dafür, und das prägt den Alltag leise.');
      merge(SEASONAL, 'Pferd', 'Das Tierzeichen', 'steht dafür, und das prägt den Alltag deutlich.');
      merge(ELEMENTAL, 'Feuer', 'Das Element', 'steht dafür, und das prägt den Alltag stark.');
      merge(POSITIONAL, 'Geng', 'Der Himmelsstamm', 'steht dafür, und das prägt den Alltag früh.');
    });

    expect(codes).toContain('QA_UNANCHORED_PROSE');
  });
});

describe('ETBZ-25B hardening H5: the base URL a credential may be sent to', () => {
  // THE BYPASS: a base URL carrying inline credentials
  // (`https://user:secret@host/v1`) was accepted, and `RouteEligibility.baseUrl`
  // is published into the run evidence as a NON-SECRET field. The sanitizer
  // cannot recognise a password it was never told about, so the credential
  // reached the evidence record and cleared every check.
  it.each([
    ['inline credentials', 'https://user:secret@provider.invalid/v1'],
    ['inline username only', 'https://user@provider.invalid/v1'],
    ['plaintext http to a remote host', 'http://provider.invalid/v1'],
    ['not a URL at all', 'provider.invalid/v1'],
  ])('refuses a base URL with %s', (_label, baseUrl) => {
    expect(isAcceptableBaseUrl(baseUrl)).toBe(false);

    const plan = buildLlmRoutePlan({ ...FIXTURE_LLM_ENV, TOKENROUTER_BASE_URL: baseUrl });
    const verdict = plan.eligibility.find((entry) => entry.routeId === 'tokenrouter');

    expect(verdict?.eligible).toBe(false);
    expect(verdict?.ineligibleReason).toBe('base_url_not_acceptable');
    // And the refused URL is not republished in the verdict that refused it.
    expect(verdict?.baseUrl).toBeNull();
    expect(plan.routes.some((route) => route.routeId === 'tokenrouter')).toBe(false);
  });

  it.each([
    ['https', 'https://provider.invalid/v1'],
    ['http on loopback', 'http://127.0.0.1:8080/v1'],
    ['http on localhost', 'http://localhost:8080/v1'],
  ])('accepts %s', (_label, baseUrl) => {
    expect(isAcceptableBaseUrl(baseUrl)).toBe(true);
  });
});

describe('ETBZ-25B hardening H6: an incomplete answer is recognised by every spelling', () => {
  // THE BYPASS: the truncation guard compared against the single literal
  // `'length'`, so `MAX_TOKENS` and `content_filter` — the same condition as
  // other providers spell it — passed as COMPLETE answers. A half-written
  // reading that happens to parse is the worst thing to let through, because
  // nothing downstream can tell it was cut.
  it.each(['length', 'LENGTH', 'MAX_TOKENS', 'max_tokens', 'max-tokens', 'content_filter'])(
    'treats finish_reason %s as incomplete',
    (finishReason) => {
      expect(isIncompleteFinishReason(finishReason)).toBe(true);
    },
  );

  it.each(['stop', 'STOP', 'end_turn', null])('treats finish_reason %s as complete', (value) => {
    expect(isIncompleteFinishReason(value)).toBe(false);
  });
});

describe('ETBZ-25B hardening H7: the deadline covers the BODY, not just the headers', () => {
  // THE BYPASS: the abort timer was cleared as soon as the response headers
  // arrived. With a streamed answer the headers and the last token are minutes
  // apart, so a route that returned 200 and then stalled mid-body had NO
  // deadline at all: the run hung forever, with no timeout, no failover and no
  // refusal. The deadline has to cover the part that actually takes the time.
  it('aborts a 200 whose body never finishes', async () => {
    const route = {
      routeId: 'tokenrouter' as const,
      order: 1,
      baseUrl: 'https://provider.invalid/v1',
      model: 'vendor/model-free',
      apiKey: 'fixture-key',
      noChargeBasis: 'provider_free_model_tier' as const,
      timeoutMs: 250,
    };
    const request: LlmChatRequest = {
      system: 's',
      user: 'u',
      maxTokens: 16,
      temperature: 0,
      jsonObjectMode: true,
      stream: true,
    };

    // A stream that emits one frame and then never closes. Without a live
    // deadline this await never returns and the test times out instead of
    // failing, which is itself the symptom being prevented.
    const transport: Transport = {
      fetch(_url: string, init: RequestInit): Promise<Response> {
        const signal = init.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'),
            );
            signal?.addEventListener('abort', () => {
              controller.error(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    };

    const error: unknown = await requestChatCompletion(route, request, transport).catch(
      (caught: unknown) => caught,
    );

    // NOT merely "it threw". An earlier version of this assertion checked only
    // that something was thrown, and it stayed green while the abort escaped as
    // a raw AbortError from inside the stream reader — past the classification,
    // past the attempt ledger, past failover. A slow provider then surfaced as
    // an unclassified crash with no evidence. The TYPE is the property: a
    // deadline must become a transient LLM_TIMEOUT belonging to this route, or
    // nothing downstream can act on it.
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      code: 'LLM_TIMEOUT',
      failureClass: 'transient',
      routeId: 'tokenrouter',
    });
    expect((error as Error).message).not.toContain(route.apiKey);
  }, 10_000);

  it('classifies a stream that breaks part-way as transient, and keeps nothing partial', async () => {
    // The other way a stream ends early. Failover is authorised because the
    // route became unavailable mid-answer — and the partial text is discarded
    // with the attempt, which is what keeps "no continuation, no blending" true
    // even when a route dies halfway through a reading.
    const route = {
      routeId: 'tokenrouter' as const,
      order: 1,
      baseUrl: 'https://provider.invalid/v1',
      model: 'vendor/model-free',
      apiKey: 'fixture-key',
      noChargeBasis: 'provider_free_model_tier' as const,
      timeoutMs: 30_000,
    };
    const transport: Transport = {
      fetch(): Promise<Response> {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"{\\"sections\\":["}}]}\n\n',
              ),
            );
            controller.error(new Error('connection reset by peer'));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    };

    const error: unknown = await requestChatCompletion(
      route,
      {
        system: 's',
        user: 'u',
        maxTokens: 16,
        temperature: 0,
        jsonObjectMode: true,
        stream: true,
      },
      transport,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({ code: 'LLM_NETWORK_ERROR', failureClass: 'transient' });
    // The half-written reading is not on the error, and therefore cannot reach
    // a report, a retry or another provider.
    expect(JSON.stringify(error)).not.toContain('sections');
  });

  it('still clears the deadline on a completed call, leaving no dangling timer', async () => {
    // The positive control for the same change: moving the clear later must not
    // mean never clearing it.
    const route = {
      routeId: 'tokenrouter' as const,
      order: 1,
      baseUrl: 'https://provider.invalid/v1',
      model: 'vendor/model-free',
      apiKey: 'fixture-key',
      noChargeBasis: 'provider_free_model_tier' as const,
      timeoutMs: 60_000,
    };
    const transport: Transport = {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'x',
              model: 'vendor/model-free',
              choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            }),
            { status: 200 },
          ),
        ),
    };

    const completion = await requestChatCompletion(
      route,
      {
        system: 's',
        user: 'u',
        maxTokens: 16,
        temperature: 0,
        jsonObjectMode: true,
        stream: false,
      },
      transport,
    );

    expect(completion.content).toBe('{"ok":true}');
  });
});

describe('ETBZ-25B hardening H8: a non-200 is never mistaken for a stream failure', () => {
  it('classifies a rate-limited streamed request as transient, not as a broken stream', async () => {
    const route = {
      routeId: 'tokenrouter' as const,
      order: 1,
      baseUrl: 'https://provider.invalid/v1',
      model: 'vendor/model-free',
      apiKey: 'fixture-key',
      noChargeBasis: 'provider_free_model_tier' as const,
      timeoutMs: 5_000,
    };
    const transport: Transport = {
      fetch: () => Promise.resolve(new Response('{"error":"slow down"}', { status: 429 })),
    };

    const error: unknown = await requestChatCompletion(
      route,
      { system: 's', user: 'u', maxTokens: 16, temperature: 0, jsonObjectMode: true, stream: true },
      transport,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({ code: 'LLM_RATE_LIMITED', failureClass: 'transient' });
  });
});

describe('ETBZ-25B hardening H9: every certainty word the prompt names is actually refused', () => {
  // THE DIVERGENCE, not a bypass this time but its mirror image: the prompt
  // named six of the twenty-five words `CERTAINTY_TERMS` refuses, so nineteen
  // of them were refusals a provider could not have avoided by reading the
  // instructions. v2 renders the list from the constant, which closes the gap
  // in one direction only — the prompt now states every word the gate HOLDS.
  // These cases close the other direction: every word the prompt states is a
  // word the gate actually blocks, on BOTH surfaces it reads.
  //
  // Four of the twenty-five were already proven behaviourally in
  // `narrative-semantic-qa.negative.test.ts`. A vocabulary the prompt publishes
  // in full deserves a proof in full: without it, a term could be deleted from
  // the gate's loop and the prompt would go on announcing it.

  it.each([...CERTAINTY_TERMS])('refuses "%s" in the prose of a provisional section', (term) => {
    const codes = codesFor('unknown', (answer) => {
      const section = sectionOf(answer, POSITIONAL);
      section.prose = `${section.prose} Diese Lesart gilt ${term} als Beobachtung.`;
    });

    expect(codes).toContain('QA_PROVISIONAL_CERTAINTY');
  });

  it.each([...CERTAINTY_TERMS])('refuses "%s" in the note of a provisional section', (term) => {
    const codes = codesFor('unknown', (answer) => {
      const section = sectionOf(answer, POSITIONAL);
      const [note] = section.uncertaintyNotes;
      if (note === undefined) throw new Error('fixture defect: the section carries no note');
      section.uncertaintyNotes = [`${note} Die Deutung gilt ${term} als Beobachtung.`];
    });

    expect(codes).toContain('QA_PROVISIONAL_CERTAINTY');
  });

  it('positive control: the same sentence without a certainty word passes', () => {
    // The carrier sentence is what every case above adds; if it were refused on
    // its own, the twenty-five results would say nothing about the words.
    const codes = codesFor('unknown', (answer) => {
      const section = sectionOf(answer, POSITIONAL);
      section.prose = `${section.prose} Diese Lesart gilt als Beobachtung.`;
    });

    expect(codes).toEqual([]);
  });

  it('positive control: certainty is allowed where nothing is provisional', () => {
    // The gate is about provisionality, not about the words as such. A section
    // that cites no provisional fact may write them, and the known-time chart
    // has none — so this refuses nothing, which is the correct behaviour and
    // the reason the cases above run on the unknown-time chart.
    const codes = codesFor('known', (answer) => {
      const section = sectionOf(answer, SELF_ROLE);
      section.prose = `${section.prose} Das ist zweifellos ein Muster.`;
    });

    expect(codes).not.toContain('QA_PROVISIONAL_CERTAINTY');
  });
});

describe('ETBZ-25B hardening H10: a CONSTRUCTED factId is refused, never repaired', () => {
  // THE DEFECT, copied from the run that produced it rather than invented to
  // fit the fix. A real route returned well-formed German citing
  // `chart.pillar.year.tenGod`. That id does not exist in this chart — but
  // `chart.pillar.year.stem` does, and so does `chart.natal.pillar.year.tenGod`,
  // and the model had taken the prefix of the first and the leaf of the second.
  //
  // The value it carried was the REAL value of the real fact, which is what
  // makes this the tempting case: a "helpful" resolver could match the id to
  // the fact it obviously meant. Doing so would let the provider's guess decide
  // which chart fact a sentence is about, which is the one thing Fact Integrity
  // exists to prevent. The gate refuses, and the whole report goes with it.

  const FABRICATED = 'chart.pillar.year.tenGod';
  const REAL = 'chart.natal.pillar.year.tenGod';

  function selfRoleCiting(factId: string): FixtureAnswer {
    const answer = validKnownTimeAnswer();
    const section = sectionOf(answer, SELF_ROLE);
    const cited = section.citedFacts.find((candidate) => candidate.factId === REAL);
    if (cited === undefined) throw new Error(`fixture defect: no section cites "${REAL}"`);
    section.citedFacts = section.citedFacts.map((candidate) =>
      candidate.factId === REAL ? { ...candidate, factId } : candidate,
    );
    return answer;
  }

  it('the chart really carries the fact the fabricated id resembles', () => {
    const ids = buildNarrativeChain(knownTimeModel()).brief.facts.map((fact) => fact.id);
    expect(ids).toContain(REAL);
    expect(ids).toContain('chart.pillar.year.stem');
    expect(ids).not.toContain(FABRICATED);
  });

  it('refuses the report outright', () => {
    expect(() => reportOf('known', selfRoleCiting(FABRICATED))).toThrowError(
      expect.objectContaining({ code: 'REPORT_UNKNOWN_FACT' }),
    );
  });

  it('does not map the invented id onto the real fact it resembles', () => {
    // Stated as a behaviour rather than as an absence of code: a future
    // "fuzzy id" convenience would make the assertion above pass by resolving
    // the id, and only this one would notice.
    const outcome = ((): string => {
      try {
        return `BUILT:${reportOf('known', selfRoleCiting(FABRICATED)).structuralHash}`;
      } catch (error) {
        return `REFUSED:${error instanceof ReportError ? error.code : 'UNEXPECTED_ERROR_TYPE'}`;
      }
    })();

    expect(outcome).toBe('REFUSED:REPORT_UNKNOWN_FACT');
  });

  it('positive control: the same answer with the real id is accepted', () => {
    // The mutation is one character sequence in one factId. Without this, the
    // refusal above could be about anything else in the answer.
    const report = reportOf('known', selfRoleCiting(REAL));
    expect(report.interpretation.map((section) => section.themeId)).toContain(SELF_ROLE);
    expect(runSemanticNarrativeQa(report).status).toBe('PASS');
  });
});
