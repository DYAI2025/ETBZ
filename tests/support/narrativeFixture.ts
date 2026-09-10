/**
 * ETBZ-25 test support — HoroscopeModels for the narrative chain.
 *
 * The chart is the SAME synthetic chart the ETBZ-24 / ETBZ-29 fixtures already
 * use (year Geng/Wu, month Ren/Wu, day Xin/Hai, hour Yi/Wei, day master Xin).
 * No real person's birth data exists in this repository.
 *
 * Every model here is produced by the real `buildHoroscopeModel`, never
 * hand-assembled, so a test that passes against these fixtures has passed
 * against a model the production path could actually produce.
 */
import { buildHoroscopeModel } from '../../src/application/horoscope-model.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import type {
  FufireBaziSnapshot,
  WuxingSnapshot,
} from '../../src/application/ports/fufire-gateway.js';
import { validateBirthInput } from '../../src/domain/birth-input.js';
import {
  UNKNOWN_TIME_NATAL_OVERRIDES,
  deepMergeFixture,
  natalSnapshot,
} from './natalFixture.js';

export const RUNTIME = {
  runtimeImage: 'fufire-lunar@sha256:c9162edd',
  openapiSha256: '6c1db672',
} as const;

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

export function baziSnapshot(overrides: Record<string, unknown> = {}): FufireBaziSnapshot {
  return deepMergeFixture(structuredClone(BAZI), overrides) as FufireBaziSnapshot;
}

const WUXING: WuxingSnapshot = {
  vector: { Holz: 1.8, Feuer: 2.5, Erde: 2, Metall: 2, Wasser: 2 },
  dominant: 'Feuer',
  basis: 'bazi_four_pillars',
};

export function wuxingSnapshot(overrides: Record<string, unknown> = {}): WuxingSnapshot {
  return deepMergeFixture(structuredClone(WUXING), overrides) as WuxingSnapshot;
}

const KNOWN_INPUT = validateBirthInput({
  displayName: 'Musterkundin A',
  birthDate: '1990-06-15',
  birthTime: '14:30',
  birthTimeKnown: true,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
});
if (!KNOWN_INPUT.ok) throw new Error('fixture known-time input must validate');

const UNKNOWN_INPUT = validateBirthInput({
  displayName: 'Musterkundin B',
  birthDate: '1985-11-03',
  birthTimeKnown: false,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405 },
});
if (!UNKNOWN_INPUT.ok) throw new Error('fixture unknown-time input must validate');

export const KNOWN_BIRTH = KNOWN_INPUT.value;
export const UNKNOWN_BIRTH = UNKNOWN_INPUT.value;

/** A known-time chart: FuFirE confirms the time, nothing is provisional. */
export function knownTimeModel(
  overrides: Readonly<{
    bazi?: Record<string, unknown>;
    wuxing?: Record<string, unknown>;
    natal?: Record<string, unknown>;
  }> = {},
): HoroscopeModel {
  return buildHoroscopeModel(
    KNOWN_BIRTH,
    baziSnapshot(overrides.bazi ?? {}),
    wuxingSnapshot(overrides.wuxing ?? {}),
    natalSnapshot(overrides.natal ?? {}),
    RUNTIME,
  );
}

/**
 * An unknown-time chart: FuFirE marks the hour pillar provisional and adds its
 * own `BIRTH_TIME_UNKNOWN` warning. No replacement time exists anywhere.
 */
export function unknownTimeModel(
  overrides: Readonly<{
    bazi?: Record<string, unknown>;
    wuxing?: Record<string, unknown>;
    natal?: Record<string, unknown>;
  }> = {},
): HoroscopeModel {
  const natal = deepMergeFixture(
    structuredClone(UNKNOWN_TIME_NATAL_OVERRIDES),
    overrides.natal ?? {},
  ) as Record<string, unknown>;
  const bazi = deepMergeFixture(
    {
      precision: { birthTimeKnown: false, provisionalFields: ['hour'] },
      // The dates block is moved onto this fixture's own birth date so the
      // fixture is at least self-consistent. Its TIME component is scaffolding,
      // not a claim: ETBZ-25 derives no fact from `dates` at all - asserted in
      // `tests/unit/interpretation-feature-set.test.ts` - and this repository
      // has not observed how FuFirE fills the local timestamp when the birth
      // time is unknown, so nothing here should be read as stating that.
      dates: {
        birthLocal: '1985-11-03T14:30:00+01:00',
        birthUtc: '1985-11-03T13:30:00+00:00',
        lichunLocal: '1985-02-04T05:12:00+01:00',
      },
    },
    overrides.bazi ?? {},
  ) as Record<string, unknown>;
  return buildHoroscopeModel(
    UNKNOWN_BIRTH,
    baziSnapshot(bazi),
    wuxingSnapshot(overrides.wuxing ?? {}),
    natalSnapshot(natal),
    RUNTIME,
  );
}
