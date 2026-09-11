/**
 * ETBZ-25B — the VERSIONED prompt and interpretation policy.
 *
 * This module turns one `NarrativeBrief` into the exact text a real language
 * model is asked to answer. Four properties make it the boundary it claims to
 * be:
 *
 *  1. THE BRIEF IS THE ONLY SOURCE. Every value in the prompt comes from the
 *     brief. The HoroscopeModel, its canonical text and the birth data are not
 *     reachable from here, so a chart value that is not in the brief has no
 *     channel into a prompt.
 *
 *  2. NO PII LEAVES THE SERVICE. The brief carries exactly one personal datum —
 *     `subject.displayName` — and this module deliberately does NOT send it. The
 *     provider has no use for a name (it writes about a chart, and the report
 *     assembles the name locally), and withholding it makes the prompt
 *     PII-free by construction rather than by redaction after the fact. Birth
 *     date, time and place are not in the brief at all.
 *
 *  3. IT IS PURE AND VERSIONED. Same brief in, byte-identical prompt out,
 *     including `promptStructuralHash`. `PROMPT_VERSION` and
 *     `INTERPRETATION_POLICY_VERSION` travel into the evidence record, so a
 *     reading can always be traced to the exact instructions that produced it.
 *
 *  4. IT STATES THE OBLIGATIONS RATHER THAN SPRINGING THEM. Every refusal the
 *     downstream gates can raise is written into the prompt as a rule, with the
 *     closed term list it will be judged against. A provider that fails is then
 *     failing a rule it was given — which is the difference between a contract
 *     and a trap.
 *
 * The prompt is deliberately MAXIMALLY EXPLICIT about the two rules that are
 * unusual and would otherwise be discovered as refusals: a section may name
 * only the chart symbols IT cited, and a digit in prose is a chart claim.
 */

import { structuralHash } from '../../domain/structural-hash.js';
import type { ChartFact } from './feature-set.js';
import type { NarrativeBrief } from './narrative-brief.js';
import type { MethodNote } from './method-scope.js';
import { NOT_EVALUATED_METHODS } from './method-scope.js';
import type { PrimaryTheme } from './primary-theme.js';
import { ROLES_BY_FACT_KIND } from './semantic-qa-lexicon.js';
import type { ChartFactRole } from './semantic-qa-lexicon.js';

export const PROMPT_VERSION = 'etbz-25b.narrative-prompt.v1' as const;
export const INTERPRETATION_POLICY_VERSION = 'etbz-25b.interpretation-policy.v1' as const;

/**
 * The German word a section must use when it classifies a fact of this role.
 *
 * These are the SAME words the fact-role gate recognises (`ROLE_TERMS` in
 * `semantic-qa-lexicon.ts`). Telling the model which word belongs to which fact
 * is what makes the role gate a contract rather than a guessing game.
 */
export const ROLE_PROSE_LABEL: Readonly<Record<ChartFactRole, string>> = {
  stem: 'Himmelsstamm',
  branch: 'Erdzweig',
  element: 'Element',
  animal_tier: 'Tierzeichen',
  ten_god: 'Ten God',
  weight: 'Gewicht',
  polarity: 'Polarität',
  day_master: 'Tagesmeister',
  month_command: 'Monatskommando',
} as const;

export interface NarrativePrompt {
  readonly promptVersion: typeof PROMPT_VERSION;
  readonly policyVersion: typeof INTERPRETATION_POLICY_VERSION;
  /** Binds the prompt to one brief; carried into evidence beside the answer. */
  readonly briefStructuralHash: string;
  readonly system: string;
  readonly user: string;
  /** Hash of the two texts plus both versions. Identifies this exact prompt. */
  readonly promptStructuralHash: string;
}

function roleLabelFor(fact: ChartFact): string {
  const roles = ROLES_BY_FACT_KIND[fact.kind];
  // The first declared role is the primary one — `ROLES_BY_FACT_KIND` lists the
  // day master as `stem` first precisely because that is what it structurally
  // is; `Tagesmeister` is offered as the alternative wording below.
  const [primary] = roles;
  const labels = roles.map((role) => ROLE_PROSE_LABEL[role]);
  return primary === undefined ? 'Fakt' : labels.join(' oder ');
}

/** `id="value"`, plus the source label and the provisional marking when present. */
function factEntry(fact: ChartFact): string {
  const label = fact.sourceLabel === null ? '' : `/"${fact.sourceLabel}"`;
  const provisional = fact.provisional ? '!VORLÄUFIG' : '';
  return `${fact.id}="${fact.value}"${label}${provisional}`;
}

/**
 * A theme block, GROUPED BY ROLE.
 *
 * Grouping rather than one line per fact is not cosmetic. The positional theme
 * of an ordinary chart carries some seventy facts, and one labelled line each
 * produced a prompt long enough that the approved free reasoning model could not
 * answer it inside any timeout this slice can justify — measured, not assumed.
 * Grouping states the role ONCE per group instead of once per fact and removes
 * roughly two thirds of the text.
 *
 * Nothing is dropped to achieve that. Every fact of the theme still appears with
 * its id and its exact value, because a model may only cite what it was shown and
 * hiding a fact would be ETBZ quietly deciding which parts of the chart count —
 * the precise thing `primary-theme.ts` refuses to do.
 */
function themeBlock(theme: PrimaryTheme, factsById: ReadonlyMap<string, ChartFact>): string {
  const facts = theme.factIds
    .map((factId) => factsById.get(factId))
    .filter((fact): fact is ChartFact => fact !== undefined);

  const byRole = new Map<string, ChartFact[]>();
  for (const fact of facts) {
    const role = roleLabelFor(fact);
    const bucket = byRole.get(role);
    if (bucket === undefined) {
      byRole.set(role, [fact]);
    } else {
      bucket.push(fact);
    }
  }

  const terms = [
    ...new Set(
      facts.flatMap((fact) =>
        fact.sourceLabel === null ? [fact.value] : [fact.value, fact.sourceLabel],
      ),
    ),
  ].sort();

  const lines = [
    `  THEMA "${theme.id}"  (vorläufige Fakten: ${theme.containsProvisionalFacts ? 'JA' : 'NEIN'})`,
    `    Herkunft: ${theme.statement}`,
    '    Zitierbare Fakten, gruppiert nach ihrer Rolle im Text:',
    ...[...byRole.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([role, bucket]) => `      [${role}] ${bucket.map(factEntry).join('  ')}`),
    '    ERLAUBTE Chart-Begriffe im Text dieses Abschnitts (exakt diese, sonst keine):',
    `      ${terms.map((term) => `"${term}"`).join(', ')}`,
  ];
  return lines.join('\n');
}

function methodScopeBlock(methodScope: readonly MethodNote[]): string {
  const evaluated = methodScope
    .filter((note) => note.status === 'evaluated')
    .map((note) => `    - ${note.methodId}: ${note.statement}`);
  const forbidden = NOT_EVALUATED_METHODS.map(
    (method) =>
      `    - ${method.methodId}: VERBOTENE Begriffe: ${method.vocabulary.map((term) => `"${term}"`).join(', ')}`,
  );
  return [
    '  AUSGEWERTETE METHODEN (nur diese haben eine Faktenbasis):',
    ...evaluated,
    '  NICHT AUSGEWERTETE METHODEN — diese Begriffe dürfen NIRGENDWO im Text stehen:',
    ...forbidden,
  ].join('\n');
}

/**
 * The system message: role, product stance and the non-negotiable prohibitions.
 *
 * Static by design — it carries no chart value at all, so it is identical for
 * every customer and can be reviewed once.
 */
const SYSTEM_MESSAGE = [
  'Du bist der Interpretationsautor für ETBZ, ein BaZi-Reflexionsprodukt.',
  '',
  'PRODUKTHALTUNG (nicht verhandelbar):',
  '- BaZi ist bei ETBZ ein traditionelles, symbolisches Reflexions- und Unterhaltungsmodell.',
  '- Es ist KEINE wissenschaftliche Diagnose und KEINE deterministische Zukunftsprognose.',
  '- Du schreibst Reflexionsmaterial: Beobachtungen, Spannungen, Fragen. Keine Versprechen.',
  '',
  'DU DARFST ausdrücklich:',
  '- mehrere echte Chart-Signale zu einer neuen, plausiblen Deutung verbinden;',
  '- psychologisch nachvollziehbare Ableitungen und Metaphern formulieren;',
  '- Ambivalenzen und innere Spannungen beschreiben;',
  '- eigene Formulierungen erfinden, die in keiner Tabelle stehen;',
  '- Reflexionsfragen stellen.',
  '',
  'DU DARFST NIEMALS:',
  '- einen Chartfakt erfinden, ändern, ergänzen oder anders benennen;',
  '- einen als VORLÄUFIG markierten Fakt als gesichert behandeln;',
  '- eine Schulregel als empirisch bewiesene Wahrheit ausgeben;',
  '- deterministische Schicksals- oder Zukunftsversprechen machen',
  '  (kein "vorbestimmt", "wird eintreten", "Prognose", "Vorhersage", "unausweichlich");',
  '- medizinische, rechtliche oder finanzielle Aussagen oder Ratschläge machen',
  '  (keine Diagnose, Krankheit, Therapie, Medikamente, Anwalt, Klage, Investition, Aktien);',
  '- Barnum-Sätze schreiben, die auf fast jeden Menschen zutreffen.',
  '',
  'Deine Antwort ist ausschließlich ein JSON-Objekt. Kein Markdown, kein Codefence, kein Vorwort.',
].join('\n');

/**
 * Builds the prompt for one brief.
 *
 * Everything the model is judged by is stated here, including the two rules
 * that are easy to violate innocently: the per-section term whitelist and the
 * ban on digits.
 */
export function buildNarrativePrompt(brief: NarrativeBrief): NarrativePrompt {
  const factsById = new Map<string, ChartFact>(brief.facts.map((fact) => [fact.id, fact]));
  const themeIds = brief.constraints.narratableThemeIds;
  const { specificity } = brief.constraints;

  const provisionalSummary = brief.uncertainty.provisionalFactIds.length === 0
    ? '  Keine vorläufigen Fakten in dieser Karte.'
    : [
        `  Vorläufige Felder laut Quelle: ${[
          ...new Set([
            ...brief.uncertainty.provisionalFields.bazi,
            ...brief.uncertainty.provisionalFields.natal,
          ]),
        ]
          .sort()
          .join(', ')}`,
        '  Jeder Abschnitt, der einen VORLÄUFIG markierten Fakt zitiert, MUSS in',
        '  "uncertaintyNotes" mindestens eines dieser Wörter verwenden:',
        '  "vorläufig", "unsicher", "ungewiss", "unbekannt", "nicht bestätigt".',
        '  Und sein "prose" darf KEINE Sicherheitswörter enthalten',
        '  ("sicher", "definitiv", "zweifellos", "eindeutig", "garantiert", "unweigerlich").',
      ].join('\n');

  const user = [
    'Schreibe die individuelle BaZi-Interpretation für GENAU DIESE Karte.',
    '',
    '=== 1. AUSGABEFORMAT (streng) ===',
    'Antworte mit genau diesem JSON-Objekt und nichts anderem:',
    '{',
    '  "sections": [',
    '    {',
    '      "themeId": "<eine der unten erlaubten Theme-IDs>",',
    '      "citedFacts": [ { "factId": "<factId>", "value": "<value EXAKT wie unten>" } ],',
    '      "prose": "<dein Fließtext, Deutsch, 70-110 Wörter>",',
    '      "uncertaintyNotes": [ "<nur wenn nötig>" ]',
    '    }',
    '  ]',
    '}',
    '',
    `Erzeuge GENAU ${String(themeIds.length)} Abschnitte — einen pro erlaubter Theme-ID, in dieser Reihenfolge:`,
    ...themeIds.map((themeId) => `  - "${themeId}"`),
    `(Minimum ${String(specificity.minSections)}, Maximum ${String(specificity.maxSections)} Abschnitte.)`,
    '',
    '=== 2. DIE HARTEN REGELN (jede Verletzung verwirft den gesamten Report) ===',
    '',
    'R1 ZITIEREN: Jeder Abschnitt zitiert mindestens einen Fakt AUS SEINER EIGENEN Liste.',
    '   "value" muss ZEICHENGENAU dem unten angegebenen value entsprechen.',
    '   Ein Fakt aus einem anderen Thema zu zitieren, ist ein Fehler.',
    '',
    'R2 BEGRIFFS-WHITELIST: Im "prose" und in den "uncertaintyNotes" eines Abschnitts',
    '   darfst du an Chart-Symbolen AUSSCHLIESSLICH die Begriffe schreiben, die du in',
    '   GENAU DIESEM Abschnitt zitiert hast. Jeder andere Himmelsstamm, Erdzweig,',
    '   Tiername, Elementname (Holz, Feuer, Erde, Metall, Wasser), Ten-God-Name,',
    '   jedes chinesische Schriftzeichen und jedes Pinyin ist verboten — auch dann,',
    '   wenn du das Wort in alltäglicher Bedeutung meinst.',
    '   Schreibe also NICHT "wie Feuer", wenn "Feuer" in diesem Abschnitt nicht zitiert ist.',
    '',
    'R3 KEINE ZIFFERN: Schreibe KEINE Ziffer (0-9) in prose oder notes, es sei denn, sie ist',
    '   exakt ein von dir zitierter value. Zähle nichts. Schreibe keine Jahreszahlen,',
    '   keine Prozente, keine Mengenangaben.',
    '',
    'R4 ROLLENTREUE: Wenn du ein Chart-Symbol benennst, muss das Rollenwort direkt daneben',
    '   die Rolle sein, die unten bei genau diesem Fakt steht.',
    '   Die häufigste Falle: Das ELEMENT eines Stammes ist nicht der Stamm.',
    '     FALSCH: "der Monat trägt seinen Stamm als Wasser"  (Wasser ist hier ein Element)',
    '     RICHTIG: "das Element des Monatsstammes ist Wasser"',
    '   Weitere verbotene Verwechslungen:',
    '     - ein Himmelsstamm darf nicht "Erdzweig" heißen;',
    '     - ein Tierzeichen darf nicht "Erdzweig" oder "Stamm" heißen;',
    '     - ein Gewicht darf nicht "Element" heißen und ein Element nicht "Gewicht",',
    '       AUSSER der Fakt steht unten in beiden Rollen;',
    '     - ein Ten God darf nicht "Stamm", "Erdzweig" oder "Element" heißen.',
    '   Wenn du dir bei einem Symbol unsicher bist: schreibe KEIN Rollenwort daneben.',
    '',
    'R5 VORLÄUFIGKEIT: siehe Abschnitt 4.',
    '',
    'R6 KEINE WIEDERHOLUNG: Kein Abschnitt darf denselben Absatz tragen wie ein anderer.',
    '',
    'R7 VERANKERUNG: Jeder "prose" MUSS mindestens einen seiner zitierten Chart-Begriffe',
    '   wörtlich nennen. Ein Absatz, der keinen davon nennt, ist generischer Text.',
    '',
    'R8 SYNTHESE: Mindestens EIN Abschnitt muss zwei verschiedene Fakt-Rollen wörtlich',
    '   nennen UND sie ausdrücklich miteinander in Beziehung setzen — mit einem Wort wie',
    '   "zusammen mit", "im Zusammenspiel", "während", "gleichzeitig", "verstärkt",',
    '   "in Spannung", "ergänzt", "trifft auf", "einerseits/andererseits".',
    '   Reine Lexikonabsätze ("X bedeutet Y") sind nicht akzeptabel.',
    '',
    '=== 3. DIE THEMEN UND IHRE ZITIERBAREN FAKTEN ===',
    ...themeIds.map((themeId) => {
      const theme = brief.primaryThemes.find((candidate) => candidate.id === themeId);
      return theme === undefined ? `  THEMA "${themeId}" (nicht gefunden)` : themeBlock(theme, factsById);
    }),
    '',
    '=== 4. UNSICHERHEIT ===',
    provisionalSummary,
    '',
    '=== 5. METHODEN-SCOPE ===',
    methodScopeBlock(brief.methodScope),
    '',
    '=== 6. TON ===',
    'Deutsch, warm, präzise, erwachsen. Keine Esoterik-Floskeln, kein Pathos.',
    'Schreibe über Muster und Spannungen, nicht über Ereignisse.',
    'Stelle pro Abschnitt höchstens eine Reflexionsfrage.',
    '',
    '=== 7. KURZE SELBSTPRÜFUNG ===',
    'Nur Chart-Begriffe aus der eigenen Liste. Keine Ziffern außer zitierten values.',
    'Richtiges Rollenwort oder gar keins. Jeder Abschnitt nennt zwei seiner Begriffe.',
    'Ein Abschnitt verbindet zwei Rollen. Keine Schicksals-, Medizin-, Rechts- oder Finanzsätze.',
    '',
    'Antworte jetzt mit dem JSON-Objekt.',
  ].join('\n');

  const core = {
    promptVersion: PROMPT_VERSION,
    policyVersion: INTERPRETATION_POLICY_VERSION,
    briefStructuralHash: brief.structuralHash,
    system: SYSTEM_MESSAGE,
    user,
  };
  return { ...core, promptStructuralHash: structuralHash(core) };
}
