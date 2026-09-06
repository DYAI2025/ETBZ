/**
 * ETBZ-2 / ETBZ-24 — deterministic Sizhu symbol mapping (ADR-0003).
 *
 * FuFirE returns the four pillars with romanized stem/branch names (e.g.
 * "Geng", "Wu") and German tier/element labels. The Hanzi and pinyin forms are
 * NOT invented per report; they come from this single released table, and the
 * tests pin it against well-known stems/branches (see tests/unit/sizhu.test.ts).
 *
 * Canonical pinyin provenance: the approved Sizhu token table
 * (`Sizhu-readings/src/data/chineseTokens.ts`, tone-marked, scriptPolicy
 * CN_SIMPLIFIED). The canonical `pinyin` values preserve the tone marks of the
 * source exactly — they are symbolic truth and must never be mutated for a
 * renderer. A separate `pinyinAscii` field is an explicitly-named presentation
 * transformation (tone marks stripped); downstream consumers choose it only
 * when a display target cannot carry diacritics. It never replaces the
 * canonical mapping and is excluded from symbolic assertions.
 */

export interface StemFact {
  /** Romanized name exactly as FuFirE spells it in `pillars.*.stamm`. */
  readonly name: string;
  readonly hanzi: string;
  /** Canonical tone-marked pinyin (provenance: Sizhu chineseTokens.ts). */
  readonly pinyin: string;
  /** Presentation-only ASCII transliteration (tone marks stripped). */
  readonly pinyinAscii: string;
  readonly polarity: 'yang' | 'yin';
  /** German element label, aligned with FuFirE's element vocabulary. */
  readonly elementDe: 'Holz' | 'Feuer' | 'Erde' | 'Metall' | 'Wasser';
}

export interface BranchFact {
  readonly name: string;
  readonly hanzi: string;
  /** Canonical tone-marked pinyin (provenance: Sizhu chineseTokens.ts). */
  readonly pinyin: string;
  /** Presentation-only ASCII transliteration (tone marks stripped). */
  readonly pinyinAscii: string;
  readonly tierDe: string;
  readonly elementDe: 'Holz' | 'Feuer' | 'Erde' | 'Metall' | 'Wasser';
  readonly polarity: 'yang' | 'yin';
}

export const TEN_STEMS: readonly StemFact[] = [
  { name: 'Jia', hanzi: '甲', pinyin: 'jiǎ', pinyinAscii: 'Jia', polarity: 'yang', elementDe: 'Holz' },
  { name: 'Yi', hanzi: '乙', pinyin: 'yǐ', pinyinAscii: 'Yi', polarity: 'yin', elementDe: 'Holz' },
  { name: 'Bing', hanzi: '丙', pinyin: 'bǐng', pinyinAscii: 'Bing', polarity: 'yang', elementDe: 'Feuer' },
  { name: 'Ding', hanzi: '丁', pinyin: 'dīng', pinyinAscii: 'Ding', polarity: 'yin', elementDe: 'Feuer' },
  { name: 'Wu', hanzi: '戊', pinyin: 'wù', pinyinAscii: 'Wu', polarity: 'yang', elementDe: 'Erde' },
  { name: 'Ji', hanzi: '己', pinyin: 'jǐ', pinyinAscii: 'Ji', polarity: 'yin', elementDe: 'Erde' },
  { name: 'Geng', hanzi: '庚', pinyin: 'gēng', pinyinAscii: 'Geng', polarity: 'yang', elementDe: 'Metall' },
  { name: 'Xin', hanzi: '辛', pinyin: 'xīn', pinyinAscii: 'Xin', polarity: 'yin', elementDe: 'Metall' },
  { name: 'Ren', hanzi: '壬', pinyin: 'rén', pinyinAscii: 'Ren', polarity: 'yang', elementDe: 'Wasser' },
  { name: 'Gui', hanzi: '癸', pinyin: 'guǐ', pinyinAscii: 'Gui', polarity: 'yin', elementDe: 'Wasser' },
] as const;

export const TWELVE_BRANCHES: readonly BranchFact[] = [
  { name: 'Zi', hanzi: '子', pinyin: 'zǐ', pinyinAscii: 'Zi', tierDe: 'Ratte', elementDe: 'Wasser', polarity: 'yang' },
  { name: 'Chou', hanzi: '丑', pinyin: 'chǒu', pinyinAscii: 'Chou', tierDe: 'Büffel', elementDe: 'Erde', polarity: 'yin' },
  { name: 'Yin', hanzi: '寅', pinyin: 'yín', pinyinAscii: 'Yin', tierDe: 'Tiger', elementDe: 'Holz', polarity: 'yang' },
  { name: 'Mao', hanzi: '卯', pinyin: 'mǎo', pinyinAscii: 'Mao', tierDe: 'Hase', elementDe: 'Holz', polarity: 'yin' },
  { name: 'Chen', hanzi: '辰', pinyin: 'chén', pinyinAscii: 'Chen', tierDe: 'Drache', elementDe: 'Erde', polarity: 'yang' },
  { name: 'Si', hanzi: '巳', pinyin: 'sì', pinyinAscii: 'Si', tierDe: 'Schlange', elementDe: 'Feuer', polarity: 'yin' },
  { name: 'Wu', hanzi: '午', pinyin: 'wǔ', pinyinAscii: 'Wu', tierDe: 'Pferd', elementDe: 'Feuer', polarity: 'yang' },
  { name: 'Wei', hanzi: '未', pinyin: 'wèi', pinyinAscii: 'Wei', tierDe: 'Ziege', elementDe: 'Erde', polarity: 'yin' },
  { name: 'Shen', hanzi: '申', pinyin: 'shēn', pinyinAscii: 'Shen', tierDe: 'Affe', elementDe: 'Metall', polarity: 'yang' },
  { name: 'You', hanzi: '酉', pinyin: 'yǒu', pinyinAscii: 'You', tierDe: 'Hahn', elementDe: 'Metall', polarity: 'yin' },
  { name: 'Xu', hanzi: '戌', pinyin: 'xū', pinyinAscii: 'Xu', tierDe: 'Hund', elementDe: 'Erde', polarity: 'yang' },
  { name: 'Hai', hanzi: '亥', pinyin: 'hài', pinyinAscii: 'Hai', tierDe: 'Schwein', elementDe: 'Wasser', polarity: 'yin' },
] as const;

export class UnknownSymbolError extends Error {
  readonly code = 'UNKNOWN_SYMBOL';
  constructor(message: string) {
    super(message);
    this.name = 'UnknownSymbolError';
  }
}

const STEM_INDEX = new Map<string, StemFact>(TEN_STEMS.map((stem) => [stem.name, stem]));
const BRANCH_INDEX = new Map<string, BranchFact>(TWELVE_BRANCHES.map((branch) => [branch.name, branch]));

/** Resolves a FuFirE stem name to its released mapping. Fails closed. */
export function stemFactByName(name: string): StemFact {
  const fact = STEM_INDEX.get(name);
  if (fact === undefined) {
    throw new UnknownSymbolError(`no released stem mapping for "${name}"`);
  }
  return fact;
}

/** Resolves a FuFirE branch name to its released mapping. Fails closed. */
export function branchFactByName(name: string): BranchFact {
  const fact = BRANCH_INDEX.get(name);
  if (fact === undefined) {
    throw new UnknownSymbolError(`no released branch mapping for "${name}"`);
  }
  return fact;
}
