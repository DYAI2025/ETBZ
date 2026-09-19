/**
 * ETBZ-30B — shared fixture for the MetaNarrativePlan suites.
 *
 * The chart, the brief and the claim graph all come from the real chain
 * (`claimGraphFixture` -> `buildNarrativeChain` -> `buildInterpretiveClaimGraph`),
 * so nothing here can drift from what the plan is bound to. The graph extends
 * the ETBZ-30A baseline by two claims the fixture chart really carries — the
 * Seven Killing and the Indirect Resource that each sit, identically, in the
 * year and the month branch — so that it holds four claims above the PD-5 floor
 * (recurrence, relation, pressure, resource) and two below it (day master,
 * dominant), and three CONTRASTS_WITH relations (pressure/recurrence,
 * pressure/resource, dominant/day master).
 *
 * A plan draft refers to ACCEPTED claim ids; motif and thread ids in a draft are
 * handles, exactly like the claim handles of a graph draft.
 */
import type { InterpretiveClaimGraph } from '../../src/application/interpretation/interpretive-claim-graph.js';
import { buildInterpretiveClaimGraph } from '../../src/application/interpretation/interpretive-claim-graph.js';
import type { InterpretiveClaim } from '../../src/application/interpretation/interpretive-claim.js';
import type {
  MetaNarrativePlanContext,
  MetaNarrativePlanDraft,
} from '../../src/application/interpretation/meta-narrative-plan.js';
import type { ClaimGraphContext } from '../../src/application/interpretation/interpretive-claim-graph.js';
import {
  H,
  KNOWN,
  UNKNOWN,
  dayMasterClaim,
  dominantClaim,
  draftOf,
  recurrenceClaim,
  relationClaim,
  tentativeDominantClaim,
} from './claimGraphFixture.js';

export const MONTH_HIDDEN_0_TEN_GOD = 'chart.natal.pillar.month.hiddenStem.0.tenGod'; // SevenKilling
export const YEAR_HIDDEN_0_TEN_GOD = 'chart.natal.pillar.year.hiddenStem.0.tenGod'; // SevenKilling
export const MONTH_HIDDEN_0_RELATION = 'chart.natal.pillar.month.hiddenStem.0.tenGod.elementRelation'; // controls_day_master
export const MONTH_HIDDEN_1_TEN_GOD = 'chart.natal.pillar.month.hiddenStem.1.tenGod'; // IndirectRes
export const YEAR_HIDDEN_1_TEN_GOD = 'chart.natal.pillar.year.hiddenStem.1.tenGod'; // IndirectRes
export const MONTH_HIDDEN_1_RELATION = 'chart.natal.pillar.month.hiddenStem.1.tenGod.elementRelation'; // produces_day_master

export const PLAN_H = { pressure: 'draft.pressure', resource: 'draft.resource' } as const;

/** Two fact kinds, three non-modifier methods: satisfies PD-5. Contrasts with expression and with the resource. */
export function pressureClaim(overrides: Partial<InterpretiveClaim> = {}): InterpretiveClaim {
  return {
    claimId: PLAN_H.pressure,
    statement: 'A controlling voice sits, the same, inside the year branch and inside the month branch.',
    factRefs: [MONTH_HIDDEN_0_TEN_GOD, YEAR_HIDDEN_0_TEN_GOD, MONTH_HIDDEN_0_RELATION],
    themeRefs: [],
    methodRefs: ['ten_gods', 'fact_relations', 'wu_xing_relations'],
    epistemicClass: 'SUPPORTED_INTERPRETATION',
    provisionalFactRefs: [],
    relations: [
      { type: 'CONTRASTS_WITH', targetClaimId: H.recurrence },
      { type: 'CONTRASTS_WITH', targetClaimId: PLAN_H.resource },
    ],
    ...overrides,
  };
}

/** Two fact kinds, three non-modifier methods: satisfies PD-5. */
export function resourceClaim(overrides: Partial<InterpretiveClaim> = {}): InterpretiveClaim {
  return {
    claimId: PLAN_H.resource,
    statement: 'A resourcing voice sits, the same, inside the year branch and inside the month branch.',
    factRefs: [MONTH_HIDDEN_1_TEN_GOD, YEAR_HIDDEN_1_TEN_GOD, MONTH_HIDDEN_1_RELATION],
    themeRefs: [],
    methodRefs: ['ten_gods', 'fact_relations', 'wu_xing_relations'],
    epistemicClass: 'SUPPORTED_INTERPRETATION',
    provisionalFactRefs: [],
    relations: [],
    ...overrides,
  };
}

/**
 * A fifth claim above the PD-5 floor — the year and the month branch are the
 * same branch (identity pair) — used only where a test needs five disjoint
 * motif cores. Not part of the plan graph.
 */
export function branchClaim(overrides: Partial<InterpretiveClaim> = {}): InterpretiveClaim {
  return {
    claimId: 'draft.branch',
    statement: 'The same branch stands under the year and under the month.',
    factRefs: ['chart.pillar.year.branch', 'chart.pillar.month.branch', 'chart.pillar.year.tier'],
    themeRefs: [],
    methodRefs: ['earthly_branches', 'fact_relations'],
    epistemicClass: 'SUPPORTED_INTERPRETATION',
    provisionalFactRefs: [],
    relations: [],
    ...overrides,
  };
}

/** A sixth claim above the PD-5 floor — year and day stem share the stem element Metall. Not part of the plan graph. */
export function stemElementClaim(overrides: Partial<InterpretiveClaim> = {}): InterpretiveClaim {
  return {
    claimId: 'draft.stemElement',
    statement: 'The year stem and the day stem are of one element.',
    factRefs: ['chart.pillar.year.stemElement', 'chart.pillar.day.stemElement', 'chart.pillar.year.stem'],
    themeRefs: [],
    methodRefs: ['heavenly_stems', 'fact_relations'],
    epistemicClass: 'SUPPORTED_INTERPRETATION',
    provisionalFactRefs: [],
    relations: [],
    ...overrides,
  };
}

export function planClaims(context: ClaimGraphContext = KNOWN): InterpretiveClaim[] {
  return [
    recurrenceClaim(),
    relationClaim(),
    dayMasterClaim(),
    context === UNKNOWN ? tentativeDominantClaim() : dominantClaim(),
    pressureClaim(),
    resourceClaim(),
  ];
}

export function graphFor(context: ClaimGraphContext = KNOWN, claims: readonly InterpretiveClaim[] = planClaims(context)): InterpretiveClaimGraph {
  return buildInterpretiveClaimGraph(draftOf(claims, context), context);
}

export function planContextFor(context: ClaimGraphContext = KNOWN, graph: InterpretiveClaimGraph = graphFor(context)): MetaNarrativePlanContext {
  return { ...context, graph };
}

export const PLAN_KNOWN = planContextFor(KNOWN);
export const PLAN_UNKNOWN = planContextFor(UNKNOWN);

/**
 * The accepted id of a draft claim, found by its statement — every statement of
 * the plan graph is unique, and this refuses to guess otherwise.
 */
export function idOf(draft: InterpretiveClaim, graph: InterpretiveClaimGraph = PLAN_KNOWN.graph): string {
  const found = graph.claims.filter((claim) => claim.statement === draft.statement);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new Error(`fixture: ${String(found.length)} accepted claims carry the statement of "${draft.claimId}", expected exactly one`);
  }
  return only.claimId;
}

/** Accepted ids of the six plan claims in one graph. */
export function claimIds(graph: InterpretiveClaimGraph = PLAN_KNOWN.graph): Readonly<Record<'recurrence' | 'relation' | 'dayMaster' | 'dominant' | 'pressure' | 'resource', string>> {
  return {
    recurrence: idOf(recurrenceClaim(), graph),
    relation: idOf(relationClaim(), graph),
    dayMaster: idOf(dayMasterClaim(), graph),
    dominant: idOf(dominantClaim(), graph),
    pressure: idOf(pressureClaim(), graph),
    resource: idOf(resourceClaim(), graph),
  };
}

export const M = { expression: 'motif.expression', pressure: 'motif.pressure', resource: 'motif.resource' } as const;
export const T = { pressure: 'thread.pressure', resource: 'thread.resource' } as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };
export type MutablePlanDraft = Mutable<MetaNarrativePlanDraft>;

/**
 * The baseline draft: three primary motifs over four central claims (disjoint
 * cores), the three tensions the graph states among the claims the plan uses,
 * one thread that closes and one deliberately left open, and seven chapters in
 * reading order. Every chapter that moves a motif or a thread names one of its
 * claims.
 *
 *   1 ESTABLISH      expression -> SEEDED
 *   2 REINFORCE      expression -> DEVELOPED
 *   3 CONTRAST       pressure   -> SEEDED, expression -> COMPLICATED   opens pressure thread
 *   4 CONTEXTUALIZE  resource   -> SEEDED                            opens resource thread
 *   5 QUALIFY        —
 *   6 CONTRAST       pressure   -> DEVELOPED, resource -> DEVELOPED
 *   7 INTEGRATE      expression -> INTEGRATED, pressure -> INTEGRATED  closes pressure thread
 *
 * The resource motif ends DEVELOPED and is explicitly left open by its thread.
 */
export function validPlanDraft(context: MetaNarrativePlanContext = PLAN_KNOWN): MutablePlanDraft {
  const c = claimIds(context.graph);
  return {
    sourceBriefStructuralHash: context.brief.structuralHash,
    claimGraphStructuralHash: context.graph.structuralHash,
    reportThesis: { claimRefs: [c.recurrence, c.pressure] },
    primaryMotifs: [
      { motifId: M.expression, coreClaimRefs: [c.recurrence, c.relation] },
      { motifId: M.pressure, coreClaimRefs: [c.pressure] },
      { motifId: M.resource, coreClaimRefs: [c.resource] },
    ],
    tensions: [
      { claimRefs: [c.pressure, c.recurrence] },
      { claimRefs: [c.pressure, c.resource] },
      { claimRefs: [c.dominant, c.dayMaster] },
    ],
    openThreads: [
      { threadId: T.pressure, claimRefs: [c.pressure, c.recurrence], resolution: 'CLOSE' },
      { threadId: T.resource, claimRefs: [c.resource], resolution: 'LEAVE_OPEN' },
    ],
    chapterPlan: [
      {
        narrativeOperation: 'ESTABLISH',
        claimRefs: [c.dayMaster, c.recurrence],
        motifTransitions: [{ motifRef: M.expression, toState: 'SEEDED' }],
        opensThreadRefs: [],
        closesThreadRefs: [],
      },
      {
        narrativeOperation: 'REINFORCE',
        claimRefs: [c.relation],
        motifTransitions: [{ motifRef: M.expression, toState: 'DEVELOPED' }],
        opensThreadRefs: [],
        closesThreadRefs: [],
      },
      {
        narrativeOperation: 'CONTRAST',
        claimRefs: [c.pressure, c.recurrence],
        motifTransitions: [
          { motifRef: M.pressure, toState: 'SEEDED' },
          { motifRef: M.expression, toState: 'COMPLICATED' },
        ],
        opensThreadRefs: [T.pressure],
        closesThreadRefs: [],
      },
      {
        narrativeOperation: 'CONTEXTUALIZE',
        claimRefs: [c.dominant, c.resource],
        motifTransitions: [{ motifRef: M.resource, toState: 'SEEDED' }],
        opensThreadRefs: [T.resource],
        closesThreadRefs: [],
      },
      {
        narrativeOperation: 'QUALIFY',
        claimRefs: [c.dayMaster, c.dominant],
        motifTransitions: [],
        opensThreadRefs: [],
        closesThreadRefs: [],
      },
      {
        narrativeOperation: 'CONTRAST',
        claimRefs: [c.pressure, c.resource],
        motifTransitions: [
          { motifRef: M.pressure, toState: 'DEVELOPED' },
          { motifRef: M.resource, toState: 'DEVELOPED' },
        ],
        opensThreadRefs: [],
        closesThreadRefs: [],
      },
      {
        narrativeOperation: 'INTEGRATE',
        claimRefs: [c.pressure, c.recurrence, c.relation],
        motifTransitions: [
          { motifRef: M.expression, toState: 'INTEGRATED' },
          { motifRef: M.pressure, toState: 'INTEGRATED' },
        ],
        opensThreadRefs: [],
        closesThreadRefs: [T.pressure],
      },
    ],
  };
}

/** The baseline with one edit applied to a deep copy — every other part stays valid. */
export function planWith(edit: (draft: MutablePlanDraft) => void, context: MetaNarrativePlanContext = PLAN_KNOWN): MutablePlanDraft {
  const draft = structuredClone(validPlanDraft(context));
  edit(draft);
  return draft;
}

/** Chapter `index` of a draft, or a loud fixture error. */
export function chapter(draft: MutablePlanDraft, index: number): MutablePlanDraft['chapterPlan'][number] {
  const found = draft.chapterPlan[index];
  if (found === undefined) {
    throw new Error(`fixture: the draft has no chapter ${String(index)}`);
  }
  return found;
}
