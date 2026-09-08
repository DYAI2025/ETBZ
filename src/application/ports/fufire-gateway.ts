/**
 * ETBZ-2 / ETBZ-24 — the FuFirE boundary as seen from the application layer.
 *
 * The application owns this port (types + interface); the concrete HTTP client
 * lives in `src/adapters/fufire/` and conforms to it. Nothing in this file may
 * import a framework, a driver or Node built-ins — snapshots are plain data.
 *
 * Every snapshot field is traceable to a live FuFirE response field, verified
 * against the pinned runtime (fufire-lunar, engine 1.0.0-rc1-20260220,
 * OpenAPI SHA-256 6c1db672…8da). No field is inferred or computed locally.
 */

import type { NormalizedBirthInput } from '../../domain/birth-input.js';

export const WUXING_ELEMENTS = ['Holz', 'Feuer', 'Erde', 'Metall', 'Wasser'] as const;

export type WuxingElement = (typeof WUXING_ELEMENTS)[number];

export type WuxingVector = Readonly<Record<WuxingElement, number>>;

/** One pillar exactly as FuFirE reports it (romanized + German labels). */
export interface FufirePillarFact {
  /** `pillars.<p>.stamm` */
  readonly stem: string;
  /** `pillars.<p>.zweig` */
  readonly branch: string;
  /** `pillars.<p>.tier` */
  readonly tierDe: string;
  /** `pillars.<p>.element` (stem element as reported by FuFirE) */
  readonly elementDe: string;
}

export interface FufireBaziSnapshot {
  readonly pillars: Readonly<{
    year: FufirePillarFact;
    month: FufirePillarFact;
    day: FufirePillarFact;
    hour: FufirePillarFact;
  }>;
  /** `chinese.day_master` */
  readonly dayMaster: string;
  readonly dates: Readonly<{
    /** `dates.birth_local` */
    birthLocal: string;
    /** `dates.birth_utc` */
    birthUtc: string;
    /** `dates.lichun_local` */
    lichunLocal: string;
  }>;
  /** `precision` — FuFirE's own statement about time confidence. */
  readonly precision: Readonly<{
    birthTimeKnown: boolean;
    provisionalFields: readonly string[];
  }>;
  readonly provenance: Readonly<{
    /** `provenance.engine_version` */
    engineVersion: string;
    /** `provenance.ruleset_id` */
    rulesetId: string;
    /** `provenance.ephemeris_id` */
    ephemerisId: string;
    /** `provenance.tzdb_version_id` */
    tzdbVersionId: string;
    /** `provenance.computation_timestamp` — the ONLY volatile field observed. */
    computationTimestamp: string;
  }>;
}

export interface WuxingSnapshot {
  readonly vector: WuxingVector;
  /** `dominant_element` */
  readonly dominant: string;
  /** `basis` (e.g. `bazi_four_pillars`) */
  readonly basis: string;
}

/**
 * The port the product path needs. Implementations MUST fail closed: any
 * schema drift, auth failure, timeout or rejection surfaces as an explicit
 * error — never as a locally computed substitute.
 */
export interface FufireBaziGateway {
  calculateBazi(input: NormalizedBirthInput): Promise<FufireBaziSnapshot>;
  calculateBaziWuxing(input: NormalizedBirthInput): Promise<WuxingSnapshot>;
  /** ETBZ-29 — `POST /v1/calculate/bazi/natal`. Same fail-closed contract. */
  calculateNatal(input: NormalizedBirthInput): Promise<FufireNatalSnapshot>;
}

// ---------------------------------------------------------------------------
// ETBZ-29 — the FuFirE NATAL boundary (POST /v1/calculate/bazi/natal).
//
// Every type below mirrors `schemas/calculate/bazi/natal.response.schema.json`
// of the pinned FuFirE build 1.0.0-rc1-20260220 one-to-one. Nothing is derived,
// widened or invented here: a field ETBZ does not observe in that contract does
// not exist in this port, and the facts FuFirE deliberately does NOT emit
// (seasonal strength Wang/Xiang/Xiu/Qiu/Si, day-master strength, yong shen,
// rooting / tong gen — MISSING-003) are absent here for the same reason.
// ---------------------------------------------------------------------------

/** `$defs.StemEnum` — the ten heavenly stems in Pinyin. */
export const NATAL_STEMS = [
  'Jia', 'Yi', 'Bing', 'Ding', 'Wu', 'Ji', 'Geng', 'Xin', 'Ren', 'Gui',
] as const;
export type NatalStem = (typeof NATAL_STEMS)[number];

/** `$defs.BranchEnum` — the twelve earthly branches in Pinyin. */
export const NATAL_BRANCHES = [
  'Zi', 'Chou', 'Yin', 'Mao', 'Chen', 'Si', 'Wu', 'Wei', 'Shen', 'You', 'Xu', 'Hai',
] as const;
export type NatalBranch = (typeof NATAL_BRANCHES)[number];

/** `$defs.ElementEnum` — English lowercase element vocabulary. */
export const NATAL_ELEMENTS = ['wood', 'fire', 'earth', 'metal', 'water'] as const;
export type NatalElement = (typeof NATAL_ELEMENTS)[number];

/** `$defs.PolarityEnum` */
export const NATAL_POLARITIES = ['yin', 'yang'] as const;
export type NatalPolarity = (typeof NATAL_POLARITIES)[number];

/** `$defs.TenGodNameEnum` — ruleset `ten_gods.relation_to_god` vocabulary. */
export const TEN_GOD_NAMES = [
  'Friend', 'RobWealth', 'EatingGod', 'HurtingOfficer', 'IndirectWealth',
  'DirectWealth', 'SevenKilling', 'DirectOfficer', 'IndirectRes', 'DirectRes',
] as const;
export type TenGodName = (typeof TEN_GOD_NAMES)[number];

/** `$defs.TenGodPinyinEnum` */
export const TEN_GOD_PINYIN = [
  'Bi Jian', 'Jie Cai', 'Shi Shen', 'Shang Guan', 'Pian Cai',
  'Zheng Cai', 'Qi Sha', 'Zheng Guan', 'Pian Yin', 'Zheng Yin',
] as const;
export type TenGodPinyin = (typeof TEN_GOD_PINYIN)[number];

/** `$defs.ElementRelationEnum` — relation of a stem to the day master. */
export const TEN_GOD_ELEMENT_RELATIONS = [
  'same_element', 'produced_by_day_master', 'controlled_by_day_master',
  'controls_day_master', 'produces_day_master',
] as const;
export type TenGodElementRelation = (typeof TEN_GOD_ELEMENT_RELATIONS)[number];

/**
 * `$defs.HiddenStem.qi` — Qi role in the ruleset
 * `hidden_stems_weighting.role_weights` vocabulary. The array order of
 * `hiddenStems` is the Qi order: principal, then central, then residual.
 */
export const NATAL_QI_ROLES = ['principal', 'central', 'residual'] as const;
export type NatalQiRole = (typeof NATAL_QI_ROLES)[number];

/** `$defs.TenGod` — one Ten God relative to the day master. */
export interface FufireTenGodFact {
  /** `ten_god.name` */
  readonly name: TenGodName;
  /** `ten_god.pinyin` */
  readonly pinyin: TenGodPinyin;
  /** `ten_god.element_relation` */
  readonly elementRelation: TenGodElementRelation;
  /** `ten_god.label_de` — FuFirE's own short German relation label. */
  readonly labelDe: string;
}

/** `$defs.HiddenStem` — one hidden stem of a branch, with its own Ten God. */
export interface FufireHiddenStemFact {
  /** `hidden_stems[].stem` */
  readonly stem: NatalStem;
  /** `hidden_stems[].stem_cn` */
  readonly stemCn: string;
  /** `hidden_stems[].element` */
  readonly element: NatalElement;
  /** `hidden_stems[].qi` */
  readonly qi: NatalQiRole;
  /** `hidden_stems[].weight` — DECISION-003 role weight, 0 < w <= 1. */
  readonly weight: number;
  /** `hidden_stems[].ten_god` — present for EVERY hidden stem. */
  readonly tenGod: FufireTenGodFact;
}

/** `$defs.Pillar` — one natal pillar. */
export interface FufireNatalPillarFact {
  /** `pillars.<p>.stem` */
  readonly stem: NatalStem;
  /** `pillars.<p>.branch` */
  readonly branch: NatalBranch;
  /** `pillars.<p>.stem_cn` */
  readonly stemCn: string;
  /** `pillars.<p>.branch_cn` */
  readonly branchCn: string;
  /** `pillars.<p>.stem_element` */
  readonly stemElement: NatalElement;
  /** `pillars.<p>.branch_element` — element of the branch's principal Qi stem. */
  readonly branchElement: NatalElement;
  /** `pillars.<p>.polarity` — yin/yang of the pillar's heavenly stem. */
  readonly polarity: NatalPolarity;
  /** `pillars.<p>.ten_god` — NULL for the day pillar only (day stem IS the day master). */
  readonly tenGod: FufireTenGodFact | null;
  /** `pillars.<p>.hidden_stems` — 1..3 entries, in Qi order. */
  readonly hiddenStems: readonly FufireHiddenStemFact[];
}

/** `$defs.DayMaster` */
export interface FufireNatalDayMasterFact {
  readonly stem: NatalStem;
  readonly stemCn: string;
  readonly element: NatalElement;
  readonly polarity: NatalPolarity;
}

/**
 * `$defs.MonthCommand` — Yue Ling, deterministic ruleset facts ONLY.
 * FuFirE deliberately emits no seasonal-strength assessment here (MISSING-003);
 * ETBZ therefore has none to carry and never fabricates one.
 */
export interface FufireMonthCommandFact {
  readonly branch: NatalBranch;
  readonly branchCn: string;
  /** `month_command.branch_index` — 0..11 in constants.BRANCHES order (Zi=0..Hai=11). */
  readonly branchIndex: number;
  readonly principalQiStem: NatalStem;
  readonly principalQiStemCn: string;
  /** `month_command.element` — element of the principal Qi stem. */
  readonly element: NatalElement;
  /** `month_command.source_status` — const `CALCULATED` honesty marker. */
  readonly sourceStatus: 'CALCULATED';
}

/** `properties.provenance` of the natal response (distinct from the BaZi one). */
export interface FufireNatalProvenance {
  /** `provenance.source` — const `FuFirE`. */
  readonly source: 'FuFirE';
  /** `provenance.ruleset_id` (e.g. `standard_bazi_2026`). */
  readonly rulesetId: string;
  /** `provenance.ruleset_version` */
  readonly rulesetVersion: string;
  /**
   * `provenance.computed_at` — the natal response's ONLY volatile field.
   * Volatility is source-proven, not assumed: `routers/natal.py` fills it from
   * `datetime.now(timezone.utc)` (`_utc_now_iso_z`), and FuFirE's own endpoint
   * test asserts equality of every other block between two calls with the
   * comment "computed_at differs per call".
   */
  readonly computedAt: string;
}

export interface FufireNatalSnapshot {
  readonly pillars: Readonly<{
    year: FufireNatalPillarFact;
    month: FufireNatalPillarFact;
    day: FufireNatalPillarFact;
    hour: FufireNatalPillarFact;
  }>;
  readonly dayMaster: FufireNatalDayMasterFact;
  readonly monthCommand: FufireMonthCommandFact;
  readonly provenance: FufireNatalProvenance;
  /** `precision` — FuFirE's own statement; `provisional_fields` is `['hour']` when the time is unknown. */
  readonly precision: Readonly<{
    birthTimeKnown: boolean;
    provisionalFields: readonly string[];
  }>;
  /**
   * `warnings` — SOURCE-OWNED uncertainty evidence, preserved verbatim.
   *
   * The live contract represents a warning as a bare stable code string
   * (`match.types.WarningCode`), so a string array IS the payload-preserving
   * shape here — nothing is flattened away. ETBZ validates STRUCTURE only and
   * keeps NO allowlist: an unknown but structurally valid code must reach the
   * consumer unchanged, in source order, undeduplicated and unrenamed.
   */
  readonly warnings: readonly string[];
}
