/**
 * ETBZ-25 — the closed vocabulary of chart symbols a narrative may name.
 *
 * Purpose: make "the provider added a chart fact" mechanically detectable in
 * free prose, not only in the structured citation list. A provider that writes
 * a stem, branch, animal tier, Ten God or element into a sentence is asserting
 * a chart fact; if that symbol is not among the facts the section cited, the
 * assertion has no source and the report is refused.
 *
 * The lexicon is CLOSED and comes entirely from released tables — the Sizhu
 * stem/branch mapping (ADR-0003) and the FuFirE Ten God / Wu Xing vocabularies
 * already declared in `src/application/ports/fufire-gateway.ts`. Nothing here
 * is a new symbol.
 *
 * Matching normalizes BOTH sides the same way before comparing: Unicode NFC,
 * removal of zero-width and soft-hyphen format characters, and case folding.
 * Without that, `GENG`, a zero-width-split `Geng` and an NFD-decomposed `gēng`
 * would each slip past a guard that the identical visible text does not.
 *
 * WHAT THIS DOES NOT DETECT, stated rather than implied:
 *
 *  1. ROLE. It proves a symbol was cited, not that the sentence gives it the
 *     right role. A section citing both a stem and a branch can still call the
 *     stem a branch; catching that needs meaning, not a vocabulary.
 *  2. HOMOGLYPHS. A Cyrillic character standing in for a Latin one is not
 *     folded away.
 *
 * Numbers are handled separately by `findUncitedNumerals` below, because a
 * quantity is a chart fact as much as a stem is: a section that cites the Wu
 * Xing weight 2.5 and writes 9.9 has replaced a fact, and the citation echo
 * alone would not notice.
 *
 * It is CONSERVATIVE in the other direction: a symbol that appears in prose
 * must be cited even when the sentence uses the word in an everyday sense
 * (`Erde`, `Feuer`). That can reject a legitimate sentence, and is chosen on
 * purpose — a false refusal is visible and fixable, an uncited chart claim in a
 * sold report is neither.
 */

import { TEN_STEMS, TWELVE_BRANCHES } from '../../domain/sizhu.js';
import {
  NATAL_ELEMENTS,
  NATAL_POLARITIES,
  NATAL_QI_ROLES,
  TEN_GOD_ROWS,
  WUXING_ELEMENTS,
} from '../ports/fufire-gateway.js';

/**
 * The single normalization both sides of every comparison pass through.
 *
 * Applied to the lexicon, to the prose and to the covered set, so a symbol and
 * its citation can never disagree because of an invisible character, a Unicode
 * decomposition or a capital letter.
 */
export function normalizeForMatch(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/gu, '')
      // ETBZ-25B: every run of whitespace collapses to one space, which is the
      // same normalization `findOutOfScopeMethod` in `report-model.ts` has always
      // applied to method vocabulary. Without it, a MULTI-WORD term is defeated
      // by any whitespace variation a writer or a model produces for free \u2014 a
      // line break, a non-breaking space, a double space \u2014 and the terms most
      // worth catching are multi-word ones ("mit sicherheit", "dein schicksal",
      // "ungenutztes potenzial"). Two guards normalizing differently is the same
      // class of blind spot as not normalizing at all.
      .replace(/\s+/gu, ' ')
      .toLowerCase()
  );
}

export interface ChartSymbolLexicon {
  /** Terms matched with non-letter boundaries, case-sensitively. */
  readonly latinTerms: readonly string[];
  /** Han characters, matched as substrings (CJK has no word boundaries). */
  readonly hanTerms: readonly string[];
}

function unique(values: readonly string[]): readonly string[] {
  return [
    ...new Set(values.map(normalizeForMatch).filter((value) => value.length > 0)),
  ].sort();
}

export const CHART_SYMBOL_LEXICON: ChartSymbolLexicon = {
  latinTerms: unique([
    ...TEN_STEMS.flatMap((stem) => [stem.name, stem.pinyin]),
    ...TWELVE_BRANCHES.flatMap((branch) => [branch.name, branch.pinyin, branch.tierDe]),
    ...TEN_GOD_ROWS.flatMap((row) => [row.name, row.pinyin, row.labelDe]),
    ...WUXING_ELEMENTS,
    ...NATAL_ELEMENTS,
    // Polarity and Qi role are chart facts too: a sentence calling a stem yang,
    // or a hidden stem principal, asserts something the chart either states or
    // does not.
    ...NATAL_POLARITIES,
    ...NATAL_QI_ROLES,
  ]),
  hanTerms: unique([
    ...TEN_STEMS.map((stem) => stem.hanzi),
    ...TWELVE_BRANCHES.map((branch) => branch.hanzi),
  ]),
};

/**
 * Every numeric token in `text` that is not among the section's cited values.
 *
 * A number in a sold report is a claim about the chart. There is no way to tell
 * an invented weight from a decorative count by looking at the digits, so the
 * rule is the same one that governs symbols: if you write it, cite it. That
 * makes ordinary counting ("belegt durch 7 Faktbezüge") a refusal too, which is
 * why the deterministic provider states no counts - the obligation is declared
 * in the brief (`constraints.numeralsMustBeCited`), not sprung on a provider.
 */
export function findUncitedNumerals(
  text: string,
  covered: ReadonlySet<string>,
): readonly string[] {
  const allowed = new Set([...covered].map(normalizeForMatch));
  const found = new Set<string>();
  for (const match of normalizeForMatch(text).matchAll(/\d+(?:[.,]\d+)?/gu)) {
    const token = match[0];
    if (!allowed.has(token)) {
      found.add(token);
    }
  }
  return [...found].sort();
}

function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Half-open character range of one match inside an already-normalized text. */
export interface TermSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * ETBZ-25B — every occurrence of `term` inside an ALREADY-NORMALIZED text.
 *
 * Exported from this module rather than re-implemented beside the semantic QA
 * on purpose: normalization and boundary semantics have exactly one owner here,
 * so a term cannot be invisible to one guard while the other sees it. Callers
 * pass text that has been through `normalizeForMatch`; passing raw text would
 * compare a folded needle against an unfolded haystack and silently find
 * nothing.
 *
 * Han terms are matched as substrings because CJK has no word boundaries — the
 * same asymmetry `findUncitedSymbols` already relies on.
 */
export function findTermSpans(normalizedText: string, normalizedTerm: string): TermSpan[] {
  if (normalizedTerm.length === 0) {
    return [];
  }
  const spans: TermSpan[] = [];
  if (/\p{Script=Han}/u.test(normalizedTerm)) {
    let from = 0;
    for (;;) {
      const index = normalizedText.indexOf(normalizedTerm, from);
      if (index === -1) {
        break;
      }
      spans.push({ start: index, end: index + normalizedTerm.length });
      from = index + normalizedTerm.length;
    }
    return spans;
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeForRegExp(normalizedTerm)}(?![\\p{L}\\p{N}])`,
    'gu',
  );
  for (const match of normalizedText.matchAll(pattern)) {
    if (match.index !== undefined) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

/** True when `term` occurs at least once in the already-normalized text. */
export function containsTerm(normalizedText: string, normalizedTerm: string): boolean {
  return findTermSpans(normalizedText, normalizedTerm).length > 0;
}

/**
 * Returns every lexicon symbol that occurs in `prose` and is NOT in `covered`,
 * sorted and de-duplicated.
 *
 * `covered` is the set of exact strings the section may name: the values and
 * source labels of the facts it cited. An empty result means every chart symbol
 * the sentence uses is backed by a citation.
 */
export function findUncitedSymbols(
  prose: string,
  covered: ReadonlySet<string>,
): readonly string[] {
  const haystack = normalizeForMatch(prose);
  const allowed = new Set([...covered].map(normalizeForMatch));
  const found = new Set<string>();
  for (const term of CHART_SYMBOL_LEXICON.latinTerms) {
    if (allowed.has(term)) {
      continue;
    }
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegExp(term)}(?![\\p{L}\\p{N}])`, 'u');
    if (pattern.test(haystack)) {
      found.add(term);
    }
  }
  for (const term of CHART_SYMBOL_LEXICON.hanTerms) {
    if (!allowed.has(term) && haystack.includes(term)) {
      found.add(term);
    }
  }
  return [...found].sort();
}
