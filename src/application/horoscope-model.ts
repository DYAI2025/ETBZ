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
import {
  TWELVE_BRANCHES,
  UnknownSymbolError,
  branchFactByName,
  elementDeByEn,
  stemFactByName,
} from '../domain/sizhu.js';
import type {
  FufireBaziSnapshot,
  FufireHiddenStemFact,
  FufireMonthCommandFact,
  FufireNatalDayMasterFact,
  FufireNatalPillarFact,
  FufireNatalProvenance,
  FufireNatalSnapshot,
  FufirePillarFact,
  WuxingSnapshot,
} from './ports/fufire-gateway.js';
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
  /**
   * ETBZ-29 — the natal facts of the SAME chart, not a second chart truth.
   * Every value is the FuFirE natal response verbatim; the cross-checks below
   * guarantee it describes the same pillars, the same day master and the same
   * precision as the BaZi snapshot above. Nothing here is interpreted.
   */
  readonly natal: HoroscopeNatal;
  /**
   * ETBZ-29 — FuFirE's own warning codes, preserved EXACTLY as received:
   * source order, duplicates, unknown codes and all. This is source-owned
   * uncertainty evidence, not an ETBZ judgement — downstream consumers
   * (ETBZ-25) MUST consult it before treating any natal fact as certain.
   * ETBZ never filters, renames, normalizes, deduplicates or invents a code.
   */
  readonly sourceWarnings: readonly string[];
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

/** ETBZ-29 — the natal block of the consumer-owned model. */
export interface HoroscopeNatal {
  readonly pillars: Readonly<Record<PillarName, FufireNatalPillarFact>>;
  readonly dayMaster: FufireNatalDayMasterFact;
  readonly monthCommand: FufireMonthCommandFact;
  /**
   * FuFirE's natal precision statement. With an unknown birth time this reads
   * `{ birthTimeKnown: false, provisionalFields: ['hour'] }`, which is what
   * marks the hour pillar AND every fact derived from it (its hidden stems and
   * their Ten Gods) as provisional. No replacement time exists anywhere.
   */
  readonly precision: Readonly<{ birthTimeKnown: boolean; provisionalFields: readonly string[] }>;
  readonly provenance: FufireNatalProvenance;
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
  | 'HOROSCOPE_WUXING_ELEMENT_ERROR'
  | 'HOROSCOPE_NATAL_PILLAR_CONTRADICTION'
  | 'HOROSCOPE_NATAL_DAY_MASTER_CONTRADICTION'
  | 'HOROSCOPE_NATAL_PRECISION_CONTRADICTION'
  | 'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION'
  | 'HOROSCOPE_NATAL_SYMBOL_MAPPING_ERROR';

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

const NATAL_PILLARS = ['year', 'month', 'day', 'hour'] as const;

function natalMappingError(error: unknown, where: string): never {
  if (error instanceof UnknownSymbolError) {
    throw new HoroscopeError('HOROSCOPE_NATAL_SYMBOL_MAPPING_ERROR', `natal ${where}: ${error.message}`);
  }
  throw error;
}

/**
 * Cross-checks one natal stem against the released Sizhu mapping: Chinese
 * character, element (through the released EN/DE element bridge) and yin/yang
 * polarity. A contradiction is never repaired — the fact is rejected.
 */
function assertNatalStem(
  where: string,
  stem: string,
  stemCn: string,
  element: string,
  polarity: string | undefined,
): void {
  let released;
  let elementDe;
  try {
    released = stemFactByName(stem);
    elementDe = elementDeByEn(element);
  } catch (error) {
    natalMappingError(error, where);
  }
  if (released.hanzi !== stemCn) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal ${where}: FuFirE stem character "${stemCn}" contradicts the released mapping for ${stem} (${released.hanzi})`,
    );
  }
  if (released.elementDe !== elementDe) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal ${where}: FuFirE element "${element}" contradicts the released mapping for ${stem} (${released.elementDe})`,
    );
  }
  if (polarity !== undefined && released.polarity !== polarity) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal ${where}: FuFirE polarity "${polarity}" contradicts the released mapping for ${stem} (${released.polarity})`,
    );
  }
}

function assertNatalBranch(where: string, branch: string, branchCn: string): void {
  let released;
  try {
    released = branchFactByName(branch);
  } catch (error) {
    natalMappingError(error, where);
  }
  if (released.hanzi !== branchCn) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal ${where}: FuFirE branch character "${branchCn}" contradicts the released mapping for ${branch} (${released.hanzi})`,
    );
  }
}

function assertNatalHiddenStems(
  where: string,
  hiddenStems: readonly FufireHiddenStemFact[],
): void {
  if (hiddenStems.length === 0) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal ${where}: the branch carries no hidden stem`,
    );
  }
  hiddenStems.forEach((hidden, index) => {
    // Hidden-stem polarity is not part of the contract, so nothing is checked
    // against a polarity FuFirE never states.
    assertNatalStem(`${where}.hiddenStems[${index}]`, hidden.stem, hidden.stemCn, hidden.element, undefined);
  });
}

/**
 * ETBZ-29 cross-check: the natal snapshot must describe the SAME chart as the
 * BaZi snapshot and the SAME certainty as the validated input. Every branch
 * here is fail-closed: nothing is repaired, defaulted or recomputed locally.
 */
function assertNatalConsistency(
  input: NormalizedBirthInput,
  bazi: FufireBaziSnapshot,
  natal: FufireNatalSnapshot,
): void {
  for (const name of NATAL_PILLARS) {
    const natalPillar = natal.pillars[name];
    const baziPillar = bazi.pillars[name];
    if (natalPillar.stem !== baziPillar.stem || natalPillar.branch !== baziPillar.branch) {
      throw new HoroscopeError(
        'HOROSCOPE_NATAL_PILLAR_CONTRADICTION',
        `natal ${name} pillar ${natalPillar.stem}/${natalPillar.branch} contradicts the BaZi pillar ${baziPillar.stem}/${baziPillar.branch}`,
      );
    }
    assertNatalStem(`pillars.${name}`, natalPillar.stem, natalPillar.stemCn, natalPillar.stemElement, natalPillar.polarity);
    assertNatalBranch(`pillars.${name}`, natalPillar.branch, natalPillar.branchCn);
    assertNatalHiddenStems(`pillars.${name}`, natalPillar.hiddenStems);
  }

  // Day master: ONE identity across BaZi, natal day pillar and natal block.
  //
  // Only the natal-internal comparison is written out. A natal day master that
  // disagrees with the BaZi day master cannot reach this line undetected: the
  // BaZi day master already equals the BaZi day pillar stem (checked above),
  // the natal day pillar already equals the BaZi day pillar (checked in the
  // loop above), so a divergence necessarily surfaces as one of those two
  // errors first. Writing the third comparison anyway would add a branch no
  // input can execute — a guard that can never fail is not a guard.
  if (natal.dayMaster.stem !== natal.pillars.day.stem) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_DAY_MASTER_CONTRADICTION',
      `natal day_master (${natal.dayMaster.stem}) contradicts the natal day pillar stem (${natal.pillars.day.stem})`,
    );
  }
  assertNatalStem(
    'dayMaster',
    natal.dayMaster.stem,
    natal.dayMaster.stemCn,
    natal.dayMaster.element,
    natal.dayMaster.polarity,
  );

  // Month command (Yue Ling): the month branch's ruleset lookup, so it must
  // name the month pillar's branch and that branch's principal Qi stem.
  const monthCommand = natal.monthCommand;
  if (monthCommand.branch !== natal.pillars.month.branch) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal month command branch (${monthCommand.branch}) contradicts the natal month pillar branch (${natal.pillars.month.branch})`,
    );
  }
  assertNatalBranch('monthCommand', monthCommand.branch, monthCommand.branchCn);
  const indexed = TWELVE_BRANCHES[monthCommand.branchIndex];
  if (indexed === undefined || indexed.name !== monthCommand.branch) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_SYMBOL_CONTRADICTION',
      `natal month command branch_index ${monthCommand.branchIndex} does not address branch ${monthCommand.branch} in the released branch order`,
    );
  }
  assertNatalStem(
    'monthCommand.principalQiStem',
    monthCommand.principalQiStem,
    monthCommand.principalQiStemCn,
    monthCommand.element,
    undefined,
  );

  // Precision: the input's certainty statement and FuFirE's natal precision
  // are one fact or the answer is not usable.
  //
  // Only ONE comparison is made here, deliberately. The BaZi precision has
  // already been checked against the same input above
  // (HOROSCOPE_CONTRACT_CONTRADICTION), so `input === bazi` holds by the time
  // this runs; adding a natal-vs-BaZi comparison would be a branch no input
  // can ever reach — an assertion that cannot fail is not an assertion, and a
  // mutation canary would show it as dead. Transitivity gives natal === BaZi.
  if (natal.precision.birthTimeKnown !== input.birthTimeKnown) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_PRECISION_CONTRADICTION',
      `input birthTimeKnown=${input.birthTimeKnown} contradicts natal precision.birth_time_known=${natal.precision.birthTimeKnown}`,
    );
  }
  const natalMarksHourProvisional = natal.precision.provisionalFields.includes('hour');
  if (!input.birthTimeKnown && !natalMarksHourProvisional) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_PRECISION_CONTRADICTION',
      'birth time unknown but the natal response did not mark the hour pillar provisional',
    );
  }
  if (input.birthTimeKnown && natalMarksHourProvisional) {
    throw new HoroscopeError(
      'HOROSCOPE_NATAL_PRECISION_CONTRADICTION',
      'birth time known but the natal response marks the hour pillar provisional',
    );
  }
}

/**
 * Builds the HoroscopeModel. Strictly fail-closed on symbol mapping,
 * day-master contradiction and wu-xing drift.
 */
export function buildHoroscopeModel(
  input: NormalizedBirthInput,
  bazi: FufireBaziSnapshot,
  wuxing: WuxingSnapshot,
  natal: FufireNatalSnapshot,
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

  // ETBZ-29: the natal facts must describe this same chart, this same day
  // master and this same certainty — or there is no model.
  assertNatalConsistency(input, bazi, natal);

  const natalBlock: HoroscopeNatal = {
    pillars: {
      year: natal.pillars.year,
      month: natal.pillars.month,
      day: natal.pillars.day,
      hour: natal.pillars.hour,
    },
    dayMaster: natal.dayMaster,
    monthCommand: natal.monthCommand,
    precision: {
      birthTimeKnown: natal.precision.birthTimeKnown,
      provisionalFields: [...natal.precision.provisionalFields],
    },
    provenance: natal.provenance,
  };
  // Verbatim, in source order, with duplicates: this array is evidence.
  const sourceWarnings: readonly string[] = [...natal.warnings];

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
    natal: natalBlock,
    sourceWarnings,
  };

  // The canonical fact excludes the volatile computation timestamps and
  // NOTHING else. Two exclusions, each justified by observed source behaviour,
  // never by analogy:
  //   - `provenance.computation_timestamp` (BaZi) — the ETBZ-24 rule;
  //   - `natal.provenance.computedAt` — `routers/natal.py` fills it from
  //     `datetime.now(timezone.utc)`, and FuFirE's own endpoint test compares
  //     two calls with the comment "computed_at differs per call".
  // Every other natal fact and EVERY source warning is inside the anchor, so a
  // changed natal fact or a changed/removed/reordered warning changes the hash.
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
    natal: {
      pillars: model.natal.pillars,
      dayMaster: model.natal.dayMaster,
      monthCommand: model.natal.monthCommand,
      precision: model.natal.precision,
      provenance: {
        source: model.natal.provenance.source,
        rulesetId: model.natal.provenance.rulesetId,
        rulesetVersion: model.natal.provenance.rulesetVersion,
      },
    },
    sourceWarnings: model.sourceWarnings,
  });

  return { ...model, canonicalJson: canonical };
}
