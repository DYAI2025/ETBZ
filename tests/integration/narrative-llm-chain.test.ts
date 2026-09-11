import { describe, expect, it } from 'vitest';

import {
  generateNarrativeFromPlan,
  providerIdFor,
} from '../../src/adapters/llm/llm-narrative-provider.js';
import type { LlmNarrativeResult } from '../../src/adapters/llm/llm-narrative-provider.js';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import type { LlmRouteConfig } from '../../src/app/configuration/llm-routes.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import {
  GOLDEN_READING_VERSION,
  GoldenReadingError,
  buildGoldenReading,
  renderGoldenReadingText,
} from '../../src/application/interpretation/golden-reading.js';
import type { GoldenReading } from '../../src/application/interpretation/golden-reading.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import type { NarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type {
  ReportModel,
  ReportSection,
} from '../../src/application/interpretation/report-model.js';
import {
  NARRATIVE_QA_GATES,
  NARRATIVE_QA_VERSION,
  runSemanticNarrativeQa,
} from '../../src/application/interpretation/semantic-qa.js';
import type { NarrativeQaResult } from '../../src/application/interpretation/semantic-qa.js';
import {
  FIXTURE_LLM_ENV,
  answerAsProviderText,
  completionBody,
  fakeTransport,
  validKnownTimeAnswer,
  validUnknownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type {
  FakeTransport,
  FixtureAnswer,
  RecordedRequest,
  ScriptedReply,
} from '../support/llmNarrativeFixture.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B — the WHOLE chain, once, offline: chart in, Golden Reading out.
 *
 * Every other test file in this slice measures ONE joint. `llm-routes` proves
 * the cost gate, `openai-compatible-client` proves the transport, the failover
 * negatives prove what failover may and may not do, `report-model` proves the
 * structural gate, `narrative-semantic-qa` proves the five semantic gates. All
 * of them can be green while the pipeline they belong to is broken, because a
 * unit test of a joint never asks whether the joints are actually connected.
 *
 * This file asks exactly that, and it asks it of the REAL production functions
 * in the real order:
 *
 *   HoroscopeModel
 *     -> buildNarrativeChain          (deterministic: feature set, themes, brief)
 *     -> generateNarrativeFromPlan    (the adapter, over a FAKE transport)
 *     -> buildReportModel             (the structural gate, re-deriving the chain)
 *     -> runSemanticNarrativeQa       (the five semantic gates)
 *     -> buildGoldenReading           (the artefact a human judges)
 *     -> renderGoldenReadingText      (what that human actually reads)
 *
 * WHY THE TRANSPORT IS FAKE AND NOTHING ELSE IS. The only non-deterministic
 * component in the chain is the provider. Replacing it with a scripted reply
 * carrying the verified-good fixture answer is what makes every OTHER property
 * measurable: with the answer held constant, a changed report hash is caused by
 * ETBZ's own code and by nothing else. Nothing here needs a network, a
 * credential or a cent — `tests/live/golden-reading.live.test.ts` is where a
 * real provider is exercised, and it is excluded from the CI gate on purpose.
 *
 * WHAT THIS FILE PROVES, each stated as a property rather than as a step:
 *
 *  E1 The chain produces a reading at all, and the provider's prose survives
 *     every gate byte-for-byte instead of being "normalised" somewhere.
 *  E2 THE HASH CHAIN IS CONTINUOUS. Each artefact carries the identity of the
 *     one before it — brief -> report -> QA verdict -> reading — so a reading
 *     cannot be assembled on a verdict computed for a different candidate.
 *  E3 PROVENANCE NAMES THE ROUTE THAT ANSWERED, not the route that was tried
 *     first. Proven by making route 1 fail transiently and reading the name
 *     that comes out the far end.
 *  E4 UNKNOWN-TIME QUALIFICATION SURVIVES END TO END, and is asserted on the
 *     RENDERED artefact. A provisionality that is present in the model and
 *     absent from the page a customer reads has not survived anything; the
 *     contract's "unknown-time fixture preserves qualification end-to-end"
 *     requirement is about the page.
 *  E5 THE DETERMINISTIC HALF IS DETERMINISTIC. Same chart, same answer, twice:
 *     byte-identical report, verdict and reading.
 *  E6 THE CREDENTIAL TRAVELS IN THE AUTHORIZATION HEADER AND IN NO ARTEFACT
 *     THIS CHAIN PRODUCES.
 *
 * Every contrast in this file is a PAIR: the unknown-time chart is asserted to
 * carry markings the known-time chart is asserted not to carry, and vice versa.
 * A single-sided assertion about German text would pass just as happily against
 * a renderer that emitted that string unconditionally.
 *
 * No real person's data is involved: both charts are the synthetic fixtures
 * ETBZ-24 / ETBZ-29 / ETBZ-25A already use.
 */

/** The plan every run below uses. Four approved routes, three eligible. */
const PLAN = buildLlmRoutePlan(FIXTURE_LLM_ENV);

/** The endpoints of the two eligible routes this file actually addresses. */
const ROUTE_1_URL = 'https://provider.invalid/one/v1/chat/completions';
const ROUTE_3_URL = 'https://provider.invalid/three/v1/chat/completions';

/** Fixture credentials. Fake values, and the only secrets in this file. */
const ROUTE_1_KEY = 'fixture-key-one';
const ROUTE_3_KEY = 'fixture-key-three';

/** The theme whose section carries the unknown-time chart's provisionality. */
const PROVISIONAL_THEME_ID = 'primary.positional_context';

/**
 * The unknown-time chart's provisional facts, enumerated.
 *
 * Written out rather than derived from the report under test, because deriving
 * the expectation from the subject would make this assertion true by
 * construction. The list is what "the hour pillar is provisional" means
 * concretely, and a chart fact silently leaving or joining it is a change to
 * the product's uncertainty surface that should fail loudly here.
 */
const UNKNOWN_TIME_PROVISIONAL_FACT_IDS: readonly string[] = [
  'chart.natal.pillar.hour.hiddenStem.0.element',
  'chart.natal.pillar.hour.hiddenStem.0.stem',
  'chart.natal.pillar.hour.hiddenStem.0.tenGod',
  'chart.natal.pillar.hour.hiddenStem.1.element',
  'chart.natal.pillar.hour.hiddenStem.1.stem',
  'chart.natal.pillar.hour.hiddenStem.1.tenGod',
  'chart.natal.pillar.hour.hiddenStem.2.element',
  'chart.natal.pillar.hour.hiddenStem.2.stem',
  'chart.natal.pillar.hour.hiddenStem.2.tenGod',
  'chart.natal.pillar.hour.tenGod',
  'chart.pillar.hour.branch',
  'chart.pillar.hour.branchHanzi',
  'chart.pillar.hour.branchPinyin',
  'chart.pillar.hour.stem',
  'chart.pillar.hour.stemElement',
  'chart.pillar.hour.stemHanzi',
  'chart.pillar.hour.stemPinyin',
  'chart.pillar.hour.tier',
] as const;

/** FuFirE's warnings for each fixture chart, in the source's own order. */
const KNOWN_TIME_WARNINGS: readonly string[] = ['DAY_ANCHOR_UNVERIFIED'] as const;
const UNKNOWN_TIME_WARNINGS: readonly string[] = [
  'DAY_ANCHOR_UNVERIFIED',
  'BIRTH_TIME_UNKNOWN',
] as const;

/** The marking `golden-reading.ts` puts beside a provisional chart fact. */
const PROVISIONAL_MARKING = '[vorläufig]';

/**
 * One eligible route of the fixture plan.
 *
 * `noUncheckedIndexedAccess` makes the index access optional; throwing here
 * rather than asserting non-null keeps a missing route an explicit failure that
 * names what was missing instead of a `TypeError` three frames away.
 */
function eligibleRouteAt(index: number): LlmRouteConfig {
  const route = PLAN.routes[index];
  if (route === undefined) {
    throw new Error(
      `expected an eligible route at index ${String(index)}, but the fixture plan has ${String(
        PLAN.routes.length,
      )}`,
    );
  }
  return route;
}

/** A 200 carrying the verified-good fixture answer, exactly as a provider would. */
function validReply(answer: FixtureAnswer): ScriptedReply {
  return { status: 200, body: completionBody(answerAsProviderText(answer)) };
}

/** A provider error status with a body a real provider would send alongside it. */
function statusReply(status: number): ScriptedReply {
  return { status, body: { error: { message: 'scripted provider failure' } } };
}

function requestAt(transport: FakeTransport, index: number): RecordedRequest {
  const request = transport.requests[index];
  if (request === undefined) {
    throw new Error(
      `expected a recorded request at index ${String(index)}, but the transport recorded ${String(
        transport.requests.length,
      )}`,
    );
  }
  return request;
}

function sectionOf(report: ReportModel, themeId: string): ReportSection {
  const section = report.interpretation.find((candidate) => candidate.themeId === themeId);
  if (section === undefined) {
    throw new Error(
      `the report carries no section for theme "${themeId}"; it carries ${report.interpretation
        .map((candidate) => candidate.themeId)
        .join(', ')}`,
    );
  }
  return section;
}

/** The provider-authored notes the report kept for one theme, or none. */
function providerNotesOf(report: ReportModel, themeId: string): readonly string[] {
  return report.uncertainty.providerNotes.find((note) => note.themeId === themeId)?.notes ?? [];
}

/** The uncertainty note the unknown-time FIXTURE ANSWER carries, at its source. */
function fixtureProvisionalNote(): string {
  const section = validUnknownTimeAnswer().sections.find(
    (candidate) => candidate.themeId === PROVISIONAL_THEME_ID,
  );
  const note = section?.uncertaintyNotes[0];
  if (note === undefined) {
    throw new Error(
      `fixture defect: the unknown-time answer's "${PROVISIONAL_THEME_ID}" section carries no uncertainty note`,
    );
  }
  return note;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every artefact one pass through the chain produced, kept for inspection. */
interface ChainRun {
  readonly chain: NarrativeChain;
  readonly result: LlmNarrativeResult;
  readonly report: ReportModel;
  readonly qa: NarrativeQaResult;
  readonly reading: GoldenReading;
  readonly readingText: string;
  readonly transport: FakeTransport;
}

/**
 * Runs the whole chain once, with a scripted provider.
 *
 * The default script holds the SAME valid reply twice on purpose. Every
 * "exactly one request" assertion in this file is then a statement about the
 * adapter's decision rather than about the script running dry: a second request
 * would have been answered, and was not made.
 *
 * A blocked QA verdict is raised here as an error naming the finding codes
 * instead of being carried into `buildGoldenReading`, whose own refusal would
 * report the blockage without saying what it was.
 */
async function runChain(
  model: HoroscopeModel,
  answer: FixtureAnswer,
  script: readonly ScriptedReply[] = [validReply(answer), validReply(answer)],
): Promise<ChainRun> {
  const chain = buildNarrativeChain(model);
  const transport = fakeTransport(script);

  const result = await generateNarrativeFromPlan(chain.brief, PLAN, transport);

  // The structural gate. It re-derives the chain from the HoroscopeModel, so
  // passing it is a statement about the chart and not about the brief we
  // happened to hand over.
  const report = buildReportModel({
    model,
    brief: chain.brief,
    providerOutput: result.providerOutput,
  });

  const qa = runSemanticNarrativeQa(report);
  if (qa.status !== 'PASS') {
    throw new Error(
      `the verified-good fixture answer was BLOCKED by the semantic QA: ${qa.findings
        .map((finding) => `${finding.code}@${finding.themeId ?? 'report'}`)
        .join(', ')}`,
    );
  }

  const reading = buildGoldenReading(report, qa);
  return { chain, result, report, qa, reading, readingText: renderGoldenReadingText(reading), transport };
}

describe('ETBZ-25B E0: the premise every assertion below is read against', () => {
  it('offers tokenrouter as the first eligible route and opencode as the next one', () => {
    // Stated first because E3 distinguishes "the route that answered" from "the
    // route that was tried first", and that distinction needs two named routes.
    expect(PLAN.routes.map((route) => route.routeId)).toEqual([
      'tokenrouter',
      'opencode',
      'openrouter',
    ]);
    expect(eligibleRouteAt(0).routeId).toBe('tokenrouter');
    expect(eligibleRouteAt(1).routeId).toBe('opencode');
  });

  it('addresses those two routes at the endpoints this file asserts against', () => {
    expect(`${eligibleRouteAt(0).baseUrl}/chat/completions`).toBe(ROUTE_1_URL);
    expect(`${eligibleRouteAt(1).baseUrl}/chat/completions`).toBe(ROUTE_3_URL);
  });

  it('runs under a zero cost cap with no paid path, so no run below can be billable', () => {
    expect(PLAN.approvedCostCapEur).toBe(0);
    expect(PLAN.allowPaid).toBe(false);
  });
});

describe('ETBZ-25B E1: the chain turns a chart into a Golden Reading', () => {
  it('produces a reading a human can be asked to judge', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.reading.goldenReadingVersion).toBe(GOLDEN_READING_VERSION);
    expect(run.reading.status).toBe('CANDIDATE_READY_FOR_HUMAN_REVIEW');
    expect(run.reading.subjectDisplayName).toBe('Musterkundin A');
  });

  it('passes the semantic QA with zero findings and with all five gates executed', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.qa.status).toBe('PASS');
    expect(run.qa.findings).toEqual([]);
    // A gate missing from `gatesRun` did not run. Asserting the list is the
    // difference between "no gate objected" and "no gate looked".
    expect(run.qa.gatesRun).toEqual(NARRATIVE_QA_GATES);
    expect(run.qa.qaVersion).toBe(NARRATIVE_QA_VERSION);
  });

  it('assembles the seven customer-facing blocks, in the Product Owner’s order', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.reading.sections.map((section) => section.id)).toEqual([
      'data_basis',
      'four_pillars',
      'day_master',
      'wu_xing',
      'interpretation',
      'reflection',
      'method_and_uncertainty',
    ]);
  });

  it('carries the provider’s prose through every gate unchanged, section for section', async () => {
    const answer = validKnownTimeAnswer();

    const run = await runChain(knownTimeModel(), answer);

    // The strongest form of "the chain transports rather than edits": the text
    // in the validated report is the text the fixture put on the wire, in the
    // same order, with no normalisation, trimming or re-wrapping in between.
    expect(run.report.interpretation.map((section) => section.themeId)).toEqual(
      answer.sections.map((section) => section.themeId),
    );
    expect(run.report.interpretation.map((section) => section.prose)).toEqual(
      answer.sections.map((section) => section.prose),
    );
  });

  it('prints that same prose into the reading a human actually reads', async () => {
    const answer = validKnownTimeAnswer();

    const run = await runChain(knownTimeModel(), answer);

    // Asserted on the RENDERED text, because a paragraph that survives into the
    // model and not onto the page has not survived the chain.
    for (const section of answer.sections) {
      expect(run.readingText).toContain(section.prose);
    }
  });

  it('accepts the answer on the first route and records the attempt as free', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.result.acceptedRouteId).toBe('tokenrouter');
    expect(run.result.attempts.map((attempt) => attempt.outcome)).toEqual(['accepted']);
    // Null, not zero: the fixture provider reports token counts and no cost.
    expect(run.result.attempts.map((attempt) => attempt.reportedCost)).toEqual([null]);
  });
});

describe('ETBZ-25B E2: the hash chain from brief to reading is continuous', () => {
  it('binds the report to the brief the provider was actually handed', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.report.provenance.briefStructuralHash).toBe(run.chain.brief.structuralHash);
    // The same value travelled through the prompt and back on the answer, so
    // the binding is not something the report re-derived for itself.
    expect(run.result.prompt.briefStructuralHash).toBe(run.chain.brief.structuralHash);
    expect(run.result.providerOutput.briefStructuralHash).toBe(run.chain.brief.structuralHash);
    expect(run.chain.brief.structuralHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('binds the QA verdict to the report it judged, and the reading to both', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.qa.reportStructuralHash).toBe(run.report.structuralHash);
    expect(run.qa.briefStructuralHash).toBe(run.chain.brief.structuralHash);
    expect(run.reading.qaStructuralHash).toBe(run.qa.structuralHash);
    expect(run.reading.reportStructuralHash).toBe(run.report.structuralHash);
    expect(run.reading.briefStructuralHash).toBe(run.chain.brief.structuralHash);
  });

  it('prints the whole chain onto the page, so the link is auditable without the code', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(run.readingText).toContain(`Reading-Hash : ${run.reading.structuralHash}`);
    expect(run.readingText).toContain(`Report-Hash  : ${run.report.structuralHash}`);
    expect(run.readingText).toContain(`Brief-Hash   : ${run.chain.brief.structuralHash}`);
    expect(run.readingText).toContain(`QA-Hash      : ${run.qa.structuralHash}`);
  });

  it('re-assembles the identical reading from the identical report and verdict (positive control)', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    // The control for the refusal below: with the MATCHING verdict, assembly
    // succeeds and is byte-stable. The refusal is therefore about the mismatch
    // and not about `buildGoldenReading` being hard to satisfy.
    expect(buildGoldenReading(run.report, run.qa).structuralHash).toBe(
      run.reading.structuralHash,
    );
  });

  it('refuses to assemble a reading on a verdict computed for a different report', async () => {
    const known = await runChain(knownTimeModel(), validKnownTimeAnswer());
    const other = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    // Exactly one thing changes against the control above: the verdict. It is a
    // genuine PASS verdict — just not this candidate's — which is the case a
    // hash comparison exists to catch and a status check would wave through.
    expect(other.qa.status).toBe('PASS');
    expect(() => buildGoldenReading(known.report, other.qa)).toThrow(GoldenReadingError);
    expect(() => buildGoldenReading(known.report, other.qa)).toThrow(/different report/u);
  });
});

describe('ETBZ-25B E3: provenance names the route that answered', () => {
  it('names the first route when the first route answers (positive control)', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    // The control that gives the failover case below its meaning: with nobody
    // failing, the name that comes out is route 1's.
    expect(run.report.provenance.providerId).toBe(providerIdFor(eligibleRouteAt(0)));
    expect(run.report.provenance.providerId).toBe(
      'etbz-25b.openai-compatible.tokenrouter.vendor/model-a-free',
    );
    expect(run.reading.providerId).toBe(run.report.provenance.providerId);
    expect(run.readingText).toContain(`Provider     : ${run.report.provenance.providerId}`);
  });

  it('names the SECOND eligible route when the first one fails transiently', async () => {
    const answer = validKnownTimeAnswer();

    const run = await runChain(knownTimeModel(), answer, [statusReply(429), validReply(answer)]);

    // The point of the whole test: provenance is not "the preferred route", it
    // is the route whose answer is in the report. Only a run where those two
    // differ can tell them apart.
    expect(run.result.acceptedRouteId).toBe('opencode');
    expect(run.report.provenance.providerId).toBe(providerIdFor(eligibleRouteAt(1)));
    expect(run.report.provenance.providerId).toBe(
      'etbz-25b.openai-compatible.opencode.model-c-free',
    );
    expect(run.reading.providerId).toBe(run.report.provenance.providerId);
  });

  it('records the provider-reported model beside the route’s configured one', async () => {
    const answer = validKnownTimeAnswer();

    const run = await runChain(knownTimeModel(), answer, [statusReply(429), validReply(answer)]);

    // `acceptedModel` is what the PROVIDER said answered; `providerIdFor` uses
    // the CONFIGURED id. The fixture makes them differ deliberately, so a test
    // that conflated the two would fail here.
    expect(run.result.acceptedModel).toBe('fixture-model-free');
    expect(eligibleRouteAt(1).model).toBe('model-c-free');
    expect(run.result.attempts.map((attempt) => attempt.routeId)).toEqual([
      'tokenrouter',
      'opencode',
    ]);
  });

  it('moves the report’s identity when the answering route changes, nothing else differing', async () => {
    const answer = validKnownTimeAnswer();

    const first = await runChain(knownTimeModel(), answer);
    const second = await runChain(knownTimeModel(), answer, [statusReply(429), validReply(answer)]);

    // Same chart, same answer text; only the route that served it differs. The
    // report hash moves, which is the evidence that `providerId` is INSIDE the
    // report's identity anchor rather than decoration beside it.
    expect(second.report.provenance.providerId).not.toBe(first.report.provenance.providerId);
    expect(second.report.structuralHash).not.toBe(first.report.structuralHash);
    expect(second.reading.structuralHash).not.toBe(first.reading.structuralHash);
  });
});

describe('ETBZ-25B E4: unknown-time qualification survives onto the rendered page', () => {
  it('keeps the known-time chart free of every provisional marking (positive control)', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    // The control for every assertion in this block. Without it, a renderer
    // that stamped "[vorläufig]" on every fact and printed "nicht bekannt"
    // unconditionally would satisfy the unknown-time tests below.
    expect(run.report.uncertainty.birthTimeKnown).toBe(true);
    expect(run.report.uncertainty.provisionalFactIds).toEqual([]);
    expect(run.readingText).not.toContain(PROVISIONAL_MARKING);
    expect(run.readingText).not.toContain('Geburtszeit: nicht bekannt');
    expect(run.readingText).toContain('  Geburtszeit: 14:30:00');
    expect(run.readingText).toContain('  - Geburtszeit bekannt: ja');
    expect(run.readingText).toContain('  - Keine Fakten sind als vorläufig markiert.');
  });

  it('names every provisional fact id in the report’s uncertainty block', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    expect(run.report.uncertainty.birthTimeKnown).toBe(false);
    expect(run.report.uncertainty.provisionalFactIds).toEqual(UNKNOWN_TIME_PROVISIONAL_FACT_IDS);
    // The derived property, stated so a future fixture change reads correctly:
    // an unknown birth time makes the HOUR pillar provisional and nothing else.
    for (const factId of run.report.uncertainty.provisionalFactIds) {
      expect(factId).toContain('.hour.');
    }
    expect(run.report.uncertainty.provisionalFields.bazi).toEqual(['hour']);
  });

  it('carries the source’s warnings verbatim, in the source’s own order', async () => {
    const unknown = await runChain(unknownTimeModel(), validUnknownTimeAnswer());
    const known = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(unknown.report.uncertainty.sourceWarnings).toEqual(UNKNOWN_TIME_WARNINGS);
    // The paired half: `BIRTH_TIME_UNKNOWN` is the warning the unknown-time
    // chart adds, so its presence is caused by the chart and not by the code
    // path. `DAY_ANCHOR_UNVERIFIED` is in both and is therefore no evidence.
    expect(known.report.uncertainty.sourceWarnings).toEqual(KNOWN_TIME_WARNINGS);
    expect(unknown.report.uncertainty.sourceWarnings).toContain('BIRTH_TIME_UNKNOWN');
    expect(known.report.uncertainty.sourceWarnings).not.toContain('BIRTH_TIME_UNKNOWN');
  });

  it('keeps the provisional section’s uncertainty note, verbatim from the answer', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    const section = sectionOf(run.report, PROVISIONAL_THEME_ID);
    expect(section.citesProvisionalFacts).toBe(true);
    // Compared against the fixture's own string rather than a retyped copy, so
    // "verbatim" is measured and not asserted.
    expect(providerNotesOf(run.report, PROVISIONAL_THEME_ID)).toEqual([fixtureProvisionalNote()]);
    // And the note stayed on the provider's side of the wall: it is a provider
    // note, never a source warning.
    expect(run.report.uncertainty.sourceWarnings).not.toContain(fixtureProvisionalNote());
  });

  it('marks exactly the provisional facts on the rendered page, one marking each', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    // The count is the assertion: one marking per provisional fact means the
    // page marks all of them and marks nothing else.
    expect(occurrences(run.readingText, PROVISIONAL_MARKING)).toBe(
      run.report.uncertainty.provisionalFactIds.length,
    );
    expect(run.readingText).toContain(`pillars.hour.stem: Yi  ${PROVISIONAL_MARKING}`);
    expect(run.readingText).toContain(`pillars.hour.tierDe: Ziege  ${PROVISIONAL_MARKING}`);
    // A fact of a pillar the unknown time does not touch stays unmarked.
    expect(run.readingText).toContain('pillars.day.stem: Xin\n');
  });

  it('states the unknown birth time on the page without substituting one', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    expect(run.readingText).toContain(
      '  Geburtszeit: nicht bekannt — keine Ersatzzeit wurde eingesetzt',
    );
    expect(run.readingText).toContain('  - Geburtszeit bekannt: nein');
    // The fixture's scaffolding timestamp is 14:30 local. If any layer ever
    // read a time out of `dates` for an unknown-time chart, it would surface
    // here as a substituted birth time on the customer's page.
    expect(run.readingText).not.toContain('Geburtszeit: 14:30');
  });

  it('prints the provisional fact ids, the warnings and the note into the page itself', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    expect(run.readingText).toContain(
      `  - Vorläufige Fakten: ${UNKNOWN_TIME_PROVISIONAL_FACT_IDS.join(', ')}`,
    );
    expect(run.readingText).toContain(
      `  - Warnungen der Quelle (unverändert): ${UNKNOWN_TIME_WARNINGS.join(', ')}`,
    );
    expect(run.readingText).toContain(`  Hinweis: ${fixtureProvisionalNote()}`);
  });

  it('places the note beside the section it qualifies, not in a footnote pile', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    const prose = sectionOf(run.report, PROVISIONAL_THEME_ID).prose;
    const proseIndex = run.readingText.indexOf(prose);
    const noteIndex = run.readingText.indexOf(`  Hinweis: ${fixtureProvisionalNote()}`);
    expect(proseIndex).toBeGreaterThan(-1);
    expect(noteIndex).toBeGreaterThan(proseIndex);
    // The uncertainty summary in block 7 comes later still, so the note the
    // reader meets first is the one attached to the qualified paragraph.
    expect(run.readingText.indexOf('  - Geburtszeit bekannt: nein')).toBeGreaterThan(noteIndex);
  });

  it('still passes both gates, so qualification is preserved rather than paid for with a refusal', async () => {
    const run = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    expect(run.qa.status).toBe('PASS');
    expect(run.qa.findings).toEqual([]);
    expect(run.reading.status).toBe('CANDIDATE_READY_FOR_HUMAN_REVIEW');
    expect(run.reading.subjectDisplayName).toBe('Musterkundin B');
  });
});

describe('ETBZ-25B E5: the deterministic half is deterministic', () => {
  it('produces byte-identical artefacts from two independent runs of the same chart', async () => {
    const answer = validKnownTimeAnswer();

    // Two full passes: two HoroscopeModels, two chains, two transports. Nothing
    // is reused between them except the fixture inputs.
    const first = await runChain(knownTimeModel(), answer);
    const second = await runChain(knownTimeModel(), answer);

    expect(second.report.structuralHash).toBe(first.report.structuralHash);
    expect(second.reading.structuralHash).toBe(first.reading.structuralHash);
    expect(second.qa.structuralHash).toBe(first.qa.structuralHash);
    expect(second.chain.brief.structuralHash).toBe(first.chain.brief.structuralHash);
    // The hashes are hashes OF something; comparing the canonical text and the
    // rendered page as well means a hash that stopped covering a field cannot
    // hide a difference behind a stable digest.
    expect(second.report.canonicalJson).toBe(first.report.canonicalJson);
    expect(second.readingText).toBe(first.readingText);
  });

  it('repeats for the unknown-time chart, whose uncertainty block is the larger surface', async () => {
    const answer = validUnknownTimeAnswer();

    const first = await runChain(unknownTimeModel(), answer);
    const second = await runChain(unknownTimeModel(), answer);

    expect(second.report.structuralHash).toBe(first.report.structuralHash);
    expect(second.reading.structuralHash).toBe(first.reading.structuralHash);
    expect(second.readingText).toBe(first.readingText);
  });

  it('gives the two charts different identities, so a stable hash is not a constant', async () => {
    const known = await runChain(knownTimeModel(), validKnownTimeAnswer());
    const unknown = await runChain(unknownTimeModel(), validUnknownTimeAnswer());

    // The control the determinism assertions need: a function returning the
    // same digest for everything would satisfy them perfectly.
    expect(unknown.report.structuralHash).not.toBe(known.report.structuralHash);
    expect(unknown.reading.structuralHash).not.toBe(known.reading.structuralHash);
    expect(unknown.qa.structuralHash).not.toBe(known.qa.structuralHash);
  });
});

describe('ETBZ-25B E6: the credential travels in the Authorization header', () => {
  it('makes exactly ONE request for one reading, at the first eligible route', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    // The script held a second valid reply that was never asked for: one
    // reading costs one provider call, not one per gate or one per section.
    expect(run.transport.requests).toHaveLength(1);
    expect(requestAt(run.transport, 0).url).toBe(ROUTE_1_URL);
  });

  it('carries the answering route’s own key in the Authorization header', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    expect(requestAt(run.transport, 0).authorization).toBe(`Bearer ${ROUTE_1_KEY}`);
  });

  it('would have recorded a second request had one been made (positive control)', async () => {
    const answer = validKnownTimeAnswer();

    const run = await runChain(knownTimeModel(), answer, [statusReply(429), validReply(answer)]);

    // The control for `toHaveLength(1)` above: the transport does record more
    // than one request, and a second route presents its OWN credential — so the
    // header assertion is reading a per-route value, not a constant.
    expect(run.transport.requests).toHaveLength(2);
    expect(requestAt(run.transport, 1).url).toBe(ROUTE_3_URL);
    expect(requestAt(run.transport, 1).authorization).toBe(`Bearer ${ROUTE_3_KEY}`);
  });

  it('leaves the key out of the request body and out of every artefact the chain produced', async () => {
    const run = await runChain(knownTimeModel(), validKnownTimeAnswer());

    const request = requestAt(run.transport, 0);
    // The needle is findable — proven on the header in the same run — so these
    // absences are measurements rather than a matcher quietly never matching.
    expect(String(request.authorization)).toContain(ROUTE_1_KEY);
    expect(JSON.stringify(request.body)).not.toContain(ROUTE_1_KEY);
    expect(run.report.canonicalJson).not.toContain(ROUTE_1_KEY);
    expect(run.readingText).not.toContain(ROUTE_1_KEY);
    expect(JSON.stringify(run.result.attempts)).not.toContain(ROUTE_1_KEY);
  });
});
