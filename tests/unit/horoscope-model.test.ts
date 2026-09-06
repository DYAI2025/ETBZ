import { describe, expect, it } from 'vitest';
import { buildHoroscopeModel, HoroscopeError } from '../../src/application/horoscope-model.js';
import type { FufireBaziSnapshot, WuxingSnapshot } from '../../src/application/ports/fufire-gateway.js';
import { validateBirthInput } from '../../src/domain/birth-input.js';

const RUNTIME = { runtimeImage: 'fufire-lunar@sha256:c9162edd', openapiSha256: '6c1db672' };

function baziFixture(overrides: Record<string, unknown> = {}): FufireBaziSnapshot {
  const base: Record<string, unknown> = {
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
  return deepMerge(base, overrides) as FufireBaziSnapshot;
}

function wuxingFixture(overrides: Record<string, unknown> = {}): WuxingSnapshot {
  const base = {
    vector: { Holz: 1.8, Feuer: 2.5, Erde: 2.0, Metall: 2.0, Wasser: 2.0 },
    dominant: 'Feuer',
    basis: 'bazi_four_pillars',
  };
  return deepMerge(base, overrides) as WuxingSnapshot;
}

function deepMerge(base: unknown, overrides: Record<string, unknown>): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return base;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = deepMerge(merged[key], value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

const INPUT_RESULT = validateBirthInput({
  displayName: 'Musterkundin A',
  birthDate: '1990-06-15',
  birthTime: '14:30',
  birthTimeKnown: true,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
});
if (!INPUT_RESULT.ok) throw new Error('fixture input must validate');

const UNKNOWN_INPUT_RESULT = validateBirthInput({
  displayName: 'Musterkundin B',
  birthDate: '1985-11-03',
  birthTimeKnown: false,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405 },
});
if (!UNKNOWN_INPUT_RESULT.ok) throw new Error('fixture unknown-time input must validate');

describe('HoroscopeModel: source traceability', () => {
  it('passes FuFirE facts through and enriches stems/branches from the released mapping', () => {
    const model = buildHoroscopeModel(INPUT_RESULT.value, baziFixture(), wuxingFixture(), RUNTIME);
    expect(model.pillars.year.stem).toBe('Geng');
    expect(model.pillars.year.stemHanzi).toBe('庚');
    expect(model.pillars.year.branchHanzi).toBe('午');
    // Canonical tone-marked pinyin from the approved Sizhu mapping.
    expect(model.pillars.year.stemPinyin).toBe('gēng');
    expect(model.pillars.day.stemPinyin).toBe('xīn');
    expect(model.dayMaster.stemPinyin).toBe('xīn');
    expect(model.dayMaster.stem).toBe('Xin');
    expect(model.dayMaster.elementDe).toBe('Metall');
    expect(model.wuxing.vector['Feuer']).toBe(2.5);
    expect(model.wuxing.dominant).toBe('Feuer');
    expect(model.dates.birthUtc).toBe('1990-06-15T12:30:00+00:00');
    expect(model.provenance.engineVersion).toBe('1.0.0-rc1-20260220');
  });

  it('keeps the known-time path non-provisional when FuFirE confirms it', () => {
    const model = buildHoroscopeModel(INPUT_RESULT.value, baziFixture(), wuxingFixture(), RUNTIME);
    expect(model.precision.birthTimeKnown).toBe(true);
    expect(model.precision.provisionalFields).toEqual([]);
    expect(model.birth.time).toBe('14:30:00');
  });

  it('preserves unknown-time uncertainty: hour stays explicitly provisional downstream', () => {
    const unknownTime = baziFixture({ precision: { birthTimeKnown: false, provisionalFields: ['hour'] } });
    const model = buildHoroscopeModel(UNKNOWN_INPUT_RESULT.value, unknownTime, wuxingFixture(), RUNTIME);
    expect(model.birth.birthTimeKnown).toBe(false);
    expect(model.birth.time).toBeUndefined();
    // The uncertainty survives into the model: explicit, typed, consultable.
    expect(model.precision.birthTimeKnown).toBe(false);
    expect(model.precision.provisionalFields).toContain('hour');
    // The uncertainty is part of the canonical fact downstream consumers hash.
    expect(model.canonicalJson).toContain('"provisionalFields":["hour"]');
    // No replacement time was inserted: no `time` value on birth.
    expect(model.birth.time).toBeUndefined();
    expect(model.canonicalJson).not.toContain('"time":"');
  });

  it('fails closed when input says unknown time but FuFirE does not mark the hour provisional', () => {
    const drifted = baziFixture({ precision: { birthTimeKnown: false, provisionalFields: [] } });
    expect(() => buildHoroscopeModel(UNKNOWN_INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_CONTRACT_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('fails closed when input and FuFirE disagree about birthTimeKnown', () => {
    const drifted = baziFixture({ precision: { birthTimeKnown: false, provisionalFields: ['hour'] } });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_CONTRACT_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('produces a canonical JSON string excluding the volatile timestamp', () => {
    const a = buildHoroscopeModel(INPUT_RESULT.value, baziFixture(), wuxingFixture(), RUNTIME);
    const differentTimestamp = baziFixture({
      provenance: { computationTimestamp: '2030-01-01T00:00:00+00:00' },
    });
    const b = buildHoroscopeModel(INPUT_RESULT.value, differentTimestamp, wuxingFixture(), RUNTIME);
    expect(a.canonicalJson).toBe(b.canonicalJson);
  });
});

describe('HoroscopeModel: fail-closed negative paths', () => {
  it('rejects an unknown stem symbol', () => {
    const drifted = baziFixture({ pillars: { year: { stem: 'Foobar' } } });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(HoroscopeError);
  });

  it('rejects a day-master contradiction', () => {
    const drifted = baziFixture({ dayMaster: 'Ren' });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(HoroscopeError);
  });

  it('rejects a wu-xing vector with a missing element', () => {
    const vector = { Holz: 1.8, Feuer: 2.5, Erde: 2.0, Metall: 2.0, Wasser: NaN };
    const drifted = wuxingFixture({ vector });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, baziFixture(), drifted, RUNTIME)).toThrow(HoroscopeError);
  });

  it('rejects an unknown dominant element', () => {
    const drifted = wuxingFixture({ dominant: 'Aether' });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, baziFixture(), drifted, RUNTIME)).toThrow(HoroscopeError);
  });

  it('rejects a stem/element contradiction (Xin is Metall, not Holz)', () => {
    const drifted = baziFixture({ pillars: { year: { stem: 'Xin', elementDe: 'Holz' } } });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_SYMBOL_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects a branch/tier contradiction (Wu is Pferd, not Tiger)', () => {
    const drifted = baziFixture({ pillars: { month: { branch: 'Wu', tierDe: 'Tiger' } } });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_SYMBOL_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('rejects a day-master element contradiction (day stem Xin reported as Holz)', () => {
    const drifted = baziFixture({ pillars: { day: { stem: 'Xin', elementDe: 'Holz' } } });
    expect(() => buildHoroscopeModel(INPUT_RESULT.value, drifted, wuxingFixture(), RUNTIME)).toThrow(
      expect.objectContaining({ code: 'HOROSCOPE_SYMBOL_CONTRADICTION' }) as HoroscopeError,
    );
  });

  it('passes FuFirE tier/element labels through verbatim when they agree with the mapping', () => {
    const model = buildHoroscopeModel(INPUT_RESULT.value, baziFixture(), wuxingFixture(), RUNTIME);
    expect(model.pillars.day.stemElementDe).toBe('Metall');
    expect(model.pillars.day.tierDe).toBe('Schwein');
  });
});
