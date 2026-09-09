/**
 * ETBZ-25 — the BaZi method scope of this slice, stated explicitly.
 *
 * This file invents no astrological rule. It records, per method, whether the
 * pinned FuFirE contract supplies the facts ETBZ would need — nothing more.
 *
 * The `not_evaluated` list is not an ETBZ opinion either: `src/application/
 * ports/fufire-gateway.ts` records that the pinned natal contract deliberately
 * emits no seasonal strength (Wang/Xiang/Xiu/Qiu/Si), no day-master strength,
 * no yong shen and no rooting (MISSING-003), and ETBZ-25 adds no calculation of
 * its own. A method with no source facts is therefore reported as
 * `not_evaluated` / `insufficient_method_scope` — never as an absent finding,
 * a neutral result or a silent omission.
 */

import type { ChartFactKind } from './feature-set.js';

export type MethodStatus = 'evaluated' | 'not_evaluated';
export type MethodReason = 'source_facts_present' | 'insufficient_method_scope';

export interface MethodNote {
  readonly methodId: string;
  readonly status: MethodStatus;
  readonly reason: MethodReason;
  /** Static, value-free statement. Never a finding. */
  readonly statement: string;
  /** For an evaluated method: the feature-set facts that carry it. */
  readonly sourceFactIds: readonly string[];
}

/** A method ETBZ evaluates, and the fact kinds that constitute its evidence. */
export interface EvaluatedMethodDefinition {
  readonly methodId: string;
  readonly factKinds: readonly ChartFactKind[];
  readonly statement: string;
}

export const EVALUATED_METHODS: readonly EvaluatedMethodDefinition[] = [
  {
    methodId: 'four_pillars',
    factKinds: [
      'pillar_stem',
      'pillar_stem_hanzi',
      'pillar_stem_pinyin',
      'pillar_branch',
      'pillar_branch_hanzi',
      'pillar_branch_pinyin',
      'pillar_stem_element',
      'pillar_branch_tier',
    ],
    statement: 'Four Pillars are present as FuFirE facts and are carried verbatim.',
  },
  {
    methodId: 'day_master',
    factKinds: [
      'day_master',
      'day_master_hanzi',
      'day_master_pinyin',
      'day_master_element',
      'day_master_polarity',
    ],
    statement: 'The day master is present as a FuFirE fact and is carried verbatim.',
  },
  {
    methodId: 'hidden_stems',
    factKinds: ['hidden_stem', 'hidden_stem_element'],
    statement: 'Hidden stems are present as FuFirE facts, in the source Qi order.',
  },
  {
    methodId: 'ten_gods',
    factKinds: ['ten_god', 'hidden_stem_ten_god'],
    statement: 'Ten Gods are present as FuFirE facts, with FuFirE’s own labels.',
  },
  {
    methodId: 'month_command',
    factKinds: ['month_command_branch', 'month_command_principal_qi_stem'],
    statement: 'The month command is present as a deterministic FuFirE ruleset fact.',
  },
  {
    methodId: 'wu_xing_distribution',
    factKinds: ['wu_xing_weight', 'wu_xing_dominant'],
    statement: 'The Wu Xing distribution is present as a FuFirE fact and is carried verbatim.',
  },
] as const;

/**
 * Methods this slice does NOT evaluate, each with the terms a narrative must
 * not use. The vocabulary is what makes the scope statement enforceable rather
 * than decorative: `report-model.ts` refuses prose that invokes any of it.
 */
export interface OutOfScopeMethodDefinition {
  readonly methodId: string;
  /** Lowercase match terms; matched case-insensitively against prose. */
  readonly vocabulary: readonly string[];
  readonly statement: string;
}

export const NOT_EVALUATED_METHODS: readonly OutOfScopeMethodDefinition[] = [
  {
    methodId: 'day_master_strength',
    vocabulary: ['wang shuai', 'wangshuai', 'day master strength', 'day-master strength', 'tageskraft', 'staerke des tagesmeisters', 'stärke des tagesmeisters'],
    statement: 'Day-master strength (Wang/Shuai) is not evaluated: the pinned FuFirE contract emits no strength assessment.',
  },
  {
    methodId: 'rooting',
    vocabulary: ['tong gen', 'tonggen', 'rooting', 'verwurzelung'],
    statement: 'Rooting (Tong Gen) is not evaluated: the pinned FuFirE contract emits no rooting assessment.',
  },
  {
    methodId: 'structure',
    vocabulary: ['ge ju', 'geju', 'structure chart', 'strukturmuster'],
    statement: 'Chart structure (Ge Ju) is not evaluated: the pinned FuFirE contract emits no structure classification.',
  },
  {
    methodId: 'useful_god',
    vocabulary: ['yong shen', 'yongshen', 'useful god', 'nutzgott'],
    statement: 'The useful god (Yong Shen) is not evaluated: the pinned FuFirE contract emits none.',
  },
  {
    methodId: 'climatic_adjustment',
    vocabulary: ['tiao hou', 'tiaohou', 'climatic adjustment', 'klimaausgleich'],
    statement: 'Climatic adjustment (Tiao Hou) is not evaluated: the pinned FuFirE contract emits none.',
  },
  {
    methodId: 'symbolic_stars',
    vocabulary: ['shen sha', 'shensha', 'symbolic star', 'symbolic stars', 'symbolsterne'],
    statement: 'Symbolic stars (Shen Sha) are not evaluated: the pinned FuFirE contract emits none.',
  },
  {
    methodId: 'luck_pillars',
    vocabulary: ['da yun', 'dayun', 'liu nian', 'liunian', 'luck pillar', 'luck pillars', 'gluecksperiode', 'glücksperiode'],
    statement: 'Luck pillars (Da Yun / Liu Nian) are not evaluated: they are outside this slice and no source facts are requested.',
  },
] as const;

export const NOT_EVALUATED_METHOD_IDS: readonly string[] = NOT_EVALUATED_METHODS.map(
  (method) => method.methodId,
);
