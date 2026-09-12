/**
 * ETBZ-25B — the Golden Reading: one complete reading, assembled for a HUMAN.
 *
 * Acceptance criterion 8 asks for "at least one full synthetic Golden Reading
 * draft [that] passes all automated structural + semantic gates and is
 * presented for Human `SELLABLE | NOT_SELLABLE` review". This module is that
 * presentation, and it is deliberately the thinnest thing that can be called
 * one.
 *
 * WHAT THIS IS NOT: it is not PDF work and it is not template work. There is no
 * layout here, no styling, no page, no asset — those are ETBZ-26 and explicitly
 * out of this slice. What this produces is the READING: the seven
 * customer-facing blocks the Product Owner listed, filled with content that
 * already exists in the validated ReportModel, in an order a person can read
 * top to bottom and judge. A sellability judgement needs the text in front of
 * it; it does not need a page.
 *
 * WHERE EVERY BLOCK'S CONTENT COMES FROM, because "assembled" must not become a
 * second place where content is invented:
 *
 *   1 Daten & Berechnungsgrundlage   the model's own birth statement and
 *                                    provenance ids, verbatim
 *   2 Deine vier Säulen              chart facts, verbatim, by pillar
 *   3 Dein Day Master                chart facts, verbatim
 *   4 Deine Wu-Xing-Balance          chart facts, verbatim
 *   5 Persönliche Interpretation     the provider's validated sections
 *   6 Reflexionsimpulse              the QUESTIONS already present in those
 *                                    sections, quoted — never new text
 *   7 Methodik & Unsicherheit        method notes and the uncertainty block
 *
 * Blocks 1–4 and 7 contain no provider prose at all. Block 5 contains nothing
 * but provider prose that survived both gates. Block 6 quotes block 5 and adds
 * nothing: a reflection question is extracted by finding the sentences that end
 * in a question mark, so this module cannot author one.
 *
 * FAIL-CLOSED: `buildGoldenReading` refuses a QA result that is not `PASS` and
 * refuses one that does not belong to the report it is given. A blocked
 * candidate produces no reading, and a reading can never be assembled from
 * someone else's verdict.
 */

import { canonicalJson } from '../../domain/canonical-json.js';
import { structuralHashOfCanonicalText } from '../../domain/structural-hash.js';
import type { ChartFact } from './feature-set.js';
import type { ReportModel } from './report-model.js';
import type { NarrativeQaResult } from './semantic-qa.js';

export const GOLDEN_READING_VERSION = 'etbz-25b.golden-reading.v1' as const;

export interface GoldenReadingSection {
  readonly id: string;
  readonly title: string;
  /** Rendered lines. Never a layout instruction — just the text, in order. */
  readonly body: readonly string[];
}

export interface GoldenReading {
  readonly goldenReadingVersion: typeof GOLDEN_READING_VERSION;
  /**
   * The only status this artefact can carry. A reading exists exactly when
   * every automated gate passed; there is no "draft with warnings" state.
   */
  readonly status: 'CANDIDATE_READY_FOR_HUMAN_REVIEW';
  readonly subjectDisplayName: string;
  readonly sections: readonly GoldenReadingSection[];
  readonly reportStructuralHash: string;
  readonly briefStructuralHash: string;
  readonly qaStructuralHash: string;
  readonly providerId: string;
  readonly structuralHash: string;
}

export class GoldenReadingError extends Error {
  readonly code: 'GOLDEN_READING_NOT_ASSEMBLABLE';
  constructor(message: string) {
    super(message);
    this.name = 'GoldenReadingError';
    this.code = 'GOLDEN_READING_NOT_ASSEMBLABLE';
  }
}

const PILLAR_TITLES: readonly (readonly [string, string])[] = [
  ['year', 'Jahressäule'],
  ['month', 'Monatssäule'],
  ['day', 'Tagessäule'],
  ['hour', 'Stundensäule'],
] as const;

function factsByPrefix(facts: readonly ChartFact[], prefix: string): readonly ChartFact[] {
  return facts.filter((fact) => fact.id.startsWith(prefix));
}

/** `value` plus the source's own label when it has one. Never a translation. */
function renderFact(fact: ChartFact): string {
  const label = fact.sourceLabel === null ? '' : ` (${fact.sourceLabel})`;
  const provisional = fact.provisional ? '  [vorläufig]' : '';
  return `  ${fact.path}: ${fact.value}${label}${provisional}`;
}

/**
 * The question sentences inside a paragraph, quoted verbatim.
 *
 * Splitting on the question mark and keeping the tail before it is enough:
 * the prompt asks for at most one reflection question per section, and a
 * heuristic that tried to be cleverer would start authoring.
 */
export function extractReflectionQuestions(prose: string): readonly string[] {
  const questions: string[] = [];
  // Sentence-ish: everything after the previous terminator up to a `?`.
  for (const match of prose.matchAll(/([^.!?]*\?)/gu)) {
    const question = match[1]?.trim();
    if (question !== undefined && question.length > 1) {
      questions.push(question);
    }
  }
  return questions;
}

function dataSection(report: ReportModel): GoldenReadingSection {
  const { birth } = report.subject;
  const time = birth.time ?? null;
  return {
    id: 'data_basis',
    title: '1. Deine Daten & Berechnungsgrundlage',
    body: [
      `  Name: ${report.subject.displayName}`,
      `  Geburtsdatum: ${birth.date}`,
      time === null
        ? '  Geburtszeit: nicht bekannt — keine Ersatzzeit wurde eingesetzt'
        : `  Geburtszeit: ${time}`,
      `  Zeitzone: ${birth.timezone}`,
      `  Ort: ${birth.location.label ?? 'ohne Bezeichnung'} (${String(birth.location.lat)}, ${String(birth.location.lon)})`,
      '',
      `  Engine: ${report.provenance.engineVersion}`,
      `  Regelwerk: ${report.provenance.rulesetId}`,
      `  Ephemeride: ${report.provenance.ephemerisId}`,
      `  Zeitzonendatenbank: ${report.provenance.tzdbVersionId}`,
      `  Natal-Regelwerk: ${report.provenance.natalRulesetId} ${report.provenance.natalRulesetVersion}`,
      `  Faktenanker (Quelle): ${report.facts.sourceStructuralHash}`,
    ],
  };
}

function pillarSection(report: ReportModel): GoldenReadingSection {
  const body: string[] = [];
  for (const [pillar, title] of PILLAR_TITLES) {
    body.push(`  ${title}`);
    for (const fact of factsByPrefix(report.facts.chart, `chart.pillar.${pillar}.`)) {
      body.push(renderFact(fact));
    }
    for (const fact of factsByPrefix(report.facts.chart, `chart.natal.pillar.${pillar}.`)) {
      body.push(renderFact(fact));
    }
    body.push('');
  }
  return { id: 'four_pillars', title: '2. Deine vier Säulen', body };
}

function dayMasterSection(report: ReportModel): GoldenReadingSection {
  return {
    id: 'day_master',
    title: '3. Dein Day Master',
    body: factsByPrefix(report.facts.chart, 'chart.dayMaster.').map(renderFact),
  };
}

function wuXingSection(report: ReportModel): GoldenReadingSection {
  return {
    id: 'wu_xing',
    title: '4. Deine Wu-Xing-Balance',
    body: factsByPrefix(report.facts.chart, 'chart.wuxing.').map(renderFact),
  };
}

function interpretationSection(report: ReportModel): GoldenReadingSection {
  const body: string[] = [];
  for (const section of report.interpretation) {
    body.push(`  [${section.themeFamily}]`);
    body.push(`  Faktenbasis: ${section.citedFactIds.join(', ')}`);
    body.push('');
    body.push(`  ${section.prose}`);
    const notes = report.uncertainty.providerNotes.find(
      (note) => note.themeId === section.themeId,
    );
    if (notes !== undefined) {
      for (const note of notes.notes) {
        body.push(`  Hinweis: ${note}`);
      }
    }
    body.push('');
  }
  return {
    id: 'interpretation',
    title: '5. Deine persönliche BaZi-Interpretation',
    body,
  };
}

function reflectionSection(report: ReportModel): GoldenReadingSection {
  const questions = report.interpretation.flatMap((section) =>
    extractReflectionQuestions(section.prose),
  );
  return {
    id: 'reflection',
    title: '6. Reflexionsimpulse',
    body:
      questions.length === 0
        ? [
            '  Diese Fassung enthält keine ausformulierte Reflexionsfrage.',
            '  ETBZ ergänzt hier keine eigene: Reflexionsimpulse stammen aus dem',
            '  Interpretationstext oder sie fehlen sichtbar.',
          ]
        : questions.map((question) => `  - ${question}`),
  };
}

function methodSection(report: ReportModel): GoldenReadingSection {
  const body: string[] = ['  Ausgewertete Methoden', ''];
  for (const note of report.methodNotes.filter((entry) => entry.status === 'evaluated')) {
    body.push(`  - ${note.methodId}: ${note.statement}`);
  }
  body.push('', '  Nicht ausgewertete Methoden (nicht "kein Befund", sondern keine Datengrundlage)', '');
  for (const note of report.methodNotes.filter((entry) => entry.status === 'not_evaluated')) {
    body.push(`  - ${note.methodId} [${note.reason}]: ${note.statement}`);
  }
  body.push('', '  Unsicherheit', '');
  body.push(
    `  - Geburtszeit bekannt: ${report.uncertainty.birthTimeKnown ? 'ja' : 'nein'}`,
  );
  body.push(
    report.uncertainty.provisionalFactIds.length === 0
      ? '  - Keine Fakten sind als vorläufig markiert.'
      : `  - Vorläufige Fakten: ${report.uncertainty.provisionalFactIds.join(', ')}`,
  );
  body.push(
    report.uncertainty.sourceWarnings.length === 0
      ? '  - Die Quelle hat keine Warnung ausgegeben.'
      : `  - Warnungen der Quelle (unverändert): ${report.uncertainty.sourceWarnings.join(', ')}`,
  );
  body.push(
    '',
    '  Hinweis zum Produkt',
    '',
    '  ETBZ behandelt BaZi als traditionelles symbolisches Reflexionsmodell.',
    '  Dieses Reading ist keine wissenschaftliche Diagnose, keine Prognose und',
    '  keine medizinische, rechtliche oder finanzielle Beratung.',
  );
  return { id: 'method_and_uncertainty', title: '7. Methodik, Unsicherheit & Hinweise', body };
}

/**
 * Assembles the Golden Reading from a report that has passed BOTH gates.
 *
 * The QA result must belong to this report — compared by the report's own
 * structural hash, not by trust — so a reading can never be built on a verdict
 * that was computed for a different candidate.
 */
export function buildGoldenReading(
  report: ReportModel,
  qa: NarrativeQaResult,
): GoldenReading {
  if (qa.reportStructuralHash !== report.structuralHash) {
    throw new GoldenReadingError(
      'the semantic QA verdict was computed for a different report; a reading is never assembled on an unverified verdict',
    );
  }
  if (qa.status !== 'PASS') {
    throw new GoldenReadingError(
      `the semantic QA blocked this candidate with ${String(qa.findings.length)} finding(s); a blocked candidate produces no reading`,
    );
  }

  const sections: readonly GoldenReadingSection[] = [
    dataSection(report),
    pillarSection(report),
    dayMasterSection(report),
    wuXingSection(report),
    interpretationSection(report),
    reflectionSection(report),
    methodSection(report),
  ];

  const core = {
    goldenReadingVersion: GOLDEN_READING_VERSION,
    status: 'CANDIDATE_READY_FOR_HUMAN_REVIEW' as const,
    subjectDisplayName: report.subject.displayName,
    sections,
    reportStructuralHash: report.structuralHash,
    briefStructuralHash: report.provenance.briefStructuralHash,
    qaStructuralHash: qa.structuralHash,
    providerId: report.provenance.providerId,
  };
  return { ...core, structuralHash: structuralHashOfCanonicalText(canonicalJson(core)) };
}

/** Flattens the reading to plain text for a human reviewer. No layout. */
export function renderGoldenReadingText(reading: GoldenReading): string {
  const lines: string[] = [
    '='.repeat(78),
    `ETBZ GOLDEN READING — ${reading.status}`,
    '='.repeat(78),
    `Reading-Hash : ${reading.structuralHash}`,
    `Report-Hash  : ${reading.reportStructuralHash}`,
    `Brief-Hash   : ${reading.briefStructuralHash}`,
    `QA-Hash      : ${reading.qaStructuralHash}`,
    `Provider     : ${reading.providerId}`,
    '',
  ];
  for (const section of reading.sections) {
    lines.push('-'.repeat(78), section.title, '-'.repeat(78), ...section.body, '');
  }
  return lines.join('\n');
}
