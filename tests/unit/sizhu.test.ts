import { describe, expect, it } from 'vitest';
import { UnknownSymbolError, branchFactByName, stemFactByName } from '../../src/domain/sizhu.js';

describe('Sizhu released mapping (ADR-0003)', () => {
  it('maps well-known stems with correct hanzi and element', () => {
    expect(stemFactByName('Geng').hanzi).toBe('庚');
    expect(stemFactByName('Geng').elementDe).toBe('Metall');
    expect(stemFactByName('Gui').elementDe).toBe('Wasser');
    expect(stemFactByName('Jia').polarity).toBe('yang');
    expect(stemFactByName('Ji').polarity).toBe('yin');
  });

  it('maps well-known branches with correct hanzi, tier and element', () => {
    expect(branchFactByName('Zi').hanzi).toBe('子');
    expect(branchFactByName('Zi').tierDe).toBe('Ratte');
    expect(branchFactByName('Wei').hanzi).toBe('未');
    expect(branchFactByName('Wei').tierDe).toBe('Ziege');
    expect(branchFactByName('Hai').elementDe).toBe('Wasser');
    expect(branchFactByName('Wu').tierDe).toBe('Pferd');
  });

  it('fails closed on unknown symbols', () => {
    expect(() => stemFactByName('Foobar')).toThrow(UnknownSymbolError);
    expect(() => branchFactByName('Bingbong')).toThrow(UnknownSymbolError);
  });

  it('covers exactly ten stems and twelve branches', () => {
    const stems = ['Jia', 'Yi', 'Bing', 'Ding', 'Wu', 'Ji', 'Geng', 'Xin', 'Ren', 'Gui'];
    const branches = ['Zi', 'Chou', 'Yin', 'Mao', 'Chen', 'Si', 'Wu', 'Wei', 'Shen', 'You', 'Xu', 'Hai'];
    for (const stem of stems) expect(stemFactByName(stem).name).toBe(stem);
    for (const branch of branches) expect(branchFactByName(branch).name).toBe(branch);
  });

  // Canonical pinyin provenance: approved Sizhu token table
  // (Sizhu-readings/src/data/chineseTokens.ts, tone-marked). These values are
  // symbolic truth and are pinned exactly — mutating them for a renderer is a
  // product-truth violation and MUST fail this test.
  it('preserves the approved tone-marked canonical pinyin for every stem', () => {
    const approvedStemPinyin: Record<string, string> = {
      Jia: 'jiǎ', Yi: 'yǐ', Bing: 'bǐng', Ding: 'dīng', Wu: 'wù',
      Ji: 'jǐ', Geng: 'gēng', Xin: 'xīn', Ren: 'rén', Gui: 'guǐ',
    };
    for (const [name, canonical] of Object.entries(approvedStemPinyin)) {
      expect(stemFactByName(name).pinyin).toBe(canonical);
    }
  });

  it('preserves the approved tone-marked canonical pinyin for every branch', () => {
    const approvedBranchPinyin: Record<string, string> = {
      Zi: 'zǐ', Chou: 'chǒu', Yin: 'yín', Mao: 'mǎo', Chen: 'chén', Si: 'sì',
      Wu: 'wǔ', Wei: 'wèi', Shen: 'shēn', You: 'yǒu', Xu: 'xū', Hai: 'hài',
    };
    for (const [name, canonical] of Object.entries(approvedBranchPinyin)) {
      expect(branchFactByName(name).pinyin).toBe(canonical);
    }
  });

  it('offers the ASCII form only as an explicit presentation field, distinct from canonical', () => {
    for (const stem of ['Jia', 'Yi', 'Bing', 'Ding', 'Wu', 'Ji', 'Geng', 'Xin', 'Ren', 'Gui']) {
      const fact = stemFactByName(stem);
      expect(fact.pinyinAscii).toMatch(/^[A-Za-z]+$/);
      expect(fact.pinyinAscii).not.toBe(fact.pinyin);
    }
    for (const branch of ['Zi', 'Chou', 'Yin', 'Mao', 'Chen', 'Si', 'Wu', 'Wei', 'Shen', 'You', 'Xu', 'Hai']) {
      const fact = branchFactByName(branch);
      expect(fact.pinyinAscii).toMatch(/^[A-Za-z]+$/);
      expect(fact.pinyinAscii).not.toBe(fact.pinyin);
    }
  });
});
