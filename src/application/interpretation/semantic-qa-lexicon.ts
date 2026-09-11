/**
 * ETBZ-25B — the CLOSED vocabularies the semantic Narrative QA reasons over.
 *
 * ETBZ-25A's structural guards prove ATTACHMENT: every sentence is bound to
 * cited facts of this chart, no symbol is uncited, no number is invented. They
 * say so themselves, in `report-model.ts`, and they name the two things they
 * cannot see — the ROLE a cited symbol is given, and the TONE OF CERTAINTY a
 * sentence carries beside a provisional fact.
 *
 * This module is the vocabulary half of closing that gap. It is deliberately a
 * LEXICON and not a model: every judgement the QA gates make is a lookup in one
 * of the closed lists below, so a refusal can always be traced to a term that
 * is written down here and reviewable. No gate in ETBZ-25B asks a language
 * model whether a language model's output was good — that would move the
 * product's only remaining semantic guarantee behind the same non-determinism
 * it exists to contain.
 *
 * WHAT THIS CANNOT DO, stated rather than implied:
 *
 *  1. It is a vocabulary, so it detects the FORMS OF CLAIM it lists and not the
 *     infinite paraphrase around them. A prohibited claim written entirely in
 *     words absent from `PROHIBITED_CLAIM_CLASSES` passes.
 *  2. It matches terms, not meaning. A sentence can be false about the chart
 *     while using every symbol in its correct role.
 *
 * Both limits are why the slice still ends at a HUMAN `SELLABLE |
 * NOT_SELLABLE` review: these gates raise the floor mechanically, they do not
 * certify the ceiling.
 *
 * Matching runs through `normalizeForMatch` from `chart-symbol-lexicon.ts` —
 * the SAME normalization the structural guard uses (NFC, zero-width removal,
 * case folding) — so a term cannot slip past one guard while the other sees it.
 */

import type { ChartFactKind } from './feature-set.js';

/**
 * The semantic ROLE a chart fact may legitimately be given in prose.
 *
 * These are roles, not kinds: several fact kinds share one role (a stem's name,
 * its hanzi and its pinyin are all the same stem), and one fact kind can carry
 * several roles (the day master is a stem AND the day master).
 */
export type ChartFactRole =
  | 'stem'
  | 'branch'
  | 'element'
  | 'animal_tier'
  | 'ten_god'
  | 'weight'
  | 'polarity'
  | 'day_master'
  | 'month_command';

/**
 * The role words a reader would understand as naming each role.
 *
 * German first, because the product's prose is German; the English terms are
 * listed because a model asked for German still reaches for them. Every term is
 * matched with non-letter boundaries, so `Stamm` does not fire inside
 * `Stammtisch` and `Tier` does not fire inside `Tierkreis` — `tierkreis` is
 * listed separately where it belongs.
 */
export const ROLE_TERMS: Readonly<Record<ChartFactRole, readonly string[]>> = {
  stem: [
    'himmelsstamm',
    'himmelsstämme',
    'himmelsstaemme',
    'stamm',
    'stämme',
    'staemme',
    'heavenly stem',
    'stem',
    'stems',
  ],
  branch: [
    'erdzweig',
    'erdzweige',
    'zweig',
    'zweige',
    'earthly branch',
    'branch',
    'branches',
  ],
  element: [
    'element',
    'elemente',
    'elements',
    'wandlungsphase',
    'wandlungsphasen',
    'wu xing',
    'wuxing',
  ],
  animal_tier: ['tierzeichen', 'tierkreiszeichen', 'tierkreis', 'sternzeichen', 'zodiac sign'],
  ten_god: ['ten god', 'ten gods', 'zehn götter', 'zehn goetter', 'götterbild', 'goetterbild'],
  weight: ['gewicht', 'gewichtung', 'anteil', 'anteile', 'verteilung', 'weight', 'weighting'],
  polarity: ['polarität', 'polaritaet', 'polarity', 'yin-yang', 'yin/yang'],
  day_master: ['tagesmeister', 'tagesherr', 'day master', 'daymaster'],
  month_command: ['monatskommando', 'month command', 'monatsherr'],
} as const;

/**
 * Which roles each fact kind may legitimately be given.
 *
 * Read this as: "if prose puts a role word next to this fact's value, the role
 * word must be one of these." A kind mapping to several roles is not
 * permissiveness — it is the fact genuinely being both things at once.
 */
export const ROLES_BY_FACT_KIND: Readonly<Record<ChartFactKind, readonly ChartFactRole[]>> = {
  pillar_stem: ['stem'],
  pillar_stem_hanzi: ['stem'],
  pillar_stem_pinyin: ['stem'],
  pillar_branch: ['branch'],
  pillar_branch_hanzi: ['branch'],
  pillar_branch_pinyin: ['branch'],
  pillar_stem_element: ['element'],
  pillar_branch_tier: ['animal_tier'],
  // The day master IS the day stem — `feature-set.ts` derives it from that very
  // pillar — so both roles are correct for it and neither is a laundering.
  day_master: ['stem', 'day_master'],
  day_master_hanzi: ['stem', 'day_master'],
  day_master_pinyin: ['stem', 'day_master'],
  day_master_element: ['element'],
  day_master_polarity: ['polarity'],
  wu_xing_weight: ['weight'],
  wu_xing_dominant: ['element'],
  ten_god: ['ten_god'],
  hidden_stem: ['stem'],
  hidden_stem_element: ['element'],
  hidden_stem_ten_god: ['ten_god'],
  month_command_branch: ['branch', 'month_command'],
  month_command_principal_qi_stem: ['stem', 'month_command'],
} as const;

/**
 * Words that assert CERTAINTY.
 *
 * A section citing a provisional fact already has to carry an uncertainty note
 * (ETBZ-25A enforces that structurally). What it could still do is attach the
 * note and then write the paragraph as if the fact were settled. These are the
 * words that do that.
 */
export const CERTAINTY_TERMS: readonly string[] = [
  'sicher',
  'sicherlich',
  'mit sicherheit',
  'definitiv',
  'zweifellos',
  'ohne zweifel',
  'eindeutig',
  'unzweifelhaft',
  'garantiert',
  'zwangsläufig',
  'zwangslaeufig',
  'unweigerlich',
  'unausweichlich',
  'steht fest',
  'fest steht',
  'nachweislich',
  'bewiesen',
  'beweist',
  'certainly',
  'definitely',
  'undoubtedly',
  'guaranteed',
  'without doubt',
  'proven',
  'proves',
] as const;

/**
 * Words that actually STATE uncertainty.
 *
 * Required inside the uncertainty note of a section that cites a provisional
 * fact: without one of these the note is present but says nothing, which
 * satisfies the structural guard and misleads the reader.
 */
export const PROVISIONALITY_TERMS: readonly string[] = [
  'vorläufig',
  'vorlaeufig',
  'provisional',
  'unsicher',
  'unsicherheit',
  'ungewiss',
  'unbekannt',
  'nicht bestätigt',
  'nicht bestaetigt',
  'nicht gesichert',
  'ohne gewähr',
  'ohne gewaehr',
  'kann sich ändern',
  'kann sich aendern',
  'uncertain',
  'unconfirmed',
  'unknown',
] as const;

/**
 * Classic Barnum statements: true of nearly everyone, therefore about no one.
 *
 * The commercial failure mode this product has to avoid is not a wrong
 * sentence, it is a TRUE sentence that would fit any chart. These are the
 * canonical forms of it (the Forer statements and their common German
 * renderings), matched as phrases rather than words so an ordinary sentence
 * that happens to contain `potenzial` is not refused.
 */
export const BARNUM_PHRASES: readonly string[] = [
  'ungenutztes potenzial',
  'ungenutztes potential',
  'noch nicht ausgeschöpft',
  'noch nicht ausgeschoepft',
  'manchmal introvertiert',
  'mal introvertiert, mal extrovertiert',
  'du bist oft zu selbstkritisch',
  'du neigst dazu, zu selbstkritisch',
  'das bedürfnis, gemocht zu werden',
  'das beduerfnis, gemocht zu werden',
  'du wünschst dir, dass andere dich mögen',
  'du wuenschst dir, dass andere dich moegen',
  'nach außen wirkst du stark, innerlich',
  'nach aussen wirkst du stark, innerlich',
  'jeder mensch trägt',
  'jeder mensch traegt',
  'wie bei vielen menschen',
  'wie die meisten menschen',
  'im grunde deines herzens',
  'tief in dir',
  'unused potential',
  'you tend to be critical of yourself',
  'you have a great need for other people to like',
] as const;

/**
 * Connectives that make a sentence a SYNTHESIS rather than a lookup entry.
 *
 * A lookup paragraph names one symbol and states what it means. A synthetic one
 * relates two chart signals to each other, and in German it does that with one
 * of these.
 */
export const SYNTHESIS_CONNECTIVES: readonly string[] = [
  'zusammen mit',
  'im zusammenspiel',
  'zusammenspiel',
  'verbindet',
  'verbindung zwischen',
  'verbunden mit',
  'gemeinsam mit',
  'während',
  'waehrend',
  'gleichzeitig',
  'zugleich',
  'verstärkt',
  'verstaerkt',
  'verstärkung',
  'verstaerkung',
  'spannung zwischen',
  'in spannung',
  'im kontrast',
  'kontrast zu',
  'ergänzt',
  'ergaenzt',
  'trifft auf',
  'begegnet',
  'wechselwirkung',
  'gegenüber',
  'gegenueber',
  'einerseits',
  'andererseits',
  'together with',
  'combined with',
  'in tension with',
  'while',
] as const;

/** A class of claim the product may never make, and the terms that make it. */
export interface ProhibitedClaimClass {
  readonly classId: 'deterministic_fate' | 'medical' | 'legal' | 'financial';
  readonly terms: readonly string[];
  /** Why this class is prohibited. Published with the finding. */
  readonly statement: string;
}

/**
 * The Product Safety vocabulary.
 *
 * ETBZ sells BaZi as traditional symbolic reflection material. Two things
 * therefore may never appear in a reading: a promise that something WILL
 * happen, and advice in a regulated domain. The terms below are the forms those
 * take.
 *
 * The fate list deliberately does NOT contain bare `wird` or `zukunft`: a
 * reflection text legitimately speaks about what someone might grow toward, and
 * a guard that refuses the future tense would refuse the product. It contains
 * the DETERMINISTIC constructions instead.
 */
export const PROHIBITED_CLAIM_CLASSES: readonly ProhibitedClaimClass[] = [
  {
    classId: 'deterministic_fate',
    terms: [
      'vorbestimmt',
      'vorherbestimmt',
      'schicksal ist',
      'dein schicksal',
      'wird eintreten',
      'wird definitiv',
      'wird mit sicherheit',
      'wird garantiert',
      'unausweichlich',
      'vorhersage',
      'prognose',
      'prophezeiung',
      'voraussagen',
      'sagt voraus',
      'predestined',
      'will certainly happen',
      'prophecy',
      'prediction',
    ],
    statement:
      'A deterministic statement about what will happen. ETBZ presents BaZi as symbolic reflection material, never as a forecast.',
  },
  {
    classId: 'medical',
    terms: [
      'diagnose',
      'diagnostiziert',
      'krankheit',
      'erkrankung',
      'symptom',
      'symptome',
      'therapie',
      'therapeutisch',
      'medikament',
      'medikamente',
      'behandlung',
      'heilt',
      'heilung',
      'depression',
      'burnout',
      'adhs',
      'arzt',
      'ärztlich',
      'aerztlich',
      'diagnosis',
      'disease',
      'treatment',
      'medication',
    ],
    statement: 'A medical claim or advice. Out of scope and unsafe for this product.',
  },
  {
    classId: 'legal',
    terms: [
      'rechtsberatung',
      'rechtlich verbindlich',
      'anwalt',
      'anwältin',
      'anwaeltin',
      'klage',
      'verklagen',
      'vertrag unterschreiben',
      'kündigung',
      'kuendigung',
      'gericht',
      'legal advice',
      'lawsuit',
      'attorney',
    ],
    statement: 'A legal claim or advice. Out of scope and unsafe for this product.',
  },
  {
    classId: 'financial',
    terms: [
      'investiere',
      'investition',
      'investment',
      'aktien',
      'rendite',
      'kryptowährung',
      'kryptowaehrung',
      'krypto',
      'kredit aufnehmen',
      'geld anlegen',
      'vermögen anlegen',
      'vermoegen anlegen',
      'finanziell absichern',
      'gewinn erzielen',
      'stocks',
      'returns on',
      'invest in',
    ],
    statement: 'A financial claim or advice. Out of scope and unsafe for this product.',
  },
] as const;
