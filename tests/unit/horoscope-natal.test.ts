import { describe, expect, it } from 'vitest';
import { buildHoroscopeModel, HoroscopeError } from '../../src/application/horoscope-model.js';
import type { FufireBaziSnapshot, WuxingSnapshot } from '../../src/application/ports/fufire-gateway.js';
import { validateBirthInput } from '../../src/domain/birth-input.js';
import {
  UNKNOWN_TIME_NATAL_OVERRIDES,
  deepMergeFixture,
  natalSnapshot,
} from '../support/natalFixture.js';

/**
 * ETBZ-29 — the natal facts inside the consumer-owned HoroscopeModel.
 *
 * The subject under test is the CONSUMER boundary: does the model carry the
 * real natal facts, does it carry FuFirE's uncertainty untouched, and does it
 * refuse to exist when the natal answer contradicts the chart it belongs to.
 */

const RUNTIME = { runtimeImage: 'fufire-lunar@sha256:c9162edd', openapiSha256: '6c1db672' };

const BAZI: FufireBaziSnapshot = {
  pillars: {
    year: { stem: 'Geng', branch: 'Wu', tierDe: 'Pferd', elementDe: 'Metall' },
    month: { stem: 'Ren', branch: 'Wu', tierDe: 'Pferd', elementDe: 'Wasser' },
    day: { stem: 'Xin', branch: 'Hai', tierDe: 'Schwein', elementDe: 'Metall' },
    hour: { stem: 'Yi', branch: 'Wei', tierDe: 'Ziege', elementDe: 'Holz' },
  },
  dayMaster: 'Xin',
  dates: {
    birthLocal: '1990-06-15T14:30:00+02:00',
    birthUtc: '1990-06-15T12:30:00+00:00',
    lichunLocal: '1990-02-04T10:14:00+01:00',
  },
  precision: { birthTimeKnown: true, provisionalFields: [] },
  provenance: {
    engineVersion: '1.0.0-rc1-20260220',
    rulesetId: 'traditional_bazi_2026',
    ephemerisId: 'swieph_sepl18',
    tzdbVersionId: '2026.2',
    computationTimestamp: '2026-09-05T22:58:07.958002+00:00',
  },
};

function bazi(overrides: Record<string, unknown> = {}): FufireBaziSnapshot {
  return deepMergeFixture(structuredClone(BAZI), overrides) as FufireBaziSnapshot;
}

const WUXING: WuxingSnapshot = {
  vector: { Holz: 1.8, Feuer: 2.5, Erde: 2.0, Metall: 2.0, Wasser: 2.0 },
  dominant: 'Feuer',
  basis: 'bazi_four_pillars',
};

const KNOWN_INPUT = validateBirthInput({
  displayName: 'Musterkundin A',
  birthDate: '1990-06-15',
  birthTime: '14:30',
  birthTimeKnown: true,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
});
if (!KNOWN_INPUT.ok) throw new Error('fixture input must validate');
const KNOWN_BIRTH = KNOWN_INPUT.value;

const UNKNOWN_INPUT = validateBirthInput({
  displayName: 'Musterkundin B',
  birthDate: '1985-11-03',
  birthTimeKnown: false,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405 },
});
if (!UNKNOWN_INPUT.ok) throw new Error('fixture unknown-time input must validate');
const UNKNOWN_BIRTH = UNKNOWN_INPUT.value;

const UNKNOWN_BAZI = bazi({ precision: { birthTimeKnown: false, provisionalFields: ['hour'] } });

function knownModel(natalOverrides: Record<string, unknown> = {}) {
  return buildHoroscopeModel(KNOWN_BIRTH, bazi(), WUXING, natalSnapshot(natalOverrides), RUNTIME);
}

function unknownModel(extra: Record<string, unknown> = {}) {
  const natal = natalSnapshot(
    deepMergeFixture(structuredClone(UNKNOWN_TIME_NATAL_OVERRIDES), extra) as Record<string, unknown>,
  );
  return buildHoroscopeModel(UNKNOWN_BIRTH, UNKNOWN_BAZI, WUXING, natal, RUNTIME);
}

// --- A. known-time integration ---------------------------------------------

describe('ETBZ-29 A: a known-time chart carries the natal facts into the model', () => {
  it('carries hidden stems, Ten Gods, month command, polarity, precision and provenance', () => {
    const model = knownModel();

    // Hidden stems per pillar, in Qi order, with the ruleset weights.
    expect(model.natal.pillars.hour.hiddenStems.map((h) => [h.stem, h.qi, h.weight])).toEqual([
      ['Ji', 'principal', 1],
      ['Yi', 'central', 0.5],
      ['Ding', 'residual', 0.3],
    ]);
    // Ten Gods for visible stems (null only for the day pillar) and for EVERY
    // hidden stem.
    expect(model.natal.pillars.day.tenGod).toBeNull();
    expect(model.natal.pillars.year.tenGod?.name).toBe('RobWealth');
    expect(model.natal.pillars.year.tenGod?.pinyin).toBe('Jie Cai');
    expect(model.natal.pillars.day.hiddenStems.every((h) => h.tenGod.name.length > 0)).toBe(true);
    // Month command (Yue Ling).
    expect(model.natal.monthCommand).toEqual({
      branch: 'Wu',
      branchCn: '午',
      branchIndex: 6,
      principalQiStem: 'Ding',
      principalQiStemCn: '丁',
      element: 'fire',
      sourceStatus: 'CALCULATED',
    });
    // Polarity, as FuFirE states it.
    expect(model.natal.dayMaster).toEqual({ stem: 'Xin', stemCn: '辛', element: 'metal', polarity: 'yin' });
    expect(model.natal.pillars.year.polarity).toBe('yang');
    // Precision + natal provenance.
    expect(model.natal.precision).toEqual({ birthTimeKnown: true, provisionalFields: [] });
    expect(model.natal.provenance).toEqual({
      source: 'FuFirE',
      rulesetId: 'standard_bazi_2026',
      rulesetVersion: '1.0.0',
      computedAt: '2026-09-07T19:56:12Z',
    });
    // Warnings.
    expect(model.sourceWarnings).toEqual(['DAY_ANCHOR_UNVERIFIED']);
  });

  it('keeps ONE chart truth: the natal pillars are the BaZi pillars', () => {
    const model = knownModel();
    for (const name of ['year', 'month', 'day', 'hour'] as const) {
      expect(model.natal.pillars[name].stem).toBe(model.pillars[name].stem);
      expect(model.natal.pillars[name].branch).toBe(model.pillars[name].branch);
    }
    expect(model.natal.dayMaster.stem).toBe(model.dayMaster.stem);
  });

  it('adds no interpretation and no fabricated strength assessment', () => {
    const serialized = JSON.stringify(knownModel().natal).toLowerCase();
    for (const forbidden of ['seasonal', 'strength', 'wang', 'yong', 'rooting', 'tong_gen', 'narrative', 'theme']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// --- B. unknown-time integration -------------------------------------------

describe('ETBZ-29 B: an unknown-time chart stays explicitly provisional', () => {
  it('preserves the hour provisionality and invents no time', () => {
    const model = unknownModel();
    expect(model.birth.birthTimeKnown).toBe(false);
    expect(model.birth.time).toBeUndefined();
    expect(model.natal.precision.birthTimeKnown).toBe(false);
    expect(model.natal.precision.provisionalFields).toContain('hour');
    // The hour pillar's natal facts still exist, but the model states they are
    // provisional — that statement travels with them into ETBZ-25.
    expect(model.natal.pillars.hour.hiddenStems.length).toBeGreaterThan(0);
    expect(model.canonicalJson).toContain('"provisionalFields":["hour"]');
    expect(model.canonicalJson).not.toContain('"time":"');
    expect(JSON.stringify(model)).not.toContain('T00:00');
  });
});

// --- C/D/E. source warnings -------------------------------------------------

describe('ETBZ-29 C: the known regression warnings survive verbatim', () => {
  it('keeps DAY_ANCHOR_UNVERIFIED on the known-time path', () => {
    expect(knownModel().sourceWarnings).toEqual(['DAY_ANCHOR_UNVERIFIED']);
  });

  it('keeps DAY_ANCHOR_UNVERIFIED and BIRTH_TIME_UNKNOWN on the unknown-time path', () => {
    expect(unknownModel().sourceWarnings).toEqual(['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN']);
  });

  it('never invents a warning that the source did not send', () => {
    expect(knownModel({ warnings: [] }).sourceWarnings).toEqual([]);
  });
});

describe('ETBZ-29 D: an unknown source warning crosses the boundary unchanged', () => {
  it('passes a code that is not in today\'s FuFirE enum', () => {
    const model = knownModel({ warnings: ['DAY_ANCHOR_UNVERIFIED', 'LEAP_MONTH_AMBIGUOUS_2027'] });
    expect(model.sourceWarnings).toEqual(['DAY_ANCHOR_UNVERIFIED', 'LEAP_MONTH_AMBIGUOUS_2027']);
    expect(model.canonicalJson).toContain('LEAP_MONTH_AMBIGUOUS_2027');
  });

  it('does not turn a warning into a hard error just because it exists', () => {
    expect(() => knownModel({ warnings: ['SOMETHING_ETBZ_HAS_NEVER_SEEN'] })).not.toThrow();
  });
});

describe('ETBZ-29 E: counterexample — any helpful normalization would break this', () => {
  const SOURCE = ['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN', 'DAY_ANCHOR_UNVERIFIED', 'leap_month_ambiguous'];

  it('reproduces the source array exactly, so filtering/dedup/renaming/sorting cannot pass', () => {
    const produced = knownModel({ warnings: SOURCE }).sourceWarnings;

    // The single assertion that fails under EVERY tempting transformation.
    expect(produced).toEqual(SOURCE);

    // And the explicit counterexamples: each transformation yields a DIFFERENT
    // array, so an implementation applying one could not satisfy the assertion
    // above. This is what makes the guard non-tautological.
    const allowlistFiltered = SOURCE.filter((code) => code === 'DAY_ANCHOR_UNVERIFIED' || code === 'BIRTH_TIME_UNKNOWN');
    const deduplicated = [...new Set(SOURCE)];
    const sorted = [...SOURCE].sort();
    const renamed = SOURCE.map((code) => code.toUpperCase());
    expect(allowlistFiltered).not.toEqual(produced);
    expect(deduplicated).not.toEqual(produced);
    expect(sorted).not.toEqual(produced);
    expect(renamed).not.toEqual(produced);
  });

  it('keeps the duplicate inside the canonical anchor too', () => {
    const canonical = knownModel({ warnings: SOURCE }).canonicalJson;
    expect(canonical).toContain(JSON.stringify(SOURCE).slice(1, -1));
  });
});

// --- G/H/I/J. fail-closed cross-checks --------------------------------------

describe('ETBZ-29 G: a natal pillar that contradicts the BaZi chart fails closed', () => {
  it.each([
    ['year stem', { pillars: { year: { stem: 'Xin', stemCn: '辛', stemElement: 'metal', polarity: 'yin' } } }],
    ['month branch', { pillars: { month: { branch: 'Zi', branchCn: '子' } } }],
    ['day branch', { pillars: { day: { branch: 'Zi', branchCn: '子' } } }],
    ['hour stem', { pillars: { hour: { stem: 'Jia', stemCn: '甲', stemElement: 'wood', polarity: 'yang' } } }],
  ])('rejects a drifted %s', (_label, overrides) => {
    expect(() => knownModel(overrides)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_PILLAR_CONTRADICTION' }) as HoroscopeError,
    );
  });
});

describe('ETBZ-29 H: a natal day-master contradiction fails closed', () => {
  it('rejects a natal day master that contradicts the BaZi day master', () => {
    // The BaZi day master moves; the natal block keeps saying Xin.
    const drifted = bazi({
      dayMaster: 'Ren',
      pillars: { day: { stem: 'Ren', elementDe: 'Wasser' } },
    });
    expect(() =>
      buildHoroscopeModel(KNOWN_BIRTH, drifted, WUXING, natalSnapshot(), RUNTIME),
    ).toThrow(expect.objectContaining({ code: 'HOROSCOPE_NATAL_PILLAR_CONTRADICTION' }) as HoroscopeError);
  });

  it('rejects a natal day master that contradicts the natal day pillar', () => {
    expect(() =>
      knownModel({ dayMaster: { stem: 'Ren', stemCn: '壬', element: 'water', polarity: 'yang' } }),
    ).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_DAY_MASTER_CONTRADICTION' }) as HoroscopeError,
    );
  });
});

describe('ETBZ-29 I: a precision contradiction fails closed', () => {
  it('rejects natal precision that contradicts the validated input', () => {
    expect(() => knownModel({ precision: { birthTimeKnown: false, provisionalFields: ['hour'] } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_PRECISION_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects an unknown-time chart whose natal block forgot the hour provisionality', () => {
    const natal = natalSnapshot({
      precision: { birthTimeKnown: false, provisionalFields: [] },
      warnings: ['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN'],
    });
    expect(() => buildHoroscopeModel(UNKNOWN_BIRTH, UNKNOWN_BAZI, WUXING, natal, RUNTIME)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_PRECISION_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects a natal birth_time_known that disagrees with the input alone', () => {
    // No other precision branch can catch this one: the input says known, the
    // natal block says unknown, and its provisional_fields list is empty — so
    // only the input-vs-natal comparison stands between this and a model that
    // silently carries the wrong certainty level.
    expect(() => knownModel({ precision: { birthTimeKnown: false, provisionalFields: [] } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_PRECISION_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects a known-time chart whose natal block marks the hour provisional anyway', () => {
    expect(() => knownModel({ precision: { birthTimeKnown: true, provisionalFields: ['hour'] } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_PRECISION_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects a natal precision that contradicts the BaZi precision', () => {
    // Input and natal agree (known); the BaZi snapshot disagrees.
    const drifted = bazi({ precision: { birthTimeKnown: false, provisionalFields: ['hour'] } });
    expect(() =>
      buildHoroscopeModel(KNOWN_BIRTH, drifted, WUXING, natalSnapshot(), RUNTIME),
    ).toThrow(expect.objectContaining({ code: 'HOROSCOPE_CONTRACT_CONTRADICTION' }) as HoroscopeError);
  });
});

describe('ETBZ-29 J: contradictory deterministic natal symbols fail closed', () => {
  it.each([
    ['a stem character that contradicts the released mapping', { pillars: { year: { stemCn: '甲' } } }],
    ['a branch character that contradicts the released mapping', { pillars: { year: { branchCn: '子' } } }],
    ['a stem element that contradicts the released mapping', { pillars: { year: { stemElement: 'wood' } } }],
    ['a stem polarity that contradicts the released mapping', { pillars: { year: { polarity: 'yin' } } }],
    ['a hidden-stem character that contradicts the released mapping', {
      pillars: { year: { hiddenStems: [
        { stem: 'Ding', stemCn: '甲', element: 'fire', qi: 'principal', weight: 1,
          tenGod: { name: 'SevenKilling', pinyin: 'Qi Sha', elementRelation: 'controls_day_master', labelDe: 'Druck / Struktur' } },
      ] } },
    }],
    ['a day master whose element contradicts its stem', { dayMaster: { element: 'wood' } }],
    ['a day master whose polarity contradicts its stem', { dayMaster: { polarity: 'yang' } }],
    ['a month command branch that contradicts the natal month pillar', {
      monthCommand: { branch: 'Zi', branchCn: '子', branchIndex: 0 },
    }],
    ['a month command branch_index that addresses another branch', { monthCommand: { branchIndex: 0 } }],
    ['a month command principal Qi character that contradicts the mapping', {
      monthCommand: { principalQiStemCn: '甲' },
    }],
    ['a pillar with no hidden stem at all', { pillars: { year: { hiddenStems: [] } } }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => knownModel(overrides)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects an unknown element vocabulary as a mapping error', () => {
    expect(() => knownModel({ pillars: { year: { stemElement: 'aether' } } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_SYMBOL_MAPPING_ERROR' }) as HoroscopeError,
    );
  });

  it('rejects a hidden stem ETBZ has no released mapping for', () => {
    // Hidden stems exist ONLY in the natal response, so this is the natal
    // released-mapping gate on its own, with no BaZi check in front of it.
    expect(() =>
      knownModel({
        pillars: { year: { hiddenStems: [
          { stem: 'Foobar', stemCn: '丁', element: 'fire', qi: 'principal', weight: 1,
            tenGod: { name: 'SevenKilling', pinyin: 'Qi Sha', elementRelation: 'controls_day_master', labelDe: 'Druck / Struktur' } },
        ] } },
      }),
    ).toThrow(expect.objectContaining({ code: 'HOROSCOPE_NATAL_SYMBOL_MAPPING_ERROR' }) as HoroscopeError);
  });

  it('rejects a month-command principal Qi stem ETBZ has no released mapping for', () => {
    expect(() => knownModel({ monthCommand: { principalQiStem: 'Foobar' } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_SYMBOL_MAPPING_ERROR' }) as HoroscopeError,
    );
  });

  it('rejects an unknown month-command branch that contradicts the month pillar', () => {
    expect(() => knownModel({ monthCommand: { branch: 'Foobar' } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects a natal pillar stem ETBZ cannot map even before the released lookup', () => {
    // The pillar cross-check is the outer gate: a natal stem the BaZi snapshot
    // does not share is refused as a contradiction, not silently mapped.
    expect(() => knownModel({ pillars: { year: { stem: 'Foobar' } } })).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_NATAL_PILLAR_CONTRADICTION' }) as HoroscopeError,
    );
  });
});

// --- L/M. canonical anchor canaries -----------------------------------------

describe('ETBZ-29 L: a changed natal fact changes the canonical anchor', () => {
  const BASE = knownModel().canonicalJson;

  it.each([
    ['a hidden-stem weight', {
      pillars: { year: { hiddenStems: [
        { stem: 'Ding', stemCn: '丁', element: 'fire', qi: 'principal', weight: 0.9,
          tenGod: { name: 'SevenKilling', pinyin: 'Qi Sha', elementRelation: 'controls_day_master', labelDe: 'Druck / Struktur' } },
        { stem: 'Ji', stemCn: '己', element: 'earth', qi: 'central', weight: 0.5,
          tenGod: { name: 'IndirectRes', pinyin: 'Pian Yin', elementRelation: 'produces_day_master', labelDe: 'Indirekte Quelle' } },
      ] } },
    }],
    ['a Ten-God label', { pillars: { hour: { tenGod: { labelDe: 'Etwas anderes' } } } }],
    ['the month command branch index is untouched but its Chinese label is', {
      monthCommand: { branchCn: '午' },
    }],
    ['the natal ruleset version', { provenance: { rulesetVersion: '1.0.1' } }],
  ])('changes when %s changes', (label, overrides) => {
    const mutated = knownModel(overrides).canonicalJson;
    if (label.includes('untouched')) {
      // Control case: an identical value must NOT change the anchor.
      expect(mutated).toBe(BASE);
      return;
    }
    expect(mutated).not.toBe(BASE);
  });

  it('carries every natal sub-block into the anchor (dropping one would not go unnoticed)', () => {
    // Substring assertions, so removing a whole block from the canonical
    // payload fails here even when no single field can be mutated in
    // isolation (every natal field is cross-checked against another).
    expect(BASE).toContain('"monthCommand"');
    expect(BASE).toContain('"branchIndex":6');
    expect(BASE).toContain('"principalQiStem":"Ding"');
    expect(BASE).toContain('"hiddenStems"');
    expect(BASE).toContain('"tenGod"');
    expect(BASE).toContain('"dayMaster":{"element":"metal"');
    expect(BASE).toContain('"rulesetId":"standard_bazi_2026"');
    expect(BASE).toContain('"sourceWarnings":["DAY_ANCHOR_UNVERIFIED"]');
    // …and the volatile natal timestamp is the one thing that is NOT in it.
    expect(BASE).not.toContain('2026-09-07T19:56:12Z');
  });

  it('keeps the anchor stable across the volatile natal computed_at only', () => {
    const other = knownModel({ provenance: { computedAt: '2030-01-01T00:00:00Z' } }).canonicalJson;
    expect(other).toBe(BASE);
    // …and the volatile value itself is still preserved in the model.
    expect(knownModel({ provenance: { computedAt: '2030-01-01T00:00:00Z' } }).natal.provenance.computedAt).toBe(
      '2030-01-01T00:00:00Z',
    );
  });
});

describe('ETBZ-29 M: a changed source warning changes the canonical anchor', () => {
  const BASE = knownModel().canonicalJson;

  it.each([
    ['a removed warning', []],
    ['an added warning', ['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN']],
    ['a renamed warning', ['DAY_ANCHOR_VERIFIED']],
    ['a duplicated warning', ['DAY_ANCHOR_UNVERIFIED', 'DAY_ANCHOR_UNVERIFIED']],
    ['a reordered warning list', ['BIRTH_TIME_UNKNOWN', 'DAY_ANCHOR_UNVERIFIED']],
  ])('changes when the warnings differ by %s', (_label, warnings) => {
    expect(knownModel({ warnings }).canonicalJson).not.toBe(BASE);
  });

  it('is identical for an identical warning list (the canary is not vacuous)', () => {
    expect(knownModel({ warnings: ['DAY_ANCHOR_UNVERIFIED'] }).canonicalJson).toBe(BASE);
  });
});
