/**
 * ETBZ-30B — MetaNarrativePlan: the accepted, normalised, hash-bound plan of
 * WHICH accepted meanings a long-form reading develops, in which order.
 *
 * Positive shape, bindings, identity, determinism, the PD-5 composition, the
 * lifecycle walk, coverage and constraints, serialisation, and the consistency
 * check with the refusals that belong to it (P1–P7). The draft-level refusals
 * live in `tests/negative/meta-narrative-plan.negative.test.ts`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { structuralHash } from '../../src/domain/structural-hash.js';
import {
  ClaimGraphError,
  assertCentralGraphClaim,
  buildInterpretiveClaimGraph,
} from '../../src/application/interpretation/interpretive-claim-graph.js';
import type { InterpretiveClaimGraph } from '../../src/application/interpretation/interpretive-claim-graph.js';
import { ClaimError } from '../../src/application/interpretation/interpretive-claim.js';
import {
  META_NARRATIVE_PLAN_VERSION,
  MOTIF_LIFECYCLE,
  MetaNarrativePlanError,
  NARRATIVE_OPERATIONS,
  TERMINOLOGY_LEXICON_BINDING,
  THREAD_RESOLUTIONS,
  assertMetaNarrativePlanIntact,
  buildMetaNarrativePlan,
  metaNarrativePlanDraftOf,
} from '../../src/application/interpretation/meta-narrative-plan.js';
import type {
  MetaNarrativePlan,
  MetaNarrativePlanContext,
  MetaNarrativePlanErrorCode,
} from '../../src/application/interpretation/meta-narrative-plan.js';
import {
  BAZI_METHOD_REGISTRY_V1,
  METHOD_PROFILE_REF,
  METHOD_PROFILE_VERSION,
  MethodRegistryError,
  methodRegistryStructuralHash,
} from '../../src/application/interpretation/method-registry.js';
import type { MethodRegistry } from '../../src/application/interpretation/method-registry.js';
import { KNOWN, contextFor, dayMasterClaim, dominantClaim, draftOf, relationClaim } from '../support/claimGraphFixture.js';
import {
  M,
  PLAN_KNOWN,
  PLAN_UNKNOWN,
  T,
  chapter,
  claimIds,
  graphFor,
  planClaims,
  planContextFor,
  planWith,
  pressureClaim,
  resourceClaim,
  validPlanDraft,
} from '../support/metaNarrativePlanFixture.js';
import { knownTimeModel } from '../support/narrativeFixture.js';
import { ALTERNATE_TEN_GOD_ROW } from '../support/natalFixture.js';

const baseline = (): MetaNarrativePlan => buildMetaNarrativePlan(validPlanDraft(), PLAN_KNOWN);
/**
 * Every build re-proves the graph and PD-5 for each central claim (~0.2 s). A
 * test that builds many plans gets an explicit budget, so a slow machine fails
 * loudly on time instead of reporting a half-run test.
 */
const MANY_BUILDS = 60_000;
vi.setConfig({ testTimeout: MANY_BUILDS });
const C = claimIds();

function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectPlanRefusal(code: MetaNarrativePlanErrorCode, run: () => unknown): void {
  const caught = refusalOf(run);
  expect(caught, `expected the plan to be refused with ${code}`).toBeInstanceOf(MetaNarrativePlanError);
  expect((caught as MetaNarrativePlanError).code, (caught as MetaNarrativePlanError).message).toBe(code);
}

function collectNumbers(value: unknown, path: string, found: string[]): void {
  if (typeof value === 'number' || typeof value === 'bigint') {
    found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => { collectNumbers(entry, `${path}[${String(index)}]`, found); });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectNumbers(entry, `${path}.${key}`, found);
    }
  }
}

function collectKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => { collectKeys(entry, found); });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      collectKeys(entry, found);
    }
  }
}

/** Every string in the plan that names a claim, wherever it sits. */
function claimRefsOf(plan: MetaNarrativePlan): string[] {
  return [
    ...plan.reportThesis.claimRefs,
    ...plan.primaryMotifs.flatMap((motif) => motif.coreClaimRefs),
    ...plan.tensions.flatMap((tension) => tension.claimRefs),
    ...plan.openThreads.flatMap((thread) => thread.claimRefs),
    ...plan.chapterPlan.flatMap((entry) => entry.claimRefs),
    ...plan.coverage.plannedClaimRefs,
    ...plan.coverage.unplannedClaimRefs,
    ...plan.constraints.allowedClaimRefs,
  ];
}

function motifFor(plan: MetaNarrativePlan, coreClaimRefs: readonly string[]): MetaNarrativePlan['primaryMotifs'][number] {
  const want = [...coreClaimRefs].sort().join('|');
  const found = plan.primaryMotifs.find((motif) => motif.coreClaimRefs.join('|') === want);
  if (found === undefined) {
    throw new Error(`fixture: no motif with core ${want}`);
  }
  return found;
}

function driftedRegistry(): MethodRegistry {
  const drifted = structuredClone(BAZI_METHOD_REGISTRY_V1) as unknown as { methods: { methodId: string; operations: string[] }[] };
  const tenGods = drifted.methods.find((method) => method.methodId === 'ten_gods');
  if (tenGods === undefined) {
    throw new Error('fixture: the registry has no ten_gods method');
  }
  tenGods.operations.push('RANK_BY_IMPORTANCE');
  return drifted as unknown as MethodRegistry;
}

describe('ETBZ-30B P1: a valid plan is versioned and bound to its brief, its graph and the released profile', () => {
  it('carries exactly the contract fields and nothing else', () => {
    const plan = baseline();
    expect(Object.keys(plan).sort()).toEqual([
      'chapterPlan',
      'claimGraphStructuralHash',
      'constraints',
      'coverage',
      'methodProfileRef',
      'methodProfileVersion',
      'methodRegistryStructuralHash',
      'openThreads',
      'planVersion',
      'primaryMotifs',
      'reportThesis',
      'sourceBriefStructuralHash',
      'structuralHash',
      'tensions',
      'terminologyLexicon',
    ]);
    expect(Object.keys(plan.reportThesis)).toEqual(['claimRefs']);
    for (const motif of plan.primaryMotifs) {
      expect(Object.keys(motif).sort()).toEqual(['coreClaimRefs', 'finalState', 'lifecycle', 'motifId']);
    }
    for (const tension of plan.tensions) {
      expect(Object.keys(tension).sort()).toEqual(['claimRefs', 'tensionId']);
    }
    for (const thread of plan.openThreads) {
      expect(Object.keys(thread).sort()).toEqual(['claimRefs', 'resolution', 'threadId']);
    }
    for (const entry of plan.chapterPlan) {
      expect(Object.keys(entry).sort()).toEqual(['chapterId', 'claimRefs', 'closesThreadRefs', 'motifTransitions', 'narrativeOperation', 'opensThreadRefs']);
    }
    expect(Object.keys(plan.coverage).sort()).toEqual([
      'citedFactRefs', 'plannedClaimRefs', 'touchedThemeRefs', 'uncitedFactRefs', 'unplannedClaimRefs', 'untouchedThemeRefs',
    ]);
  });

  it('declares its version and binds the exact brief, the exact accepted graph and the released profile', () => {
    const plan = baseline();
    expect(plan.planVersion).toBe(META_NARRATIVE_PLAN_VERSION);
    expect(plan.planVersion).toBe('etbz-30.meta-narrative-plan.v1');
    expect(plan.sourceBriefStructuralHash).toBe(KNOWN.brief.structuralHash);
    expect(plan.sourceBriefStructuralHash).toBe(PLAN_KNOWN.graph.sourceBriefStructuralHash);
    expect(plan.claimGraphStructuralHash).toBe(PLAN_KNOWN.graph.structuralHash);
    expect(plan.methodProfileRef).toBe(METHOD_PROFILE_REF);
    expect(plan.methodProfileVersion).toBe(METHOD_PROFILE_VERSION);
    expect(plan.methodRegistryStructuralHash).toBe(methodRegistryStructuralHash(BAZI_METHOD_REGISTRY_V1));
  });

  it('states the ETBZ-36 lexicon as UNRESOLVED instead of inventing a version or leaving the binding out', () => {
    expect(TERMINOLOGY_LEXICON_BINDING).toEqual({ dependency: 'ETBZ-36', status: 'UNRESOLVED' });
    const plan = baseline();
    expect(plan.terminologyLexicon).toEqual({ dependency: 'ETBZ-36', status: 'UNRESOLVED' });
    // No version, page id or wording rule is carried anywhere in the plan.
    const keys = new Set<string>();
    collectKeys(plan, keys);
    for (const key of ['lexiconVersion', 'lexiconRef', 'lexiconPageId', 'wording', 'label', 'statement', 'text', 'prose']) {
      expect(keys.has(key), key).toBe(false);
    }
  });

  it('references accepted claims of the bound graph only — never a handle, a fact or an invented claim', () => {
    const plan = baseline();
    const accepted = new Set(PLAN_KNOWN.graph.claims.map((claim) => claim.claimId));
    const refs = claimRefsOf(plan);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(accepted.has(ref), ref).toBe(true);
    }
    expect(canonicalJson(plan)).not.toContain('draft.');
    expect(canonicalJson(plan)).not.toContain('"motif.expression"');
    expect(canonicalJson(plan)).not.toContain('"thread.pressure"');
  });

  it('exposes no number anywhere: no salience, weight, rank, score, confidence or importance', () => {
    const found: string[] = [];
    collectNumbers(baseline(), 'plan', found);
    expect(found).toEqual([]);
    const keys = new Set<string>();
    collectKeys(baseline(), keys);
    for (const key of keys) {
      expect(key, key).not.toMatch(/salience|weight|rank|score|confidence|importance|priority|count|personality/iu);
    }
  });

  it('knows exactly the six narrative operations, the six lifecycle states and the two thread resolutions of the contract', () => {
    expect([...NARRATIVE_OPERATIONS]).toEqual(['ESTABLISH', 'REINFORCE', 'QUALIFY', 'CONTRAST', 'CONTEXTUALIZE', 'INTEGRATE']);
    expect([...MOTIF_LIFECYCLE]).toEqual(['UNSEEN', 'SEEDED', 'DEVELOPED', 'COMPLICATED', 'INTEGRATED', 'CLOSED']);
    expect([...THREAD_RESOLUTIONS]).toEqual(['CLOSE', 'LEAVE_OPEN']);
  });
});

describe('ETBZ-30B P2: identity is content-derived, and the plan is a pure function of its choices', () => {
  it('publishes a plan hash anyone can re-derive with plain SHA-256 over the canonical JSON', () => {
    const { structuralHash: published, ...core } = baseline();
    const independent = `sha256:${createHash('sha256').update(canonicalJson(core), 'utf8').digest('hex')}`;
    expect(published).toBe(independent);
  });

  it('is byte-identical for identical input', () => {
    expect(canonicalJson(baseline())).toBe(canonicalJson(baseline()));
  });

  it('derives every motif, tension, thread and chapter id from content, re-derivable from outside', () => {
    const plan = baseline();
    for (const motif of plan.primaryMotifs) {
      expect(motif.motifId).toBe(`motif.${structuralHash({ coreClaimRefs: motif.coreClaimRefs })}`);
    }
    for (const tension of plan.tensions) {
      expect(tension.tensionId).toBe(`tension.${structuralHash({ claimRefs: tension.claimRefs })}`);
    }
    for (const thread of plan.openThreads) {
      expect(thread.threadId).toBe(`thread.${structuralHash({ claimRefs: thread.claimRefs })}`);
    }
    for (const entry of plan.chapterPlan) {
      const { chapterId, ...content } = entry;
      expect(chapterId).toBe(`chapter.${structuralHash(content)}`);
    }
  });

  it('does not let a handle enter identity: renaming every motif and thread handle changes nothing', () => {
    const renamed = planWith((draft) => {
      const rename = (handle: string): string => `renamed/${handle}/by-another-planner`;
      for (const motif of draft.primaryMotifs) motif.motifId = rename(motif.motifId);
      for (const thread of draft.openThreads) {
        thread.threadId = rename(thread.threadId);
      }
      for (const entry of draft.chapterPlan) {
        for (const transition of entry.motifTransitions) transition.motifRef = rename(transition.motifRef);
        entry.opensThreadRefs = entry.opensThreadRefs.map(rename);
        entry.closesThreadRefs = entry.closesThreadRefs.map(rename);
      }
    });
    expect(canonicalJson(buildMetaNarrativePlan(renamed, PLAN_KNOWN))).toBe(canonicalJson(baseline()));
  });

  it('does not let the order of motifs, tensions, threads or any reference list create a difference', () => {
    const shuffled = planWith((draft) => {
      draft.reportThesis.claimRefs.reverse();
      draft.primaryMotifs.reverse();
      for (const motif of draft.primaryMotifs) motif.coreClaimRefs.reverse();
      draft.tensions.reverse();
      for (const tension of draft.tensions) tension.claimRefs.reverse();
      draft.openThreads.reverse();
      for (const thread of draft.openThreads) thread.claimRefs.reverse();
      for (const entry of draft.chapterPlan) {
        entry.claimRefs.reverse();
        entry.motifTransitions.reverse();
        entry.opensThreadRefs.reverse();
        entry.closesThreadRefs.reverse();
      }
    });
    const plan = buildMetaNarrativePlan(shuffled, PLAN_KNOWN);
    expect(plan.structuralHash).toBe(baseline().structuralHash);
    expect(canonicalJson(plan)).toBe(canonicalJson(baseline()));
  });

  it('does not let the order of threads opened in one chapter create a difference', () => {
    const bothIn = (order: readonly string[]): MetaNarrativePlan => buildMetaNarrativePlan(planWith((draft) => {
      // Both threads open in the CONTRAST chapter, which therefore names a claim of each.
      chapter(draft, 2).claimRefs = [C.pressure, C.recurrence, C.resource];
      chapter(draft, 2).opensThreadRefs = [...order];
      chapter(draft, 3).opensThreadRefs = [];
    }), PLAN_KNOWN);
    const forward = bothIn([T.pressure, T.resource]);
    const backward = bothIn([T.resource, T.pressure]);
    expect(backward.structuralHash).toBe(forward.structuralHash);
    const opened = forward.chapterPlan[2]?.opensThreadRefs ?? [];
    expect(opened).toHaveLength(2);
    expect(opened).toEqual([...opened].sort());
  });

  it('does not let the order of threads closed in one chapter create a difference', () => {
    const bothClosedIn = (order: readonly string[]): MetaNarrativePlan => buildMetaNarrativePlan(planWith((draft) => {
      const resource = draft.openThreads.find((candidate) => candidate.threadId === T.resource);
      if (resource === undefined) throw new Error('fixture: no resource thread');
      resource.resolution = 'CLOSE';
      const last = chapter(draft, 6);
      last.claimRefs = [C.pressure, C.recurrence, C.relation, C.resource];
      last.motifTransitions.push({ motifRef: M.resource, toState: 'INTEGRATED' });
      last.closesThreadRefs = [...order];
    }), PLAN_KNOWN);
    const forward = bothClosedIn([T.pressure, T.resource]);
    const backward = bothClosedIn([T.resource, T.pressure]);
    expect(backward.structuralHash).toBe(forward.structuralHash);
    const closedThreads = forward.chapterPlan[6]?.closesThreadRefs ?? [];
    expect(closedThreads).toHaveLength(2);
    expect(closedThreads).toEqual([...closedThreads].sort());
  });

  it('stores one canonical order for every set-like list', () => {
    const plan = baseline();
    const isSorted = (values: readonly string[]): boolean => values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
    expect(isSorted(plan.reportThesis.claimRefs)).toBe(true);
    expect(isSorted(plan.primaryMotifs.map((motif) => motif.motifId))).toBe(true);
    expect(isSorted(plan.tensions.map((tension) => tension.tensionId))).toBe(true);
    expect(isSorted(plan.openThreads.map((thread) => thread.threadId))).toBe(true);
    for (const motif of plan.primaryMotifs) expect(isSorted(motif.coreClaimRefs)).toBe(true);
    for (const tension of plan.tensions) expect(isSorted(tension.claimRefs)).toBe(true);
    for (const thread of plan.openThreads) expect(isSorted(thread.claimRefs)).toBe(true);
    for (const entry of plan.chapterPlan) {
      expect(isSorted(entry.claimRefs)).toBe(true);
      expect(isSorted(entry.motifTransitions.map((transition) => transition.motifRef))).toBe(true);
      expect(isSorted(entry.opensThreadRefs)).toBe(true);
      expect(isSorted(entry.closesThreadRefs)).toBe(true);
    }
    for (const list of Object.values(plan.coverage)) expect(isSorted(list)).toBe(true);
    expect(isSorted(plan.constraints.allowedClaimRefs)).toBe(true);
  });

  it('keeps chapter order as the one order that is meaning: moving a chapter changes the plan, never an id', () => {
    const plan = baseline();
    // Chapter 5 (QUALIFY, no transitions) can move before chapter 4 without breaking the lifecycle.
    const moved = buildMetaNarrativePlan(planWith((draft) => {
      const [fourth, fifth] = draft.chapterPlan.splice(3, 2);
      if (fourth === undefined || fifth === undefined) {
        throw new Error('fixture: the draft lost a chapter');
      }
      draft.chapterPlan.splice(3, 0, fifth, fourth);
    }), PLAN_KNOWN);
    expect(moved.structuralHash).not.toBe(plan.structuralHash);
    expect(new Set(moved.chapterPlan.map((entry) => entry.chapterId))).toEqual(new Set(plan.chapterPlan.map((entry) => entry.chapterId)));
    expect(moved.chapterPlan.map((entry) => entry.narrativeOperation)).toEqual(['ESTABLISH', 'REINFORCE', 'CONTRAST', 'QUALIFY', 'CONTEXTUALIZE', 'CONTRAST', 'INTEGRATE']);
    expect(plan.chapterPlan.map((entry) => entry.narrativeOperation)).toEqual(['ESTABLISH', 'REINFORCE', 'CONTRAST', 'CONTEXTUALIZE', 'QUALIFY', 'CONTRAST', 'INTEGRATE']);
  });

  it('is idempotent on the draft projection of its own output', () => {
    const plan = baseline();
    const again = buildMetaNarrativePlan(metaNarrativePlanDraftOf(plan), PLAN_KNOWN);
    expect(canonicalJson(again)).toBe(canonicalJson(plan));
    expect(() => { assertMetaNarrativePlanIntact(plan, PLAN_KNOWN); }).not.toThrow();
  });

  it('moves the plan hash when a choice changes: thesis, motif core, chapter operation, chapter content', () => {
    const base = baseline().structuralHash;
    const variants = [
      planWith((draft) => { draft.reportThesis.claimRefs.push(C.resource); }),
      planWith((draft) => {
        draft.primaryMotifs[0] = { motifId: M.expression, coreClaimRefs: [C.recurrence] };
        chapter(draft, 1).claimRefs = [C.recurrence, C.relation];
      }),
      planWith((draft) => { chapter(draft, 4).narrativeOperation = 'CONTEXTUALIZE'; }),
      planWith((draft) => { chapter(draft, 4).claimRefs = [C.dayMaster]; }),
    ];
    const seen = new Set([base]);
    for (const variant of variants) {
      const hash = buildMetaNarrativePlan(variant, PLAN_KNOWN).structuralHash;
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    }
    expect(seen.size).toBe(variants.length + 1);
  }, MANY_BUILDS);
});

describe('ETBZ-30B P3: PD-5 is composed for every central claim, and the plan rests on at least three', () => {
  it('positive control: every thesis and motif-core claim of the baseline is one PD-5 accepts (the refusals are negative N2)', () => {
    const plan = baseline();
    const central = new Set([...plan.reportThesis.claimRefs, ...plan.primaryMotifs.flatMap((motif) => motif.coreClaimRefs)]);
    expect([...central].sort()).toEqual([C.pressure, C.recurrence, C.relation, C.resource].sort());
    for (const claimId of central) {
      expect(() => { assertCentralGraphClaim(PLAN_KNOWN.graph, claimId, PLAN_KNOWN); }).not.toThrow();
    }
  });

  it('counts a claim that carries both the thesis and a motif core once: five central slots over exactly three claims meet the floor exactly', () => {
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      draft.reportThesis.claimRefs = [C.recurrence, C.pressure];
      draft.primaryMotifs[0] = { motifId: M.expression, coreClaimRefs: [C.recurrence] };
      chapter(draft, 1).claimRefs = [C.recurrence, C.relation];
    }), PLAN_KNOWN);
    const slots = [...plan.reportThesis.claimRefs, ...plan.primaryMotifs.flatMap((motif) => motif.coreClaimRefs)];
    expect(slots).toHaveLength(5);
    expect(new Set(slots)).toEqual(new Set([C.recurrence, C.pressure, C.resource]));
  });

  it('refuses a single primary motif even on three central claims: the floor is met, the motif count is not (the count refusals are negative N5)', () => {
    expectPlanRefusal('PLAN_MOTIF_COUNT_OUT_OF_RANGE', () => buildMetaNarrativePlan({
      sourceBriefStructuralHash: KNOWN.brief.structuralHash,
      claimGraphStructuralHash: PLAN_KNOWN.graph.structuralHash,
      reportThesis: { claimRefs: [C.recurrence] },
      primaryMotifs: [{ motifId: 'only', coreClaimRefs: [C.recurrence, C.relation, C.pressure] }],
      tensions: [{ claimRefs: [C.pressure, C.recurrence] }],
      openThreads: [],
      chapterPlan: [
        { narrativeOperation: 'ESTABLISH', claimRefs: [C.recurrence, C.relation], motifTransitions: [{ motifRef: 'only', toState: 'SEEDED' }], opensThreadRefs: [], closesThreadRefs: [] },
        { narrativeOperation: 'INTEGRATE', claimRefs: [C.pressure, C.recurrence], motifTransitions: [{ motifRef: 'only', toState: 'CLOSED' }], opensThreadRefs: [], closesThreadRefs: [] },
      ],
    }, PLAN_KNOWN));
  });

  it('keeps TENTATIVE claims tentative: the plan names claims and never touches their epistemic class', () => {
    const plan = buildMetaNarrativePlan(validPlanDraft(PLAN_UNKNOWN), PLAN_UNKNOWN);
    const u = claimIds(PLAN_UNKNOWN.graph);
    const dominant = PLAN_UNKNOWN.graph.claims.find((claim) => claim.claimId === u.dominant);
    expect(dominant?.epistemicClass).toBe('TENTATIVE_INTERPRETATION');
    expect(plan.coverage.plannedClaimRefs).toContain(u.dominant);
    const keys = new Set<string>();
    collectKeys(plan, keys);
    expect(keys.has('epistemicClass')).toBe(false);
    expect(keys.has('provisionalFactRefs')).toBe(false);
  });
});

describe('ETBZ-30B P4: the motif lifecycle is walked along the reading, forward only', () => {
  it('derives each motif lifecycle and final state from the chapter sequence', () => {
    const plan = baseline();
    const chapters = plan.chapterPlan.map((entry) => entry.chapterId);
    const expression = motifFor(plan, [C.recurrence, C.relation]);
    expect(expression.lifecycle).toEqual([
      { chapterId: chapters[0], state: 'SEEDED' },
      { chapterId: chapters[1], state: 'DEVELOPED' },
      { chapterId: chapters[2], state: 'COMPLICATED' },
      { chapterId: chapters[6], state: 'INTEGRATED' },
    ]);
    expect(expression.finalState).toBe('INTEGRATED');
    const pressure = motifFor(plan, [C.pressure]);
    expect(pressure.lifecycle.map((step) => step.state)).toEqual(['SEEDED', 'DEVELOPED', 'INTEGRATED']);
    expect(pressure.finalState).toBe('INTEGRATED');
    const resource = motifFor(plan, [C.resource]);
    expect(resource.lifecycle.map((step) => step.state)).toEqual(['SEEDED', 'DEVELOPED']);
    expect(resource.finalState).toBe('DEVELOPED');
  });

  it('lets a motif skip intermediate states, and close after integrating', () => {
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      chapter(draft, 1).motifTransitions = [];
      chapter(draft, 2).motifTransitions = [{ motifRef: M.pressure, toState: 'SEEDED' }];
      draft.chapterPlan.push({
        narrativeOperation: 'INTEGRATE',
        claimRefs: [C.recurrence, C.resource],
        motifTransitions: [{ motifRef: M.expression, toState: 'CLOSED' }],
        opensThreadRefs: [],
        closesThreadRefs: [],
      });
    }), PLAN_KNOWN);
    expect(motifFor(plan, [C.recurrence, C.relation]).lifecycle.map((step) => step.state)).toEqual(['SEEDED', 'INTEGRATED', 'CLOSED']);
  });

  it('accepts a motif that stays open only because a thread explicitly leaves it open', () => {
    const plan = baseline();
    const resource = motifFor(plan, [C.resource]);
    const leftOpen = plan.openThreads.filter((thread) => thread.resolution === 'LEAVE_OPEN');
    // The thread is central to the resource motif because it names that motif's core claim.
    expect(resource.coreClaimRefs).toEqual([C.resource]);
    expect(leftOpen.flatMap((thread) => thread.claimRefs)).toEqual([C.resource]);
    // Counterfactual: the same plan whose resource thread CLOSES leaves the motif silently dropped.
    expectPlanRefusal('PLAN_MOTIF_SILENTLY_DROPPED', () => buildMetaNarrativePlan(planWith((draft) => {
      const thread = draft.openThreads.find((candidate) => candidate.threadId === T.resource);
      if (thread === undefined) throw new Error('fixture: no resource thread');
      thread.resolution = 'CLOSE';
      chapter(draft, 5).closesThreadRefs = [T.resource];
    }), PLAN_KNOWN));
  });

  it('positive control: the baseline opens its CLOSE thread in one chapter and closes it in one later chapter (the refusals are negative N8)', () => {
    const plan = baseline();
    const pressureThread = plan.openThreads.find((thread) => thread.resolution === 'CLOSE');
    expect(pressureThread).toBeDefined();
    const openers = plan.chapterPlan.flatMap((entry, index) => (entry.opensThreadRefs.includes(pressureThread?.threadId ?? '') ? [index] : []));
    const closers = plan.chapterPlan.flatMap((entry, index) => (entry.closesThreadRefs.includes(pressureThread?.threadId ?? '') ? [index] : []));
    expect(openers).toEqual([2]);
    expect(closers).toEqual([6]);
  });
});

describe('ETBZ-30B P4b: threads are claims kept in view — central when they name a motif core', () => {
  it('accepts a thread that belongs to no primary motif, and it leaves no motif open', () => {
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      draft.openThreads.push({ threadId: 'thread.contrast', claimRefs: [C.dayMaster, C.dominant], resolution: 'LEAVE_OPEN' });
      chapter(draft, 4).opensThreadRefs = ['thread.contrast'];
    }), PLAN_KNOWN);
    expect(plan.openThreads).toHaveLength(3);
    const cores = new Set(plan.primaryMotifs.flatMap((motif) => motif.coreClaimRefs));
    const nonCentral = plan.openThreads.find((thread) => thread.claimRefs.every((claimId) => !cores.has(claimId)));
    expect(nonCentral?.claimRefs).toEqual([C.dayMaster, C.dominant].sort());
    // It is still the resource thread — which names the resource core — that leaves the resource motif open.
    expect(motifFor(plan, [C.resource]).finalState).toBe('DEVELOPED');
  });
});

describe('ETBZ-30B P5: tensions, coverage and constraints are what the graph and the plan state', () => {
  it('positive control: the baseline carries exactly the three CONTRASTS_WITH relations the graph states between its planned claims (the refusals are negative N9)', () => {
    const plan = baseline();
    expect(plan.tensions.map((tension) => tension.claimRefs.join('|')).sort()).toEqual([
      [C.pressure, C.recurrence].sort().join('|'),
      [C.pressure, C.resource].sort().join('|'),
      [C.dayMaster, C.dominant].sort().join('|'),
    ].sort());
  });

  it('accepts a tension whichever of its two claims the graph relation starts from', () => {
    // The fixture graph states dominant -> day master; this one states day master -> dominant.
    const reversed = graphFor(KNOWN, [
      ...planClaims().filter((claim) => claim.claimId !== 'draft.dayMaster' && claim.claimId !== 'draft.dominant'),
      dayMasterClaim({ relations: [{ type: 'QUALIFIES', targetClaimId: 'draft.recurrence' }, { type: 'CONTRASTS_WITH', targetClaimId: 'draft.dominant' }] }),
      dominantClaim({ relations: [] }),
    ]);
    expect(claimIds(reversed)).toEqual(C);
    for (const context of [PLAN_KNOWN, planContextFor(KNOWN, reversed)]) {
      const plan = buildMetaNarrativePlan(validPlanDraft(context), context);
      expect(plan.tensions.map((tension) => tension.claimRefs.join('|'))).toContain([C.dayMaster, C.dominant].sort().join('|'));
    }
    // And each of the plan's two other tensions, too, is the same tension read from either end.
    for (const [left, right] of [[C.pressure, C.recurrence], [C.pressure, C.resource]] as const) {
      expect(buildMetaNarrativePlan(planWith((draft) => {
        draft.tensions = draft.tensions.map((tension) => (tension.claimRefs.includes(left) && tension.claimRefs.includes(right) ? { claimRefs: [right, left] } : tension));
      }), PLAN_KNOWN).structuralHash).toBe(baseline().structuralHash);
    }
  }, MANY_BUILDS);

  it('plans every claim the plan names anywhere — also one named only by a motif core or only by a thread', () => {
    const extra = buildInterpretiveClaimGraph(draftOf([...planClaims(), relationClaim({
      claimId: 'draft.threadOnly',
      statement: 'A reading of the month pillar only a thread keeps in view.',
      relations: [],
    })]), KNOWN);
    const context = planContextFor(KNOWN, extra);
    const c = claimIds(extra);
    const threadOnly = extra.claims.find((claim) => claim.statement.startsWith('A reading of the month pillar only'))?.claimId ?? '';
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      // The relation claim leaves every chapter: it stays only in the expression core.
      chapter(draft, 1).claimRefs = [c.recurrence];
      chapter(draft, 6).claimRefs = [c.pressure, c.recurrence];
      const resource = draft.openThreads.find((candidate) => candidate.threadId === T.resource);
      if (resource === undefined) throw new Error('fixture: no resource thread');
      resource.claimRefs = [c.resource, threadOnly];
    }, context), context);
    const inChapters = new Set(plan.chapterPlan.flatMap((entry) => entry.claimRefs));
    expect(inChapters.has(c.relation)).toBe(false);
    expect(inChapters.has(threadOnly)).toBe(false);
    expect(plan.coverage.plannedClaimRefs).toEqual(expect.arrayContaining([c.relation, threadOnly]));
    expect(plan.constraints.allowedClaimRefs).toEqual(expect.arrayContaining([c.relation, threadOnly]));
    expect(plan.coverage.unplannedClaimRefs).toEqual([]);
  });

  it('plans a claim named only by a declared tension: what the plan names, the rendering may express', () => {
    const plan = buildMetaNarrativePlan(planWith((draft) => {
      // Day master and dominant leave every chapter; their declared tension stays.
      chapter(draft, 0).claimRefs = [C.recurrence];
      chapter(draft, 3).claimRefs = [C.resource];
      draft.chapterPlan.splice(4, 1);
    }), PLAN_KNOWN);
    const inChapters = new Set(plan.chapterPlan.flatMap((entry) => entry.claimRefs));
    expect(inChapters.has(C.dayMaster) || inChapters.has(C.dominant)).toBe(false);
    expect(plan.tensions.map((tension) => tension.claimRefs.join('|'))).toContain([C.dayMaster, C.dominant].sort().join('|'));
    expect(plan.coverage.plannedClaimRefs).toEqual(expect.arrayContaining([C.dayMaster, C.dominant]));
    expect(plan.constraints.allowedClaimRefs).toEqual(expect.arrayContaining([C.dayMaster, C.dominant]));
    expect(plan.coverage.unplannedClaimRefs).toEqual([]);
  });

  it('partitions the graph claims into planned and unplanned, and the constraints allow exactly the planned', () => {
    const extra = buildInterpretiveClaimGraph(draftOf([...planClaims(), relationClaim({
      claimId: 'draft.unplanned',
      statement: 'An accepted reading of the month pillar this plan does not use.',
      relations: [],
    })]), KNOWN);
    const context = planContextFor(KNOWN, extra);
    const plan = buildMetaNarrativePlan(validPlanDraft(context), context);
    const all = extra.claims.map((claim) => claim.claimId).sort();
    expect([...plan.coverage.plannedClaimRefs, ...plan.coverage.unplannedClaimRefs].sort()).toEqual(all);
    expect(plan.coverage.unplannedClaimRefs).toHaveLength(1);
    expect(plan.constraints.allowedClaimRefs).toEqual(plan.coverage.plannedClaimRefs);
    expect(plan.constraints.allowedClaimRefs).not.toContain(plan.coverage.unplannedClaimRefs[0]);
    expect(plan.constraints).toEqual({
      allowedClaimRefs: plan.coverage.plannedClaimRefs,
      newClaimsForbidden: true,
      newChartFactsForbidden: true,
      newClaimRelationsForbidden: true,
      epistemicClassesFixed: true,
    });
  });

  it('derives fact coverage from the planned claims and partitions exactly the interpretable facts of the brief', () => {
    for (const context of [PLAN_KNOWN, PLAN_UNKNOWN]) {
      const plan = buildMetaNarrativePlan(validPlanDraft(context), context);
      const planned = new Set(plan.coverage.plannedClaimRefs);
      const cited = new Set(context.graph.claims.filter((claim) => planned.has(claim.claimId)).flatMap((claim) => claim.factRefs));
      expect(plan.coverage.citedFactRefs).toEqual([...cited].sort());
      const interpretable = context.brief.facts.filter((fact) => fact.interpretable).map((fact) => fact.id);
      expect([...plan.coverage.citedFactRefs, ...plan.coverage.uncitedFactRefs].sort()).toEqual([...interpretable].sort());
      // An excluded (assumed-time) fact is never offered as "uncovered": it is not coverable at all.
      const excluded = context.brief.facts.filter((fact) => !fact.interpretable).map((fact) => fact.id);
      for (const factId of excluded) {
        expect(plan.coverage.uncitedFactRefs, factId).not.toContain(factId);
      }
      expect(excluded.length > 0).toBe(context === PLAN_UNKNOWN);
    }
  });

  it('derives theme coverage from theme membership of the cited facts, over all themes of the brief', () => {
    const plan = baseline();
    const cited = new Set(plan.coverage.citedFactRefs);
    const themes = [...KNOWN.brief.primaryThemes, ...KNOWN.brief.candidateThemes];
    const touched = themes.filter((theme) => theme.factIds.some((factId) => cited.has(factId))).map((theme) => theme.id).sort();
    expect(plan.coverage.touchedThemeRefs).toEqual(touched);
    expect([...plan.coverage.touchedThemeRefs, ...plan.coverage.untouchedThemeRefs].sort()).toEqual(themes.map((theme) => theme.id).sort());
    expect(plan.coverage.touchedThemeRefs).toContain('theme.tenGod.SevenKilling');
    expect(plan.coverage.untouchedThemeRefs).toContain('theme.tenGod.DirectWealth');
  });
});

describe('ETBZ-30B P6: the accepted plan is plain data that survives serialisation and rebuild', () => {
  it('round-trips through JSON unchanged and stays intact', () => {
    const plan = baseline();
    const copy = JSON.parse(JSON.stringify(plan)) as MetaNarrativePlan;
    expect(copy).toEqual(plan);
    expect(canonicalJson(copy)).toBe(canonicalJson(plan));
    expect(() => { assertMetaNarrativePlanIntact(copy, PLAN_KNOWN); }).not.toThrow();
  });

  it('carries no provider, model, run, route, clock or candidate state', () => {
    const keys = new Set<string>();
    collectKeys(baseline(), keys);
    for (const key of keys) {
      expect(key, key).not.toMatch(/provider|model|run|route|timestamp|generated|candidate|sha1|prompt|policy/iu);
    }
  });

  it('keeps tensions, threads, chapters, lifecycle and coverage through a rebuild from its own draft projection', () => {
    const plan = baseline();
    const rebuilt = buildMetaNarrativePlan(JSON.parse(JSON.stringify(metaNarrativePlanDraftOf(plan))) as unknown, PLAN_KNOWN);
    expect(rebuilt.tensions).toEqual(plan.tensions);
    expect(rebuilt.openThreads).toEqual(plan.openThreads);
    expect(rebuilt.chapterPlan).toEqual(plan.chapterPlan);
    expect(rebuilt.primaryMotifs).toEqual(plan.primaryMotifs);
    expect(rebuilt.coverage).toEqual(plan.coverage);
    expect(rebuilt.structuralHash).toBe(plan.structuralHash);
  });

  it('refuses a plan that is not exactly what its own choices produce for this graph', () => {
    const plan = baseline();
    const [firstMotif] = plan.primaryMotifs;
    const [firstChapter] = plan.chapterPlan;
    if (firstMotif === undefined || firstChapter === undefined) {
      throw new Error('fixture: the baseline plan is empty');
    }
    const forgeries: [string, unknown][] = [
      ['an edited plan hash', { ...plan, structuralHash: `${plan.structuralHash}0` }],
      ['a thesis claim swapped for a claim below the PD-5 floor', { ...plan, reportThesis: { claimRefs: [C.dayMaster, C.pressure].sort() } }],
      ['a thesis claim added', { ...plan, reportThesis: { claimRefs: [...plan.reportThesis.claimRefs, C.resource].sort() } }],
      ['a motif core edited', { ...plan, primaryMotifs: [{ ...firstMotif, coreClaimRefs: [C.relation] }, ...plan.primaryMotifs.slice(1)] }],
      ['a rewritten lifecycle', { ...plan, primaryMotifs: [{ ...firstMotif, finalState: 'CLOSED' }, ...plan.primaryMotifs.slice(1)] }],
      ['a lifecycle step dropped', { ...plan, primaryMotifs: [{ ...firstMotif, lifecycle: firstMotif.lifecycle.slice(1) }, ...plan.primaryMotifs.slice(1)] }],
      ['a tension removed', { ...plan, tensions: plan.tensions.slice(1) }],
      ['a chapter operation edited', { ...plan, chapterPlan: [{ ...firstChapter, narrativeOperation: 'INTEGRATE' }, ...plan.chapterPlan.slice(1)] }],
      ['chapters reordered', { ...plan, chapterPlan: [...plan.chapterPlan].reverse() }],
      ['coverage edited', { ...plan, coverage: { ...plan.coverage, unplannedClaimRefs: [C.dayMaster] } }],
      ['a constraint widened', { ...plan, constraints: { ...plan.constraints, allowedClaimRefs: [] } }],
      ['a constraint switched off', { ...plan, constraints: { ...plan.constraints, newClaimsForbidden: false } }],
      ['the lexicon marked bound', { ...plan, terminologyLexicon: { dependency: 'ETBZ-36', status: 'BOUND' } }],
      ['a lexicon version invented', { ...plan, terminologyLexicon: { ...plan.terminologyLexicon, lexiconRef: 'terminology-lexicon@1.0.0' } }],
      ['a salience smuggled onto a motif', { ...plan, primaryMotifs: [{ ...firstMotif, salience: 0.9 }, ...plan.primaryMotifs.slice(1)] }],
      ['a rank smuggled onto the plan', { ...plan, rank: 1 }],
      ['a profile ref edited', { ...plan, methodProfileRef: 'bazi-method-profile@0.9.0' }],
      ['its graph binding edited', { ...plan, claimGraphStructuralHash: 'sha256:0' }],
      ['its brief binding edited', { ...plan, sourceBriefStructuralHash: 'sha256:0' }],
      ['a value that cannot be canonicalised', { ...plan, weight: 10n }],
      ['motifs out of canonical order', { ...plan, primaryMotifs: [...plan.primaryMotifs].reverse() }],
      ['no chapters at all', { ...plan, chapterPlan: null }],
      ['not a plan', null],
    ];
    for (const [what, forged] of forgeries) {
      const caught = refusalOf(() => { assertMetaNarrativePlanIntact(forged as MetaNarrativePlan, PLAN_KNOWN); });
      expect(caught, what).toBeInstanceOf(MetaNarrativePlanError);
      expect((caught as MetaNarrativePlanError).code, `${what}: ${(caught as Error).message}`).toBe('PLAN_NOT_INTACT');
    }
  }, MANY_BUILDS);
});

describe('ETBZ-30B P7: the plan depends on the brief and the graph it is bound to', () => {
  const hourChanged = contextFor(knownTimeModel({ natal: { pillars: { hour: { tenGod: ALTERNATE_TEN_GOD_ROW } } } }));

  it('invalidates a plan when the brief identity changes: another chart, even with the same claims, is another plan', () => {
    const otherGraph = graphFor(hourChanged);
    const other = planContextFor(hourChanged, otherGraph);
    if (other.brief.structuralHash === KNOWN.brief.structuralHash) {
      // Guard the counterfactual itself: it must really be another chart.
      throw new Error('fixture: the changed hour pillar did not change the brief');
    }
    // A plan drafted for the known chart is refused against the other chart and its graph...
    expectPlanRefusal('PLAN_BRIEF_HASH_MISMATCH', () => buildMetaNarrativePlan(validPlanDraft(), other));
    // ...and an accepted plan of the known chart is no plan of the other chart (as a graph of
    // another chart is not intact, ADR 0007), with the cause named.
    expectPlanRefusal('PLAN_NOT_INTACT', () => { assertMetaNarrativePlanIntact(baseline(), other); });
    expect((refusalOf(() => { assertMetaNarrativePlanIntact(baseline(), other); }) as Error).message).toContain('different brief');
  });

  it('invalidates a plan when the graph identity changes, even when every claim it names survives', () => {
    // Same claims, one relation more: an intact, different graph.
    const moved = graphFor(KNOWN, [...planClaims().slice(0, 5), resourceClaim({ relations: [{ type: 'DEVELOPS', targetClaimId: 'draft.relation' }] })]);
    expect(moved.structuralHash).not.toBe(PLAN_KNOWN.graph.structuralHash);
    expect(moved.claims.map((claim) => claim.claimId)).toEqual(PLAN_KNOWN.graph.claims.map((claim) => claim.claimId));
    const context = planContextFor(KNOWN, moved);
    expectPlanRefusal('PLAN_CLAIM_GRAPH_HASH_MISMATCH', () => buildMetaNarrativePlan(validPlanDraft(), context));
    expectPlanRefusal('PLAN_NOT_INTACT', () => { assertMetaNarrativePlanIntact(baseline(), context); });
    expect((refusalOf(() => { assertMetaNarrativePlanIntact(baseline(), context); }) as Error).message).toContain('different claim graph');
    // The plan re-drafted for the new graph is accepted, and is another plan.
    const redrafted = buildMetaNarrativePlan(validPlanDraft(context), context);
    expect(redrafted.claimGraphStructuralHash).toBe(moved.structuralHash);
    expect(redrafted.structuralHash).not.toBe(baseline().structuralHash);
  });

  it('refuses a context graph that is not intact, as the graph refusal it is', () => {
    const graph = PLAN_KNOWN.graph;
    const [first] = graph.claims;
    if (first === undefined) throw new Error('fixture: empty graph');
    const tampered: InterpretiveClaimGraph = { ...graph, claims: [{ ...first, statement: `${first.statement} Edited.` }, ...graph.claims.slice(1)] };
    for (const run of [
      () => buildMetaNarrativePlan(validPlanDraft(), { ...PLAN_KNOWN, graph: tampered }),
      () => { assertMetaNarrativePlanIntact(baseline(), { ...PLAN_KNOWN, graph: tampered }); },
    ]) {
      const caught = refusalOf(run);
      expect(caught).toBeInstanceOf(ClaimGraphError);
      expect((caught as ClaimGraphError).code).toBe('CLAIM_GRAPH_NOT_INTACT');
    }
  });

  it('does not re-label a wrong context as a damaged plan: an unreleased registry and a foreign brief surface as what they are', () => {
    const drifted = refusalOf(() => { assertMetaNarrativePlanIntact(baseline(), { ...PLAN_KNOWN, registry: driftedRegistry() }); });
    expect(drifted).toBeInstanceOf(MethodRegistryError);
    expect((drifted as MethodRegistryError).code).toBe('REGISTRY_NOT_RELEASED');
    const foreign = refusalOf(() => { assertMetaNarrativePlanIntact(baseline(), { ...PLAN_KNOWN, brief: hourChanged.brief }); });
    expect(foreign).toBeInstanceOf(ClaimGraphError);
    expect((foreign as ClaimGraphError).code).toBe('CLAIM_GRAPH_BRIEF_NOT_DERIVED_FROM_MODEL');
  });

  it('refuses a plan whose central claim dropped below PD-5 in a re-drafted graph — the floor is re-proven, never remembered', () => {
    // The pressure claim re-submitted with one method: still valid, no longer central.
    const weakened = graphFor(KNOWN, [...planClaims().slice(0, 4), pressureClaim({ methodRefs: ['ten_gods', 'fact_relations'], factRefs: ['chart.natal.pillar.month.hiddenStem.0.tenGod', 'chart.natal.pillar.year.hiddenStem.0.tenGod'] }), resourceClaim()]);
    const context: MetaNarrativePlanContext = planContextFor(KNOWN, weakened);
    expect(claimIds(weakened).pressure).not.toBe(C.pressure);
    const caught = refusalOf(() => buildMetaNarrativePlan(validPlanDraft(context), context));
    expect(caught).toBeInstanceOf(ClaimError);
    expect((caught as ClaimError).code).toBe('CLAIM_INSUFFICIENT_SIGNALS');
  });

  it('depends on nothing but the chart, the graph and the choices: the same inputs in a fresh context give the same plan', () => {
    const fresh = planContextFor(contextFor(knownTimeModel()));
    expect(fresh.graph.structuralHash).toBe(PLAN_KNOWN.graph.structuralHash);
    expect(claimIds(fresh.graph)).toEqual(C);
    expect(canonicalJson(buildMetaNarrativePlan(validPlanDraft(fresh), fresh))).toBe(canonicalJson(baseline()));
  });
});
