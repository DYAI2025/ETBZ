/**
 * ETBZ-25 — InterpretationFeatureSet: the HoroscopeModel restated as addressable
 * facts, and NOTHING else.
 *
 * This is the first hop of the narrative chain
 *
 *   HoroscopeModel -> InterpretationFeatureSet -> ThemeGraph -> NarrativeBrief
 *                  -> NarrativeProvider -> ReportModel
 *
 * and it is deliberately the dullest one. Every `ChartFact` below is a value
 * that already exists in the HoroscopeModel, copied verbatim, with the source
 * path it came from. No value is combined, weighted, ranked, translated or
 * interpreted here; no astrological rule is applied. The only thing this module
 * ADDS is addressability: a stable id per fact, so that everything downstream —
 * a theme, a provider sentence, a report section — can be required to point at
 * a specific fact instead of at the chart in general.
 *
 * Provisionality is lineage, not judgement: a fact inherits `provisional` from
 * the pillar its source path runs through, and the pillar set comes from
 * FuFirE's own `precision.provisional_fields`. ETBZ never widens certainty and
 * never invents a provisional field FuFirE did not state.
 */

import { structuralHash, structuralHashOfCanonicalText } from '../../domain/structural-hash.js';
import type { HoroscopeModel, PillarName } from '../horoscope-model.js';
import { WUXING_ELEMENTS } from '../ports/fufire-gateway.js';
import { InterpretationError } from './errors.js';
import { EVALUATED_METHODS, NOT_EVALUATED_METHODS } from './method-scope.js';
import type { MethodNote } from './method-scope.js';

export const PILLAR_NAMES: readonly PillarName[] = ['year', 'month', 'day', 'hour'];

export type ChartFactKind =
  | 'pillar_stem'
  | 'pillar_stem_hanzi'
  | 'pillar_stem_pinyin'
  | 'pillar_branch'
  | 'pillar_branch_hanzi'
  | 'pillar_branch_pinyin'
  | 'pillar_stem_element'
  | 'pillar_branch_tier'
  | 'day_master'
  | 'day_master_hanzi'
  | 'day_master_pinyin'
  | 'day_master_element'
  | 'day_master_polarity'
  | 'wu_xing_weight'
  | 'wu_xing_dominant'
  | 'ten_god'
  | 'hidden_stem'
  | 'hidden_stem_element'
  | 'hidden_stem_ten_god'
  | 'month_command_branch'
  | 'month_command_principal_qi_stem';

/**
 * One addressable chart fact.
 *
 * `value` is the source value verbatim, as text — numbers are rendered with
 * `JSON.stringify` so that a citation can be compared byte-for-byte without a
 * numeric-formatting question ever entering the comparison.
 */
export interface ChartFact {
  /** Stable, deterministic address. Derived from `path`, never from position. */
  readonly id: string;
  /** Where the value lives in the HoroscopeModel. */
  readonly path: string;
  readonly kind: ChartFactKind;
  readonly value: string;
  /** The SOURCE's own human label for this fact, when it supplies one. */
  readonly sourceLabel: string | null;
  /** The pillar this fact's lineage runs through, or null when it has none. */
  readonly pillar: PillarName | null;
  readonly provisional: boolean;
}

export interface InterpretationFeatureSet {
  readonly featureSetVersion: 'etbz-25.feature-set.v1';
  /** Hash of the HoroscopeModel's own canonical fact text. */
  readonly sourceStructuralHash: string;
  readonly facts: readonly ChartFact[];
  readonly factIds: readonly string[];
  readonly provisionalFactIds: readonly string[];
  /**
   * FuFirE's provisional-field statements, BOTH preserved verbatim and
   * separately, because they are two source statements and collapsing them
   * would silently pick a winner.
   */
  readonly provisionalFields: Readonly<{
    bazi: readonly string[];
    natal: readonly string[];
  }>;
  /** The pillars marked provisional by either statement (union; never a narrowing). */
  readonly provisionalPillars: readonly PillarName[];
  readonly birthTimeKnown: boolean;
  /** FuFirE's warning codes, verbatim: source order, duplicates, unknown codes. */
  readonly sourceWarnings: readonly string[];
  readonly methodScope: readonly MethodNote[];
  readonly structuralHash: string;
}

function isPillarName(value: string): value is PillarName {
  return (PILLAR_NAMES as readonly string[]).includes(value);
}

/** Number to text, deterministically: `2.5` -> `"2.5"`, `1` -> `"1"`. */
function numberText(value: number): string {
  return JSON.stringify(value);
}

/**
 * Resolves the provisional pillar set.
 *
 * A field ETBZ cannot map to a pillar is NOT ignored: ignoring it would quietly
 * convert a stated uncertainty into silence. It fails the derivation instead.
 */
function resolveProvisionalPillars(model: HoroscopeModel): readonly PillarName[] {
  const pillars = new Set<PillarName>();
  const sources: readonly (readonly [string, readonly string[]])[] = [
    ['precision.provisionalFields', model.precision.provisionalFields],
    ['natal.precision.provisionalFields', model.natal.precision.provisionalFields],
  ];
  for (const [where, fields] of sources) {
    for (const field of fields) {
      if (!isPillarName(field)) {
        throw new InterpretationError(
          'FEATURE_SET_PROVISIONAL_FIELD_UNMAPPED',
          `${where} names "${field}", which ETBZ-25 cannot map to a pillar; a stated uncertainty must never be dropped`,
        );
      }
      pillars.add(field);
    }
  }
  return PILLAR_NAMES.filter((name) => pillars.has(name));
}

function buildFacts(model: HoroscopeModel, provisionalPillars: readonly PillarName[]): ChartFact[] {
  const provisional = new Set<PillarName>(provisionalPillars);
  const facts: ChartFact[] = [];

  const push = (
    id: string,
    path: string,
    kind: ChartFactKind,
    value: string,
    sourceLabel: string | null,
    pillar: PillarName | null,
  ): void => {
    facts.push({
      id,
      path,
      kind,
      value,
      sourceLabel,
      pillar,
      provisional: pillar !== null && provisional.has(pillar),
    });
  };

  for (const pillar of PILLAR_NAMES) {
    const fact = model.pillars[pillar];
    push(`chart.pillar.${pillar}.stem`, `pillars.${pillar}.stem`, 'pillar_stem', fact.stem, null, pillar);
    push(`chart.pillar.${pillar}.stemHanzi`, `pillars.${pillar}.stemHanzi`, 'pillar_stem_hanzi', fact.stemHanzi, null, pillar);
    push(`chart.pillar.${pillar}.stemPinyin`, `pillars.${pillar}.stemPinyin`, 'pillar_stem_pinyin', fact.stemPinyin, null, pillar);
    push(`chart.pillar.${pillar}.branch`, `pillars.${pillar}.branch`, 'pillar_branch', fact.branch, null, pillar);
    push(`chart.pillar.${pillar}.branchHanzi`, `pillars.${pillar}.branchHanzi`, 'pillar_branch_hanzi', fact.branchHanzi, null, pillar);
    push(`chart.pillar.${pillar}.branchPinyin`, `pillars.${pillar}.branchPinyin`, 'pillar_branch_pinyin', fact.branchPinyin, null, pillar);
    push(
      `chart.pillar.${pillar}.stemElement`,
      `pillars.${pillar}.stemElementDe`,
      'pillar_stem_element',
      fact.stemElementDe,
      null,
      pillar,
    );
    push(
      `chart.pillar.${pillar}.tier`,
      `pillars.${pillar}.tierDe`,
      'pillar_branch_tier',
      fact.tierDe,
      null,
      pillar,
    );
  }

  // The day master IS the day stem (the HoroscopeModel already refuses any
  // chart where that is not true), so its lineage is the day pillar.
  push('chart.dayMaster.stem', 'dayMaster.stem', 'day_master', model.dayMaster.stem, null, 'day');
  push(
    'chart.dayMaster.stemHanzi',
    'dayMaster.stemHanzi',
    'day_master_hanzi',
    model.dayMaster.stemHanzi,
    null,
    'day',
  );
  push(
    'chart.dayMaster.stemPinyin',
    'dayMaster.stemPinyin',
    'day_master_pinyin',
    model.dayMaster.stemPinyin,
    null,
    'day',
  );
  push(
    'chart.dayMaster.element',
    'dayMaster.elementDe',
    'day_master_element',
    model.dayMaster.elementDe,
    null,
    'day',
  );
  push(
    'chart.dayMaster.polarity',
    'natal.dayMaster.polarity',
    'day_master_polarity',
    model.natal.dayMaster.polarity,
    null,
    'day',
  );

  // Wu Xing carries no pillar in its source path, so it inherits no pillar
  // provisionality. Whether FuFirE's distribution is itself provisional under an
  // unknown birth time is a SOURCE statement ETBZ does not have and will not
  // invent; `precision.provisionalFields` does not name it.
  push(
    'chart.wuxing.dominant',
    'wuxing.dominant',
    'wu_xing_dominant',
    model.wuxing.dominant,
    null,
    null,
  );
  for (const element of WUXING_ELEMENTS) {
    const weight = model.wuxing.vector[element];
    if (weight === undefined) {
      continue;
    }
    // The source label of a weight is the ELEMENT NAME, which is the key
    // FuFirE's own vector is addressed by. It is source-owned in the same sense
    // the value is: ETBZ neither coins nor translates it here.
    push(
      `chart.wuxing.weight.${element}`,
      `wuxing.vector.${element}`,
      'wu_xing_weight',
      numberText(weight),
      element,
      null,
    );
  }

  for (const pillar of PILLAR_NAMES) {
    const natalPillar = model.natal.pillars[pillar];
    const tenGod = natalPillar.tenGod;
    if (tenGod !== null) {
      push(
        `chart.natal.pillar.${pillar}.tenGod`,
        `natal.pillars.${pillar}.tenGod.name`,
        'ten_god',
        tenGod.name,
        tenGod.labelDe,
        pillar,
      );
    }
    natalPillar.hiddenStems.forEach((hidden, index) => {
      push(
        `chart.natal.pillar.${pillar}.hiddenStem.${index}.stem`,
        `natal.pillars.${pillar}.hiddenStems[${index}].stem`,
        'hidden_stem',
        hidden.stem,
        hidden.qi,
        pillar,
      );
      push(
        `chart.natal.pillar.${pillar}.hiddenStem.${index}.element`,
        `natal.pillars.${pillar}.hiddenStems[${index}].element`,
        'hidden_stem_element',
        hidden.element,
        null,
        pillar,
      );
      push(
        `chart.natal.pillar.${pillar}.hiddenStem.${index}.tenGod`,
        `natal.pillars.${pillar}.hiddenStems[${index}].tenGod.name`,
        'hidden_stem_ten_god',
        hidden.tenGod.name,
        hidden.tenGod.labelDe,
        pillar,
      );
    });
  }

  // The month command is the MONTH branch's ruleset lookup (the HoroscopeModel
  // enforces that identity), so its lineage is the month pillar.
  push(
    'chart.natal.monthCommand.branch',
    'natal.monthCommand.branch',
    'month_command_branch',
    model.natal.monthCommand.branch,
    null,
    'month',
  );
  push(
    'chart.natal.monthCommand.principalQiStem',
    'natal.monthCommand.principalQiStem',
    'month_command_principal_qi_stem',
    model.natal.monthCommand.principalQiStem,
    null,
    'month',
  );

  // Sorted by id: the fact order is a property of the chart, never of the order
  // this function happens to visit the model in.
  return facts.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function buildMethodScope(facts: readonly ChartFact[]): readonly MethodNote[] {
  const notes: MethodNote[] = [];
  for (const method of EVALUATED_METHODS) {
    const kinds = new Set<ChartFactKind>(method.factKinds);
    const sourceFactIds = facts.filter((fact) => kinds.has(fact.kind)).map((fact) => fact.id);
    // EVERY declared kind must be present, not merely one of them. A method
    // whose evidence is partially missing is not "evaluated with a gap" - it is
    // a scope statement the facts do not support, and it fails closed.
    const missingKinds = method.factKinds.filter(
      (kind) => !facts.some((fact) => fact.kind === kind),
    );
    if (missingKinds.length > 0) {
      throw new InterpretationError(
        'FEATURE_SET_METHOD_WITHOUT_SOURCE_FACTS',
        `method "${method.methodId}" is declared evaluated but the chart carries no fact of kind(s) ${missingKinds.join(", ")}; a scope statement without evidence is a claim`,
      );
    }
    notes.push({
      methodId: method.methodId,
      status: 'evaluated',
      reason: 'source_facts_present',
      statement: method.statement,
      sourceFactIds,
    });
  }
  for (const method of NOT_EVALUATED_METHODS) {
    notes.push({
      methodId: method.methodId,
      status: 'not_evaluated',
      reason: 'insufficient_method_scope',
      statement: method.statement,
      sourceFactIds: [],
    });
  }
  return notes.sort((left, right) =>
    left.methodId < right.methodId ? -1 : left.methodId > right.methodId ? 1 : 0,
  );
}

/**
 * Derives the feature set. Pure: same HoroscopeModel in, byte-identical feature
 * set out, including its structural hash.
 */
export function deriveInterpretationFeatureSet(
  model: HoroscopeModel,
): InterpretationFeatureSet {
  const provisionalPillars = resolveProvisionalPillars(model);
  const facts = buildFacts(model, provisionalPillars);
  const methodScope = buildMethodScope(facts);

  const core = {
    featureSetVersion: 'etbz-25.feature-set.v1' as const,
    // The model's canonical text is already canonical: hash the TEXT, so the
    // value can be re-derived with a plain sha256 of `model.canonicalJson`.
    sourceStructuralHash: structuralHashOfCanonicalText(model.canonicalJson),
    facts,
    factIds: facts.map((fact) => fact.id),
    provisionalFactIds: facts.filter((fact) => fact.provisional).map((fact) => fact.id),
    provisionalFields: {
      bazi: [...model.precision.provisionalFields],
      natal: [...model.natal.precision.provisionalFields],
    },
    provisionalPillars,
    birthTimeKnown: model.precision.birthTimeKnown,
    // Verbatim, in source order, with duplicates: this array is evidence.
    sourceWarnings: [...model.sourceWarnings],
    methodScope,
  };

  return { ...core, structuralHash: structuralHash(core) };
}
