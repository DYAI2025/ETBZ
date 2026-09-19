/**
 * ETBZ-30B — the draft-level refusals of the MetaNarrativePlan.
 *
 * Pattern: the baseline is proven green first (N0), then each test changes as
 * little of it as the refusal needs. A refusal that belongs to the claim
 * contract — PD-5 — surfaces as the claim validator's own `ClaimError`; one
 * that belongs to the bound graph or the released registry surfaces as that
 * gate's error. A refusal only a plan can see is a `MetaNarrativePlanError`. In
 * every case nothing partial is returned. Binding, consistency-check and
 * counterfactual refusals of an ACCEPTED plan are in the unit suite (P6, P7).
 */
import { describe, expect, it, vi } from 'vitest';
import { structuralHash } from '../../src/domain/structural-hash.js';
import { ClaimGraphError, buildInterpretiveClaimGraph } from '../../src/application/interpretation/interpretive-claim-graph.js';
import type { InterpretiveClaimGraph } from '../../src/application/interpretation/interpretive-claim-graph.js';
import { ClaimError } from '../../src/application/interpretation/interpretive-claim.js';
import type { ClaimErrorCode } from '../../src/application/interpretation/interpretive-claim.js';
import { MetaNarrativePlanError, buildMetaNarrativePlan } from '../../src/application/interpretation/meta-narrative-plan.js';
import type {
  MetaNarrativePlanContext,
  MetaNarrativePlanErrorCode,
} from '../../src/application/interpretation/meta-narrative-plan.js';
import { BAZI_METHOD_REGISTRY_V1, MethodRegistryError } from '../../src/application/interpretation/method-registry.js';
import type { MethodRegistry } from '../../src/application/interpretation/method-registry.js';
import {
  KNOWN,
  MONTH_TEN_GOD,
  baselineClaims,
  contextFor,
  dayMasterClaim,
  dominantClaim,
  draftOf,
  recurrenceClaim,
  relationClaim,
} from '../support/claimGraphFixture.js';
import {
  M,
  PLAN_KNOWN,
  PLAN_UNKNOWN,
  T,
  branchClaim,
  chapter,
  claimIds,
  graphFor,
  idOf,
  planClaims,
  planContextFor,
  planWith,
  pressureClaim,
  stemElementClaim,
  validPlanDraft,
} from '../support/metaNarrativePlanFixture.js';
import type { MutablePlanDraft } from '../support/metaNarrativePlanFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';
import { ALTERNATE_TEN_GOD_ROW } from '../support/natalFixture.js';

const C = claimIds();
/** See the unit suite: a build re-proves the graph and PD-5 (~0.2 s); loops get an explicit budget. */
const MANY_BUILDS = 60_000;
vi.setConfig({ testTimeout: MANY_BUILDS });

function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectPlanRefusal(code: MetaNarrativePlanErrorCode, draft: unknown, context: MetaNarrativePlanContext = PLAN_KNOWN): MetaNarrativePlanError {
  const caught = refusalOf(() => buildMetaNarrativePlan(draft, context));
  expect(caught, `expected the plan to be refused with ${code}`).toBeInstanceOf(MetaNarrativePlanError);
  expect((caught as MetaNarrativePlanError).code, (caught as MetaNarrativePlanError).message).toBe(code);
  return caught as MetaNarrativePlanError;
}

function expectClaimRefusal(code: ClaimErrorCode, draft: unknown, context: MetaNarrativePlanContext = PLAN_KNOWN): void {
  const caught = refusalOf(() => buildMetaNarrativePlan(draft, context));
  expect(caught, `expected the claim contract to refuse with ${code}`).toBeInstanceOf(ClaimError);
  expect((caught as ClaimError).code, (caught as ClaimError).message).toBe(code);
}

function thread(draft: MutablePlanDraft, threadId: string): MutablePlanDraft['openThreads'][number] {
  const found = draft.openThreads.find((candidate) => candidate.threadId === threadId);
  if (found === undefined) {
    throw new Error(`fixture: no thread ${threadId}`);
  }
  return found;
}

/**
 * A plan over the given motif cores: one chapter seeds every motif and one
 * closes them all, each naming every core claim, and the two tensions the graph
 * states among the PD-5 claims are declared. Used where the NUMBER or the
 * SHAPE of the motif cores is the only thing under test.
 */
function motifsPlan(cores: readonly (readonly string[])[], context: MetaNarrativePlanContext = PLAN_KNOWN): MutablePlanDraft {
  const handles = cores.map((_, index) => `motif.${String(index)}`);
  const coreClaims = [...new Set(cores.flat())];
  return {
    sourceBriefStructuralHash: context.brief.structuralHash,
    claimGraphStructuralHash: context.graph.structuralHash,
    reportThesis: { claimRefs: [C.recurrence, C.pressure] },
    primaryMotifs: cores.map((core, index) => ({ motifId: handles[index] ?? '', coreClaimRefs: [...core] })),
    tensions: [{ claimRefs: [C.pressure, C.recurrence] }, { claimRefs: [C.pressure, C.resource] }],
    openThreads: [],
    chapterPlan: [
      { narrativeOperation: 'ESTABLISH', claimRefs: [...new Set([...coreClaims, C.recurrence])], motifTransitions: handles.map((motifRef) => ({ motifRef, toState: 'SEEDED' as const })), opensThreadRefs: [], closesThreadRefs: [] },
      { narrativeOperation: 'INTEGRATE', claimRefs: [...new Set([...coreClaims, C.pressure, C.recurrence, C.resource])], motifTransitions: handles.map((motifRef) => ({ motifRef, toState: 'CLOSED' as const })), opensThreadRefs: [], closesThreadRefs: [] },
    ],
  };
}

describe('ETBZ-30B N0: the baseline every refusal below mutates is accepted', () => {
  it('builds on the known-time and on the unknown-time chart', () => {
    expect(buildMetaNarrativePlan(validPlanDraft(), PLAN_KNOWN).primaryMotifs).toHaveLength(3);
    expect(buildMetaNarrativePlan(validPlanDraft(PLAN_UNKNOWN), PLAN_UNKNOWN).chapterPlan).toHaveLength(7);
  });

  it('rests on the relations of the ETBZ-30A claim fixtures that the refusals below rely on', () => {
    // SUPPORTS and QUALIFIES are not tensions (N9); dominant/day master is a stated contrast (N9).
    expect(relationClaim().relations).toEqual([{ type: 'SUPPORTS', targetClaimId: 'draft.recurrence' }]);
    expect(dayMasterClaim().relations).toEqual([{ type: 'QUALIFIES', targetClaimId: 'draft.recurrence' }]);
    expect(dominantClaim().relations).toEqual([{ type: 'CONTRASTS_WITH', targetClaimId: 'draft.dayMaster' }]);
    expect(recurrenceClaim().relations).toEqual([]);
  });
});

describe('ETBZ-30B N1: every semantic reference resolves to an accepted claim of the bound graph', () => {
  it('refuses an unknown thesis claimRef — an invented claim, a draft handle, a fact id', () => {
    for (const ref of ['claim.sha256:0000000000000000000000000000000000000000000000000000000000000000', 'draft.recurrence', MONTH_TEN_GOD]) {
      expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { draft.reportThesis.claimRefs = [C.recurrence, ref]; }));
    }
  }, MANY_BUILDS);

  it('refuses an unknown motif-core claimRef, and a claim accepted only in another chart\'s graph', () => {
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: ['claim.invented'] }; }));
    const otherChart = claimIds(PLAN_UNKNOWN.graph).dominant;
    expect(otherChart).not.toBe(C.dominant);
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: [otherChart] }; }));
  });

  it('refuses a dangling tension, thread or chapter claimRef', () => {
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { draft.tensions[0] = { claimRefs: [C.pressure, 'claim.invented'] }; }));
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { thread(draft, T.pressure).claimRefs = [C.pressure, 'claim.invented']; }));
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { chapter(draft, 4).claimRefs = [C.dayMaster, MONTH_TEN_GOD]; }));
  });

  it('refuses a claim that was ablated from the graph the plan is bound to', () => {
    const ablated = graphFor(KNOWN, [...baselineClaims(), pressureClaim({ relations: [{ type: 'CONTRASTS_WITH', targetClaimId: 'draft.recurrence' }] })]);
    const context = planContextFor(KNOWN, ablated);
    expect(ablated.claims.map((claim) => claim.claimId)).not.toContain(C.resource);
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', planWith((draft) => { draft.claimGraphStructuralHash = ablated.structuralHash; }), context);
  });

  it('refuses a transition or a chapter naming a motif or thread the plan does not declare', () => {
    expectPlanRefusal('PLAN_DANGLING_REFERENCE', planWith((draft) => { chapter(draft, 1).motifTransitions = [{ motifRef: 'motif.never-declared', toState: 'DEVELOPED' }]; }));
    expectPlanRefusal('PLAN_DANGLING_REFERENCE', planWith((draft) => { chapter(draft, 4).opensThreadRefs = ['thread.never-declared']; }));
    expectPlanRefusal('PLAN_DANGLING_REFERENCE', planWith((draft) => { chapter(draft, 6).closesThreadRefs = ['thread.never-declared']; }));
  }, MANY_BUILDS);
});

describe('ETBZ-30B N2: PD-5 for thesis and motif cores, and the floor of three central claims', () => {
  it('refuses a thesis on a claim below the PD-5 floor, with the claim contract\'s own refusal', () => {
    expectClaimRefusal('CLAIM_INSUFFICIENT_SIGNALS', planWith((draft) => { draft.reportThesis.claimRefs = [C.pressure, C.dayMaster]; }));
  });

  it('refuses a primary motif whose core holds a claim below the floor — also next to a claim above it', () => {
    expectClaimRefusal('CLAIM_INSUFFICIENT_SIGNALS', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: [C.dominant] }; }));
    expectClaimRefusal('CLAIM_INSUFFICIENT_SIGNALS', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: [C.resource, C.dominant] }; }));
  });

  it('gives a TENTATIVE claim no bypass: under an unknown time the tentative tally is still not a motif core', () => {
    const u = claimIds(PLAN_UNKNOWN.graph);
    expectClaimRefusal('CLAIM_INSUFFICIENT_SIGNALS', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: [u.dominant] }; }, PLAN_UNKNOWN), PLAN_UNKNOWN);
  });

  it('refuses a plan resting on fewer than three distinct central claims — and says what to do about it', () => {
    // Two distinct claims, two motifs, a thesis on one of them.
    const twoClaims = motifsPlan([[C.recurrence], [C.relation]]);
    twoClaims.reportThesis.claimRefs = [C.recurrence];
    const error = expectPlanRefusal('PLAN_INSUFFICIENT_CENTRAL_CLAIMS', twoClaims);
    // The bound graph holds more PD-5 claims; the refusal must not read as "the chart is too thin".
    expect(error.message).toContain('the plan may name them');
    expect(error.message).toContain('never pad');
    // Control: the same plan with a third distinct central claim meets the floor — two motifs are
    // then refused by the motif count (N5), not by the floor; a third genuine motif makes it a reading.
    const withThird = motifsPlan([[C.recurrence], [C.relation]]);
    withThird.reportThesis.claimRefs = [C.pressure];
    expectPlanRefusal('PLAN_MOTIF_COUNT_OUT_OF_RANGE', withThird);
    const thirdMotif = motifsPlan([[C.recurrence], [C.relation], [C.pressure]]);
    thirdMotif.reportThesis.claimRefs = [C.recurrence];
    expect(buildMetaNarrativePlan(thirdMotif, PLAN_KNOWN).primaryMotifs).toHaveLength(3);
  });

  it('does not let repetition reach the floor: a thesis naming one claim three times is refused, not counted', () => {
    const repeated = motifsPlan([[C.recurrence, C.relation]]);
    repeated.reportThesis.claimRefs = [C.recurrence, C.recurrence, C.recurrence];
    expectPlanRefusal('PLAN_DUPLICATE_REF', repeated);
    // Without the repetition the same plan has two central claims and is below the floor.
    repeated.reportThesis.claimRefs = [C.recurrence];
    expectPlanRefusal('PLAN_INSUFFICIENT_CENTRAL_CLAIMS', repeated);
  });
});

describe('ETBZ-30B N3: the plan is refused against a stale or damaged brief, graph or profile', () => {
  const hourChanged = contextFor(knownTimeModel({ natal: { pillars: { hour: { tenGod: ALTERNATE_TEN_GOD_ROW } } } }));

  it('refuses a stale NarrativeBrief hash', () => {
    expect(hourChanged.brief.structuralHash).not.toBe(KNOWN.brief.structuralHash);
    expectPlanRefusal('PLAN_BRIEF_HASH_MISMATCH', planWith((draft) => { draft.sourceBriefStructuralHash = hourChanged.brief.structuralHash; }));
  });

  it('refuses a stale ClaimGraph hash — the ETBZ-30A baseline graph of the same chart is another graph', () => {
    const older = buildInterpretiveClaimGraph(draftOf(baselineClaims()), KNOWN);
    expect(older.sourceBriefStructuralHash).toBe(KNOWN.brief.structuralHash);
    expectPlanRefusal('PLAN_CLAIM_GRAPH_HASH_MISMATCH', planWith((draft) => { draft.claimGraphStructuralHash = older.structuralHash; }));
  });

  it('refuses a mutated accepted graph: an edited claim, a forged relation, a forged graph hash', () => {
    const graph = PLAN_KNOWN.graph;
    const [first, ...rest] = graph.claims;
    if (first === undefined) throw new Error('fixture: empty graph');
    const forgedRelation = graph.claims.map((claim) => (claim.claimId === C.dayMaster
      ? { ...claim, relations: [...claim.relations, { type: 'CONTRASTS_WITH' as const, targetClaimId: C.pressure }] }
      : claim));
    const mutated: [string, InterpretiveClaimGraph][] = [
      ['an edited statement', { ...graph, claims: [{ ...first, statement: `${first.statement} (edited)` }, ...rest] }],
      ['an edited statement, graph re-hashed', (() => {
        const edited = { ...graph, claims: [{ ...first, statement: `${first.statement} (edited)` }, ...rest] };
        const core: Omit<InterpretiveClaimGraph, 'structuralHash'> & { structuralHash?: string } = { ...edited };
        delete core.structuralHash;
        return { ...core, structuralHash: structuralHash(core) };
      })()],
      ['a forged CONTRASTS_WITH', { ...graph, claims: forgedRelation }],
      ['a forged graph hash', { ...graph, structuralHash: `${graph.structuralHash}0` }],
    ];
    for (const [what, forged] of mutated) {
      const caught = refusalOf(() => buildMetaNarrativePlan(validPlanDraft(), { ...PLAN_KNOWN, graph: forged }));
      expect(caught, what).toBeInstanceOf(ClaimGraphError);
      expect((caught as ClaimGraphError).code, what).toBe('CLAIM_GRAPH_NOT_INTACT');
    }
  }, MANY_BUILDS);

  it('refuses a graph of another chart, a brief not derived from the model, and an unreleased registry', () => {
    const foreignGraph = refusalOf(() => buildMetaNarrativePlan(validPlanDraft(), { ...PLAN_KNOWN, graph: PLAN_UNKNOWN.graph }));
    expect(foreignGraph).toBeInstanceOf(ClaimGraphError);
    expect((foreignGraph as ClaimGraphError).code).toBe('CLAIM_GRAPH_NOT_INTACT');
    const foreignBrief = refusalOf(() => buildMetaNarrativePlan(validPlanDraft(), { ...PLAN_KNOWN, brief: hourChanged.brief }));
    expect(foreignBrief).toBeInstanceOf(ClaimGraphError);
    expect((foreignBrief as ClaimGraphError).code).toBe('CLAIM_GRAPH_BRIEF_NOT_DERIVED_FROM_MODEL');
    const drifted = structuredClone(BAZI_METHOD_REGISTRY_V1) as unknown as { methods: { methodId: string; operations: string[] }[] };
    drifted.methods.find((method) => method.methodId === 'ten_gods')?.operations.push('RANK_BY_IMPORTANCE');
    const unreleased = refusalOf(() => buildMetaNarrativePlan(validPlanDraft(), { ...PLAN_KNOWN, registry: drifted as unknown as MethodRegistry }));
    expect(unreleased).toBeInstanceOf(MethodRegistryError);
    expect((unreleased as MethodRegistryError).code).toBe('REGISTRY_NOT_RELEASED');
  }, MANY_BUILDS);
});

describe('ETBZ-30B N4: duplication never becomes narrative importance', () => {
  it('refuses a repeated reference in every list instead of counting it', () => {
    const repeated: [string, (draft: MutablePlanDraft) => void][] = [
      ['thesis', (draft) => { draft.reportThesis.claimRefs = [C.pressure, C.recurrence, C.pressure]; }],
      ['motif core', (draft) => { draft.primaryMotifs[0] = { motifId: M.expression, coreClaimRefs: [C.recurrence, C.relation, C.recurrence] }; }],
      ['tension', (draft) => { draft.tensions[0] = { claimRefs: [C.pressure, C.pressure] }; }],
      ['thread', (draft) => { thread(draft, T.pressure).claimRefs = [C.pressure, C.pressure]; }],
      ['chapter claims', (draft) => { chapter(draft, 1).claimRefs = [C.relation, C.relation]; }],
      ['one motif moved twice in one chapter', (draft) => { chapter(draft, 1).motifTransitions = [{ motifRef: M.expression, toState: 'DEVELOPED' }, { motifRef: M.expression, toState: 'COMPLICATED' }]; }],
      ['a thread opened twice in one chapter', (draft) => { chapter(draft, 2).opensThreadRefs = [T.pressure, T.pressure]; }],
      ['a thread closed twice in one chapter', (draft) => { chapter(draft, 6).closesThreadRefs = [T.pressure, T.pressure]; }],
    ];
    for (const [what, edit] of repeated) {
      const error = expectPlanRefusal('PLAN_DUPLICATE_REF', planWith(edit));
      expect(error.message, what).toContain('more than once');
    }
  }, MANY_BUILDS);

  it('refuses two motifs or two threads under one handle', () => {
    expectPlanRefusal('PLAN_DUPLICATE_HANDLE', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.pressure, coreClaimRefs: [C.resource] }; }));
    expectPlanRefusal('PLAN_DUPLICATE_HANDLE', planWith((draft) => { thread(draft, T.resource).threadId = T.pressure; }));
  });

  it('refuses the same motif, tension, thread or chapter submitted twice — reordered or renamed', () => {
    expectPlanRefusal('PLAN_DUPLICATE_CONTENT', planWith((draft) => {
      draft.primaryMotifs.push({ motifId: 'motif.expression-again', coreClaimRefs: [C.relation, C.recurrence] });
    }));
    expectPlanRefusal('PLAN_DUPLICATE_CONTENT', planWith((draft) => { draft.tensions.push({ claimRefs: [C.recurrence, C.pressure] }); }));
    // The same thread with the other fate is still the same thread, declared twice.
    expectPlanRefusal('PLAN_DUPLICATE_CONTENT', planWith((draft) => {
      draft.openThreads.push({ threadId: 'thread.pressure-again', claimRefs: [C.recurrence, C.pressure], resolution: 'LEAVE_OPEN' });
    }));
    expectPlanRefusal('PLAN_DUPLICATE_CONTENT', planWith((draft) => {
      draft.chapterPlan.push(structuredClone(chapter(draft, 4)));
    }));
  }, MANY_BUILDS);

  it('accepts a callback: a later chapter may name claims again when it does something else with them', () => {
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      draft.chapterPlan.splice(5, 0, { ...structuredClone(chapter(draft, 4)), narrativeOperation: 'CONTEXTUALIZE' });
    }), PLAN_KNOWN);
    expect(plan.chapterPlan).toHaveLength(8);
  });
});

describe('ETBZ-30B N5: a reading has three to five primary motifs where the chart supports them — never padded, never more', () => {
  // A graph with six claims above the PD-5 floor, so that six DISJOINT cores exist.
  const wide = planContextFor(KNOWN, graphFor(KNOWN, [...planClaims(), branchClaim(), stemElementClaim()]));
  const branch = idOf(branchClaim(), wide.graph);
  const stemElement = idOf(stemElementClaim(), wide.graph);
  const disjointCores = [[C.recurrence], [C.relation], [C.pressure], [C.resource], [branch], [stemElement]];
  /**
   * `count` disjoint single-claim motifs under a thesis on three PD-5 claims:
   * the central-claim floor is met whatever the count, so the count is the
   * only rule under test.
   */
  function motifs(count: number): MutablePlanDraft {
    const draft = motifsPlan(disjointCores.slice(0, count), wide);
    draft.reportThesis.claimRefs = [C.recurrence, C.pressure, C.resource];
    return draft;
  }

  it('refuses zero primary motifs, although the plan rests on three central claims', () => {
    expectPlanRefusal('PLAN_MOTIF_COUNT_OUT_OF_RANGE', motifs(0), wide);
  });

  it('refuses one primary motif, although the plan rests on three central claims', () => {
    expectPlanRefusal('PLAN_MOTIF_COUNT_OUT_OF_RANGE', motifs(1), wide);
  });

  it('refuses two primary motifs, although the plan rests on three central claims — and says to stop, not to pad', () => {
    const error = expectPlanRefusal('PLAN_MOTIF_COUNT_OUT_OF_RANGE', motifs(2), wide);
    expect(error.message).toContain('never pad');
  });

  // A refusal here must FAIL AN ASSERTION, not crash the test: the mutation
  // harness requires the named test to assert (scripts/verify-etbz30b-mutations.mjs).
  it('accepts three disjoint cores', () => {
    expect(() => buildMetaNarrativePlan(motifs(3), wide)).not.toThrow();
    expect(buildMetaNarrativePlan(motifs(3), wide).primaryMotifs).toHaveLength(3);
  });

  it('accepts four disjoint cores', () => {
    expect(() => buildMetaNarrativePlan(motifs(4), wide)).not.toThrow();
    expect(buildMetaNarrativePlan(motifs(4), wide).primaryMotifs).toHaveLength(4);
  });

  it('accepts five disjoint cores', () => {
    expect(() => buildMetaNarrativePlan(motifs(5), wide)).not.toThrow();
    expect(buildMetaNarrativePlan(motifs(5), wide).primaryMotifs).toHaveLength(5);
  });

  it('refuses six primary motifs — six disjoint, individually valid cores', () => {
    expectPlanRefusal('PLAN_MOTIF_COUNT_OUT_OF_RANGE', motifs(6), wide);
  });

  it('grants no priority by order: every order of three motifs, and five motifs reversed, give one plan', () => {
    const three = validPlanDraft();
    const [a, b, c] = three.primaryMotifs;
    if (a === undefined || b === undefined || c === undefined) throw new Error('fixture: the baseline has three motifs');
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const hashes = new Set(orders.map((primaryMotifs) => buildMetaNarrativePlan({ ...three, primaryMotifs }, PLAN_KNOWN).structuralHash));
    expect(hashes).toEqual(new Set([buildMetaNarrativePlan(three, PLAN_KNOWN).structuralHash]));
    const five = motifs(5);
    expect(buildMetaNarrativePlan({ ...five, primaryMotifs: [...five.primaryMotifs].reverse() }, wide).structuralHash)
      .toBe(buildMetaNarrativePlan(five, wide).structuralHash);
  }, MANY_BUILDS);
});

describe('ETBZ-30B N5b: one accepted meaning carries at most one primary motif', () => {
  it('refuses recombined cores — five "motifs" over three claims are not five motifs', () => {
    const recombined = motifsPlan([[C.recurrence], [C.relation], [C.pressure], [C.recurrence, C.relation], [C.recurrence, C.pressure]]);
    const error = expectPlanRefusal('PLAN_MOTIF_CORES_OVERLAP', recombined);
    expect(error.message).toContain('recombining');
    expectPlanRefusal('PLAN_MOTIF_CORES_OVERLAP', motifsPlan([[C.recurrence], [C.relation], [C.recurrence, C.relation]]));
    // A partial overlap in the baseline: the resource motif borrowing the relation claim.
    expectPlanRefusal('PLAN_MOTIF_CORES_OVERLAP', planWith((draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: [C.resource, C.relation] }; }));
  });

  it('refuses every way of padding two genuine motifs up to three: recombined, duplicated, below PD-5, invented or weighted', () => {
    const padded = (third: object): MutablePlanDraft => {
      const draft = motifsPlan([[C.recurrence], [C.relation]]);
      draft.primaryMotifs.push({ motifId: 'motif.padded', coreClaimRefs: [], ...third });
      return draft;
    };
    expectPlanRefusal('PLAN_MOTIF_CORES_OVERLAP', padded({ coreClaimRefs: [C.recurrence, C.relation] }));
    expectPlanRefusal('PLAN_DUPLICATE_CONTENT', padded({ coreClaimRefs: [C.relation] }));
    expectPlanRefusal('PLAN_DUPLICATE_REF', padded({ coreClaimRefs: [C.relation, C.relation] }));
    expectClaimRefusal('CLAIM_INSUFFICIENT_SIGNALS', padded({ coreClaimRefs: [C.dominant] }));
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', padded({ coreClaimRefs: ['claim.invented'] }));
    expectPlanRefusal('PLAN_UNKNOWN_CLAIM', padded({ coreClaimRefs: [MONTH_TEN_GOD] }));
    expectPlanRefusal('PLAN_SCHEMA_INVALID', padded({ coreClaimRefs: [C.pressure], salience: 1 }));
    // Control: a third motif on an accepted claim of its own is a reading, not padding.
    expect(buildMetaNarrativePlan(motifsPlan([[C.recurrence], [C.relation], [C.pressure]]), PLAN_KNOWN).primaryMotifs).toHaveLength(3);
  }, MANY_BUILDS);

  it('lets the thesis rest on motif-core claims: the thesis interprets the motifs, it is not a motif', () => {
    const plan = buildMetaNarrativePlan(validPlanDraft(), PLAN_KNOWN);
    const cores = new Set(plan.primaryMotifs.flatMap((motif) => motif.coreClaimRefs));
    expect(plan.reportThesis.claimRefs.every((claimId) => cores.has(claimId))).toBe(true);
  });
});

describe('ETBZ-30B N6: the motif lifecycle only moves forward', () => {
  it('refuses a step back, a step in place, a step to UNSEEN and any step after CLOSED', () => {
    const illegal: [string, (draft: MutablePlanDraft) => void][] = [
      ['DEVELOPED -> SEEDED', (draft) => { chapter(draft, 2).motifTransitions = [{ motifRef: M.pressure, toState: 'SEEDED' }, { motifRef: M.expression, toState: 'SEEDED' }]; }],
      ['SEEDED -> SEEDED', (draft) => { chapter(draft, 1).motifTransitions = [{ motifRef: M.expression, toState: 'SEEDED' }]; }],
      ['-> UNSEEN', (draft) => { chapter(draft, 1).motifTransitions = [{ motifRef: M.expression, toState: 'UNSEEN' }]; }],
      ['CLOSED -> INTEGRATED', (draft) => {
        chapter(draft, 6).motifTransitions = [{ motifRef: M.expression, toState: 'CLOSED' }, { motifRef: M.pressure, toState: 'INTEGRATED' }];
        draft.chapterPlan.push({ narrativeOperation: 'INTEGRATE', claimRefs: [C.recurrence, C.resource], motifTransitions: [{ motifRef: M.expression, toState: 'INTEGRATED' }], opensThreadRefs: [], closesThreadRefs: [] });
      }],
      ['INTEGRATED -> COMPLICATED', (draft) => {
        draft.chapterPlan.push({ narrativeOperation: 'CONTRAST', claimRefs: [C.recurrence, C.resource], motifTransitions: [{ motifRef: M.expression, toState: 'COMPLICATED' }], opensThreadRefs: [], closesThreadRefs: [] });
      }],
    ];
    for (const [what, edit] of illegal) {
      const error = expectPlanRefusal('PLAN_ILLEGAL_MOTIF_TRANSITION', planWith(edit));
      expect(error.message, what).toContain('only moves forward');
    }
  }, MANY_BUILDS);
});

describe('ETBZ-30B N7: a central motif is never silently forgotten', () => {
  it('refuses a primary motif no chapter ever opens', () => {
    const error = expectPlanRefusal('PLAN_MOTIF_SILENTLY_DROPPED', planWith((draft) => {
      chapter(draft, 3).motifTransitions = [];
      chapter(draft, 5).motifTransitions = [{ motifRef: M.pressure, toState: 'DEVELOPED' }];
    }));
    expect(error.message).toContain('never opened');
  });

  it('refuses a central motif opened and then silently dropped — no integration, no close, no thread leaving it open', () => {
    const dropped: [string, (draft: MutablePlanDraft) => void][] = [
      ['the resource thread removed', (draft) => {
        draft.openThreads = draft.openThreads.filter((candidate) => candidate.threadId !== T.resource);
        chapter(draft, 3).opensThreadRefs = [];
      }],
      ['expression never integrated', (draft) => { chapter(draft, 6).motifTransitions = [{ motifRef: M.pressure, toState: 'INTEGRATED' }]; }],
      ['a left-open thread naming none of its core claims does not rescue it', (draft) => {
        thread(draft, T.resource).claimRefs = [C.dayMaster];
        chapter(draft, 3).claimRefs = [C.dayMaster, C.dominant, C.resource];
      }],
      ['a thread that closes does not leave the motif open', (draft) => {
        thread(draft, T.resource).resolution = 'CLOSE';
        chapter(draft, 5).closesThreadRefs = [T.resource];
      }],
    ];
    for (const [what, edit] of dropped) {
      const error = expectPlanRefusal('PLAN_MOTIF_SILENTLY_DROPPED', planWith(edit));
      expect(error.message, what).toContain('neither integrated nor closed');
    }
  }, MANY_BUILDS);

  it('refuses a plan without chapters: every primary motif would be forgotten before it starts', () => {
    expectPlanRefusal('PLAN_MOTIF_SILENTLY_DROPPED', planWith((draft) => {
      draft.chapterPlan = [];
      draft.openThreads = [];
    }));
  });
});

describe('ETBZ-30B N8: threads are opened once and closed later, or explicitly left open', () => {
  it('refuses every broken thread lifecycle', () => {
    const broken: [string, (draft: MutablePlanDraft) => void][] = [
      ['declared, never opened', (draft) => { chapter(draft, 3).opensThreadRefs = []; }],
      ['opened in two chapters', (draft) => { chapter(draft, 5).opensThreadRefs = [T.pressure]; }],
      ['closed before it is opened', (draft) => { chapter(draft, 0).closesThreadRefs = [T.pressure]; chapter(draft, 6).closesThreadRefs = []; }],
      ['opened and closed in one chapter', (draft) => { chapter(draft, 2).closesThreadRefs = [T.pressure]; chapter(draft, 6).closesThreadRefs = []; }],
      ['closed in two chapters', (draft) => { chapter(draft, 5).closesThreadRefs = [T.pressure]; }],
      ['declared left open, then closed', (draft) => { chapter(draft, 5).closesThreadRefs = [T.resource]; }],
      ['declared to close, never closed', (draft) => { chapter(draft, 6).closesThreadRefs = []; }],
    ];
    for (const [what, edit] of broken) {
      const caught = refusalOf(() => buildMetaNarrativePlan(planWith(edit), PLAN_KNOWN));
      expect(caught, what).toBeInstanceOf(MetaNarrativePlanError);
      expect((caught as MetaNarrativePlanError).code, `${what}: ${(caught as Error).message}`).toBe('PLAN_THREAD_LIFECYCLE_INVALID');
    }
  }, MANY_BUILDS);
});

describe('ETBZ-30B N9: tensions are the graph\'s, and none it states among the planned claims is flattened', () => {
  it('refuses a tension the graph does not state as CONTRASTS_WITH — support and qualification are not tension', () => {
    // relation SUPPORTS recurrence; day master QUALIFIES recurrence.
    expectPlanRefusal('PLAN_TENSION_NOT_IN_GRAPH', planWith((draft) => { draft.tensions.push({ claimRefs: [C.recurrence, C.relation] }); }));
    expectPlanRefusal('PLAN_TENSION_NOT_IN_GRAPH', planWith((draft) => { draft.tensions.push({ claimRefs: [C.dayMaster, C.recurrence] }); }));
    expectPlanRefusal('PLAN_TENSION_NOT_IN_GRAPH', planWith((draft) => { draft.tensions.push({ claimRefs: [C.relation, C.resource] }); }));
  });

  it('refuses a plan that uses both sides of a stated contrast without declaring the tension', () => {
    const error = expectPlanRefusal('PLAN_TENSION_UNDECLARED', planWith((draft) => {
      draft.tensions = draft.tensions.filter((tension) => !tension.claimRefs.includes(C.dayMaster));
    }));
    expect(error.message).toContain(C.dominant);
    // Control: a plan that uses neither side need not declare it.
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      draft.tensions = draft.tensions.filter((tension) => !tension.claimRefs.includes(C.dayMaster));
      chapter(draft, 0).claimRefs = [C.recurrence];
      chapter(draft, 3).claimRefs = [C.resource];
      draft.chapterPlan.splice(4, 1);
    }), PLAN_KNOWN);
    expect(plan.coverage.unplannedClaimRefs).toEqual([C.dayMaster, C.dominant].sort());
  });
});

describe('ETBZ-30B N10: every plan element names accepted meaning', () => {
  it('refuses an empty thesis, motif core, thread or chapter', () => {
    const empty: [string, (draft: MutablePlanDraft) => void][] = [
      ['thesis', (draft) => { draft.reportThesis.claimRefs = []; }],
      ['motif core', (draft) => { draft.primaryMotifs[2] = { motifId: M.resource, coreClaimRefs: [] }; }],
      ['thread', (draft) => { thread(draft, T.resource).claimRefs = []; }],
      ['chapter', (draft) => { chapter(draft, 4).claimRefs = []; }],
    ];
    for (const [what, edit] of empty) {
      const error = expectPlanRefusal('PLAN_UNGROUNDED', planWith(edit));
      expect(error.message, what).toContain('names no accepted claim');
    }
  }, MANY_BUILDS);
});

describe('ETBZ-30B N12: a motif or thread moves only in a chapter that names its meaning', () => {
  it('refuses a motif moved by a chapter that names none of its core claims', () => {
    // The INTEGRATE chapter keeps only the pressure claim: the expression motif would be "integrated" on paper.
    const onPaper = expectPlanRefusal('PLAN_MOVEMENT_UNGROUNDED', planWith((draft) => { chapter(draft, 6).claimRefs = [C.pressure]; }));
    expect(onPaper.message).toContain('INTEGRATED');
    // The resource motif seeded and developed by chapters that never name the resource claim.
    expectPlanRefusal('PLAN_MOVEMENT_UNGROUNDED', planWith((draft) => {
      chapter(draft, 3).claimRefs = [C.dominant];
      chapter(draft, 5).claimRefs = [C.pressure];
    }));
  });

  it('refuses a thread opened or closed by a chapter that names none of its claims', () => {
    const opened = expectPlanRefusal('PLAN_MOVEMENT_UNGROUNDED', planWith((draft) => {
      chapter(draft, 2).opensThreadRefs = [T.pressure, T.resource];
      chapter(draft, 3).opensThreadRefs = [];
    }));
    expect(opened.message).toContain('opens thread');
    const closed = expectPlanRefusal('PLAN_MOVEMENT_UNGROUNDED', planWith((draft) => {
      draft.openThreads.push({ threadId: 'thread.dayMaster', claimRefs: [C.dayMaster], resolution: 'CLOSE' });
      chapter(draft, 4).opensThreadRefs = ['thread.dayMaster'];
      chapter(draft, 6).closesThreadRefs = [T.pressure, 'thread.dayMaster'];
    }));
    expect(closed.message).toContain('closes thread');
    // Control: the same thread closed where the day master is named is accepted.
    expect(buildMetaNarrativePlan(planWith((draft) => {
      draft.openThreads.push({ threadId: 'thread.dayMaster', claimRefs: [C.dayMaster], resolution: 'CLOSE' });
      chapter(draft, 0).opensThreadRefs = ['thread.dayMaster'];
      chapter(draft, 4).closesThreadRefs = ['thread.dayMaster'];
    }), PLAN_KNOWN).openThreads).toHaveLength(3);
  });
});

describe('ETBZ-30B N11: the draft is untrusted input with a closed shape', () => {
  const valid = (): Record<string, unknown> => structuredClone(validPlanDraft());

  /** Puts `key: value` on the draft element `where`, leaving everything else valid. */
  function onElement(where: string, key: string, value: unknown): Record<string, unknown> {
    const draft = valid() as unknown as MutablePlanDraft & Record<string, unknown>;
    const target: Record<string, unknown> = {
      root: draft,
      thesis: draft.reportThesis,
      motif: draft.primaryMotifs[0],
      tension: draft.tensions[0],
      thread: draft.openThreads[0],
      chapter: draft.chapterPlan[0],
      transition: draft.chapterPlan[0]?.motifTransitions[0],
    }[where] as Record<string, unknown>;
    target[key] = value;
    return draft;
  }

  it('refuses a salience, weight, confidence, rank, priority, importance or personality score anywhere', () => {
    for (const where of ['root', 'thesis', 'motif', 'tension', 'thread', 'chapter', 'transition']) {
      for (const [key, value] of [['salience', 0.9], ['weight', 2], ['confidence', 87], ['personalityScore', 'high'], ['rank', 1], ['priority', 'high'], ['importance', 1]] as const) {
        expectPlanRefusal('PLAN_SCHEMA_INVALID', onElement(where, key, value));
      }
    }
  }, MANY_BUILDS);

  it('refuses a new chart fact, a new claim, a method, prose or a label smuggled into the plan', () => {
    const smuggled: [string, string, unknown][] = [
      ['root', 'facts', [{ id: 'chart.invented', kind: 'pillar_stem', value: 'Jia' }]],
      ['root', 'claims', [{ claimId: 'claim.new', statement: 'A new interpretation.' }]],
      ['chapter', 'factRefs', [MONTH_TEN_GOD]],
      ['motif', 'factRefs', [MONTH_TEN_GOD]],
      ['chapter', 'methodRefs', ['day_master_strength']],
      ['thesis', 'statement', 'You are a born leader.'],
      ['motif', 'statement', 'The rebel.'],
      ['motif', 'label', 'Inner authority'],
      ['chapter', 'prose', 'Once upon a time.'],
      ['tension', 'relation', 'CLASHES_WITH'],
    ];
    for (const [where, key, value] of smuggled) {
      const error = expectPlanRefusal('PLAN_SCHEMA_INVALID', onElement(where, key, value));
      expect(error.message, `${where}.${key}`).toContain('unrecognized_keys');
    }
  }, MANY_BUILDS);

  it('refuses derived fields supplied by the drafter: version, bindings it cannot own, lexicon, coverage, constraints, lifecycle, ids', () => {
    const supplied: [string, string, unknown][] = [
      ['root', 'planVersion', 'etbz-30.meta-narrative-plan.v1'],
      ['root', 'structuralHash', 'sha256:0'],
      ['root', 'terminologyLexicon', { dependency: 'ETBZ-36', status: 'BOUND', lexiconRef: 'terminology-lexicon@1.0.0' }],
      ['root', 'coverage', {}],
      ['root', 'constraints', { allowedClaimRefs: [] }],
      ['root', 'methodProfileRef', 'bazi-method-profile@1.0.0'],
      ['motif', 'lifecycle', []],
      ['motif', 'finalState', 'CLOSED'],
      ['tension', 'tensionId', 'tension.mine'],
      ['chapter', 'chapterId', 'chapter.mine'],
    ];
    for (const [where, key, value] of supplied) {
      expectPlanRefusal('PLAN_SCHEMA_INVALID', onElement(where, key, value));
    }
  }, MANY_BUILDS);

  it('refuses provider, model and run identifiers: no such field exists to enter identity', () => {
    for (const key of ['providerId', 'model', 'runId', 'generatedAt', 'promptVersion']) {
      expectPlanRefusal('PLAN_SCHEMA_INVALID', onElement('root', key, 'x'));
    }
  }, MANY_BUILDS);

  it('refuses a word outside the closed vocabularies and a tension that is not a pair', () => {
    expectPlanRefusal('PLAN_SCHEMA_INVALID', planWith((draft) => { (chapter(draft, 0) as { narrativeOperation: string }).narrativeOperation = 'SUMMARIZE'; }));
    expectPlanRefusal('PLAN_SCHEMA_INVALID', planWith((draft) => { (chapter(draft, 0).motifTransitions[0] as { toState: string }).toState = 'RESOLVED'; }));
    expectPlanRefusal('PLAN_SCHEMA_INVALID', planWith((draft) => { (thread(draft, T.resource) as { resolution: string }).resolution = 'MAYBE'; }));
    expectPlanRefusal('PLAN_SCHEMA_INVALID', planWith((draft) => { draft.tensions[0] = { claimRefs: [C.pressure] }; }));
    expectPlanRefusal('PLAN_SCHEMA_INVALID', planWith((draft) => { draft.tensions[0] = { claimRefs: [C.pressure, C.recurrence, C.resource] }; }));
  }, MANY_BUILDS);

  it('refuses a malformed draft without echoing what it received', () => {
    const marker = 'UNTRUSTED-BULK-VALUE';
    const malformed: unknown[] = [
      null,
      'a string',
      { ...valid(), chapterPlan: 'not an array' },
      { ...valid(), reportThesis: { claimRefs: [marker, 7] } },
      { ...valid(), primaryMotifs: [{ motifId: '', coreClaimRefs: [C.pressure] }] },
      { ...valid(), primaryMotifs: [{ motifId: marker.repeat(40), coreClaimRefs: [C.pressure] }] },
      { ...valid(), reportThesis: { claimRefs: [marker.repeat(40)] } },
      { ...valid(), sourceBriefStructuralHash: undefined },
      { ...valid(), [marker]: 'x' },
      onElement('chapter', marker, 1),
    ];
    for (const draft of malformed) {
      const error = expectPlanRefusal('PLAN_SCHEMA_INVALID', draft);
      expect(error.message).not.toContain(marker);
    }
  }, MANY_BUILDS);
});
