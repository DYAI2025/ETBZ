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
}
