/**
 * ETBZ-2 / ETBZ-24 — HoroscopeModel: the application-owned product fact.
 *
 * Pure function: takes validated input + verified FuFirE snapshots, returns
 * the immutable fact object every downstream consumer (ReportModel, PDF) must
 * render from. Every symbolic value is traceable either to a FuFirE raw field
 * (prefixed in the source map below) or to the released Sizhu mapping
 * (ADR-0003, `sizhu:` prefix). No free interpretation, no inference.
 *
 * The volatile FuFirE field `provenance.computation_timestamp` is preserved
 * verbatim in provenance but is excluded from the canonical fact hash (rule:
 * `canonical_horoscope.json` excludes `provenance.computation_timestamp`,
 * verified against live runtime 1.0.0-rc1-20260220).
 */

import { canonicalJson } from '../domain/canonical-json.js';
import type { NormalizedBirthInput } from '../domain/birth-input.js';
import { UnknownSymbolError, branchFactByName, stemFactByName } from '../domain/sizhu.js';
import type { FufireBaziSnapshot, FufirePillarFact, WuxingSnapshot } from './ports/fufire-gateway.js';
import { WUXING_ELEMENTS } from './ports/fufire-gateway.js';

const PILLAR_ORDER = ['year', 'month', 'day', 'hour'] as const;
export type PillarName = (typeof PILLAR_ORDER)[number];
void PILLAR_ORDER;

export interface HoroscopeModel {
  readonly displayName: string;
  readonly birth: Readonly<{
    date: string;
    time?: string;
    birthTimeKnown: boolean;
    timezone: string;
    location: Readonly<{ lat: number; lon: number; label?: string }>;
  }>;
  readonly pillars: Readonly<Record<PillarName, HoroscopePillar>>;
  readonly dayMaster: HoroscopeDayMaster;
  readonly wuxing: Readonly<{
    vector: Readonly<Record<string, number>>;
    dominant: string;
    basis: string;
  }>;
  /**
   * FuFirE's own precision statement, preserved verbatim. When the birth time
   * is unknown, every field FuFirE marks provisional (e.g. `hour`) is carried
   * here — downstream code MUST consult this before treating provisional
   * pillar data as verified. No replacement time is ever inserted.
   */
  readonly precision: Readonly<{
    birthTimeKnown: boolean;
    provisionalFields: readonly string[];
  }>;
  readonly dates: Readonly<{ birthLocal: string; birthUtc: string; lichunLocal: string }>;
  readonly provenance: Readonly<{
    engineVersion: string;
    rulesetId: string;
    ephemerisId: string;
    tzdbVersionId: string;
    computationTimestamp: string;
    runtimeImage: string;
    openapiSha256: string;
  }>;
  readonly canonicalJson: string;
}

export interface HoroscopePillar {
  readonly name: PillarName;
  /** FuFirE `pillars.<p>.stamm` */
  readonly stem: string;
  readonly stemHanzi: string;
  /** Canonical tone-marked pinyin (Sizhu chineseTokens.ts provenance). */
  readonly stemPinyin: string;
  /** FuFirE `pillars.<p>.zweig` */
  readonly branch: string;
  readonly branchHanzi: string;
  readonly branchPinyin: string;
  /** FuFirE `pillars.<p>.tier` */
  readonly tierDe: string;
  /** FuFirE `pillars.<p>.element` */
  readonly stemElementDe: string;
}

export interface HoroscopeDayMaster {
  /** FuFirE `chinese.day_master` (equals `pillars.day.stem`) */
  readonly stem: string;
  readonly stemHanzi: string;
  readonly stemPinyin: string;
  /** German element of the day stem, cross-checked against the pillar fact. */
  readonly elementDe: string;
}

export type HoroscopeErrorCode =
  | 'HOROSCOPE_SYMBOL_MAPPING_ERROR'
  | 'HOROSCOPE_SYMBOL_CONTRADICTION'
  | 'HOROSCOPE_CONTRACT_CONTRADICTION'
  | 'HOROSCOPE_DAY_MASTER_CONTRADICTION'
  | 'HOROSCOPE_WUXING_VECTOR_ERROR'
  | 'HOROSCOPE_WUXING_ELEMENT_ERROR';

export class HoroscopeError extends Error {
  readonly code: HoroscopeErrorCode;
  constructor(code: HoroscopeErrorCode, message: string) {
    super(message);
    this.name = 'HoroscopeError';
    this.code = code;
  }
}

function mapPillar(name: PillarName, fact: FufirePillarFact): HoroscopePillar {
  let stem, branch;
  try {
    stem = stemFactByName(fact.stem);
    branch = branchFactByName(fact.branch);
  } catch (error) {
    if (error instanceof UnknownSymbolError) {
      throw new HoroscopeError('HOROSCOPE_SYMBOL_MAPPING_ERROR', `${name}: ${error.message}`);
    }
    throw error;
  }
  // Semantic consistency oracle: the released StemFact/BranchFact values are
  // the approved deterministic mapping. A FuFirE label that contradicts it is
  // not repaired or replaced — the fact is rejected (ETBZ fail-closed truth).
  if (fact.elementDe !== stem.elementDe) {
    throw new HoroscopeError(
      'HOROSCOPE_SYMBOL_CONTRADICTION',
      `${name}: FuFirE element "${fact.elementDe}" contradicts released mapping for stem ${stem.name} (${stem.elementDe})`,
    );
  }
  if (fact.tierDe !== branch.tierDe) {
    throw new HoroscopeError(
      'HOROSCOPE_SYMBOL_CONTRADICTION',
      `${name}: FuFirE tier "${fact.tierDe}" contradicts released mapping for branch ${branch.name} (${branch.tierDe})`,
    );
  }
  return {
    name,
    stem: fact.stem,
    stemHanzi: stem.hanzi,
    stemPinyin: stem.pinyin,
    branch: fact.branch,
    branchHanzi: branch.hanzi,
    branchPinyin: branch.pinyin,
    tierDe: fact.tierDe,
    stemElementDe: fact.elementDe,
  };
}

function assertWuxingVector(snapshot: WuxingSnapshot): WuxingSnapshot {
  for (const element of WUXING_ELEMENTS) {
    const value = snapshot.vector[element];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new HoroscopeError(
        'HOROSCOPE_WUXING_VECTOR_ERROR',
        `wu-xing value for ${element} is not a finite non-negative number`,
      );
    }
  }
  return snapshot;
}

/**
 * Builds the HoroscopeModel. Strictly fail-closed on symbol mapping,
 * day-master contradiction and wu-xing drift.
 */
export function buildHoroscopeModel(
  input: NormalizedBirthInput,
  bazi: FufireBaziSnapshot,
  wuxing: WuxingSnapshot,
  runtime: Readonly<{ runtimeImage: string; openapiSha256: string }>,
): HoroscopeModel {
  const pillars = {
    year: mapPillar('year', bazi.pillars.year),
    month: mapPillar('month', bazi.pillars.month),
    day: mapPillar('day', bazi.pillars.day),
    hour: mapPillar('hour', bazi.pillars.hour),
  };

  // Day master must agree with the day pillar — FuFirE guarantees this for the
  // pinned runtime, and ETBZ refuses to paper over a drift.
  const dayMasterStem = stemFactByName(bazi.dayMaster);
  if (bazi.dayMaster !== bazi.pillars.day.stem) {
    throw new HoroscopeError(
      'HOROSCOPE_DAY_MASTER_CONTRADICTION',
      `chinese.day_master (${bazi.dayMaster}) contradicts pillars.day.stem (${bazi.pillars.day.stem})`,
    );
  }
  const dayMaster: HoroscopeDayMaster = {
    stem: bazi.dayMaster,
    stemHanzi: dayMasterStem.hanzi,
    stemPinyin: dayMasterStem.pinyin,
    elementDe: bazi.pillars.day.elementDe,
  };

  const vector = assertWuxingVector(wuxing).vector;
  const dominant = wuxing.dominant;
  if (!(dominant in vector)) {
    throw new HoroscopeError(
      'HOROSCOPE_WUXING_ELEMENT_ERROR',
      `dominant element ${dominant} is not one of the five wu-xing elements`,
    );
  }

  const birth: HoroscopeModel['birth'] = {
    date: input.birthDate,
    birthTimeKnown: input.birthTimeKnown,
    timezone: input.timezone,
    location: input.location,
  };
  if (input.birthTime !== undefined) {
    (birth as { time?: string }).time = input.birthTime;
  }

  // The input statement and FuFirE's precision statement must agree. A drift
  // here means the engine answered for a different question than was asked —
  // fail closed instead of silently carrying a wrong certainty level.
  if (bazi.precision.birthTimeKnown !== input.birthTimeKnown) {
    throw new HoroscopeError(
      'HOROSCOPE_CONTRACT_CONTRADICTION',
      `input birthTimeKnown=${input.birthTimeKnown} contradicts FuFirE precision.birth_time_known=${bazi.precision.birthTimeKnown}`,
    );
  }
  // Unknown time: the hour pillar is provisional by FuFirE's own statement.
  // The uncertainty is preserved explicitly; no replacement time is inserted.
  if (!input.birthTimeKnown && !bazi.precision.provisionalFields.includes('hour')) {
    throw new HoroscopeError(
      'HOROSCOPE_CONTRACT_CONTRADICTION',
      'birth time unknown but FuFirE did not mark the hour pillar provisional',
    );
  }

  const model = {
    displayName: input.displayName,
    birth,
    pillars,
    dayMaster,
    wuxing: { vector, dominant, basis: wuxing.basis },
    precision: {
      birthTimeKnown: bazi.precision.birthTimeKnown,
      provisionalFields: [...bazi.precision.provisionalFields],
    },
    dates: bazi.dates,
    provenance: {
      engineVersion: bazi.provenance.engineVersion,
      rulesetId: bazi.provenance.rulesetId,
      ephemerisId: bazi.provenance.ephemerisId,
      tzdbVersionId: bazi.provenance.tzdbVersionId,
      computationTimestamp: bazi.provenance.computationTimestamp,
      runtimeImage: runtime.runtimeImage,
      openapiSha256: runtime.openapiSha256,
    },
  };

  // The canonical fact excludes the volatile computation timestamp (rule:
  // `canonical_horoscope.json` excludes `provenance.computation_timestamp`).
  const canonical = canonicalJson({
    displayName: model.displayName,
    birth: model.birth,
    pillars: model.pillars,
    dayMaster: model.dayMaster,
    wuxing: model.wuxing,
    precision: model.precision,
    dates: model.dates,
    provenance: {
      engineVersion: model.provenance.engineVersion,
      rulesetId: model.provenance.rulesetId,
      ephemerisId: model.provenance.ephemerisId,
      tzdbVersionId: model.provenance.tzdbVersionId,
      runtimeImage: model.provenance.runtimeImage,
      openapiSha256: model.provenance.openapiSha256,
    },
  });

  return { ...model, canonicalJson: canonical };
}
