/**
 * ETBZ-30B — MetaNarrativePlan: WHICH accepted meanings a long-form reading must
 * develop, in which order and against which counter-meaning — decided before
 * any prose exists, and bound to exactly one accepted InterpretiveClaimGraph.
 *
 *     NarrativeBrief + InterpretiveClaimGraph + plan draft
 *       -> validation -> normalisation -> MetaNarrativePlan
 *
 * Like the claim graph, this module is an acceptance boundary. It writes no
 * prose, calls no provider, derives no chart fact, knows no astrology and
 * decides no importance. A drafter proposes the thesis, the primary motifs, the
 * tensions, the threads and the chapter sequence; the plan accepts only what
 * the bound graph and the released Method Profile carry, and refuses the rest.
 *
 * What the plan adds to the graph, and nothing more:
 *
 *   - the binding to the exact brief and the exact accepted graph (and, through
 *     the graph, the released method profile). A plan whose brief or graph has
 *     changed is refused, never re-targeted;
 *   - which accepted claims carry the report thesis and the core of each
 *     primary motif. Every such claim passes PD-5 through
 *     `assertCentralGraphClaim` — composed, not re-implemented — and the plan
 *     rests on at least three distinct central claims (Method Profile v1.0.0,
 *     section 11: a floor, no maximum, and no padding). There are three to
 *     five primary motifs (Long-Form contract, section 8), and an accepted
 *     claim is the core of at most one of them: recombining the same claims
 *     does not make more motifs, and a chart that does not carry three is
 *     refused, never padded;
 *   - tensions the graph already states: a tension names two accepted claims
 *     the graph relates by `CONTRASTS_WITH`. The plan never creates a relation,
 *     and it may not flatten one either: a contrast between two claims the
 *     plan uses must be declared;
 *   - the chapter sequence, each chapter with one narrative operation of the
 *     Long-Form contract (section 7), and the canonical motif lifecycle walked
 *     along it: forward only, skipping allowed, no primary motif silently
 *     forgotten. A chapter moves a motif, opens or closes a thread only where
 *     it names one of that element's claims — bookkeeping without meaning is
 *     not development;
 *   - open threads, each opened by one chapter and either closed by a later
 *     one or explicitly left open. A thread is a set of accepted claims; it is
 *     central when it names a core claim of a primary motif, and only such a
 *     thread, left open, leaves that motif explicitly open;
 *   - a coverage statement over claims, facts and themes, and the constraints
 *     whoever renders the plan is held to.
 *
 * Order. `chapterPlan` is the reading order: the one order in a plan that is
 * meaning. Every other list is sorted, and every plan element gets a
 * content-derived identity, so neither the order in which a drafter listed
 * motifs, tensions, threads or references nor the handles it chose can become
 * priority. Duplicates are refused, never merged: saying a thing twice does not
 * make it weigh more.
 *
 * Nothing here is a number: no salience, weight, rank, score, confidence or
 * importance — a draft that carries one is refused, not trimmed.
 *
 * Fail-closed: the first violation throws, and no partial plan exists.
 */
import { z } from 'zod';
import { structuralHash } from '../../domain/structural-hash.js';
import {
  assertCentralGraphClaim,
  assertInterpretiveClaimGraphIntact,
} from './interpretive-claim-graph.js';
import type {
  AcceptedInterpretiveClaim,
  ClaimGraphContext,
  InterpretiveClaimGraph,
} from './interpretive-claim-graph.js';
import { ClaimError } from './interpretive-claim.js';

export const META_NARRATIVE_PLAN_VERSION = 'etbz-30.meta-narrative-plan.v1' as const;

/** The six narrative operators of the Long-Form contract, section 7. One per chapter. */
export const NARRATIVE_OPERATIONS = ['ESTABLISH', 'REINFORCE', 'QUALIFY', 'CONTRAST', 'CONTEXTUALIZE', 'INTEGRATE'] as const;
export type NarrativeOperation = (typeof NARRATIVE_OPERATIONS)[number];

/** The canonical motif lifecycle, in order. `UNSEEN` is where every motif starts. */
export const MOTIF_LIFECYCLE = ['UNSEEN', 'SEEDED', 'DEVELOPED', 'COMPLICATED', 'INTEGRATED', 'CLOSED'] as const;
export type MotifState = (typeof MOTIF_LIFECYCLE)[number];

/** How a thread ends: closed by a later chapter, or deliberately left open. */
export const THREAD_RESOLUTIONS = ['CLOSE', 'LEAVE_OPEN'] as const;
export type ThreadResolution = (typeof THREAD_RESOLUTIONS)[number];

/**
 * The customer-wording contract the plan will be rendered under.
 *
 * `Terminology & Wording Lexicon v1` (Jira ETBZ-36) is not released: no page,
 * no version, no identity exists to bind. The plan therefore says so, as data,
 * instead of carrying an invented reference or nothing at all. ETBZ-30B may be
 * implemented in this state; final ETBZ-30B merge authorisation and ETBZ-30
 * closeout require the versioned lexicon binding (Jira ETBZ-30, DRS). Binding
 * it changes this contract and every plan hash — a versioned change of the
 * plan contract, never an edit of an accepted plan.
 */
export const TERMINOLOGY_LEXICON_BINDING = { dependency: 'ETBZ-36', status: 'UNRESOLVED' } as const;

export interface PlanReportThesis {
  /** The accepted claims the thesis is an interpretation OF. Each passes PD-5. */
  readonly claimRefs: readonly string[];
}

export interface PlanMotifStep {
  readonly chapterId: string;
  readonly state: MotifState;
}

export interface PlanPrimaryMotif {
  /** `motif.<hash of its core>` — derived, never the drafter's handle. */
  readonly motifId: string;
  /** The accepted claims the motif rests on. Each passes PD-5. */
  readonly coreClaimRefs: readonly string[];
  /** Every state the motif enters, in chapter order. Derived from `chapterPlan`. */
  readonly lifecycle: readonly PlanMotifStep[];
  readonly finalState: MotifState;
}

export interface PlanTension {
  readonly tensionId: string;
  /** Two accepted claims the graph relates by `CONTRASTS_WITH`, sorted. */
  readonly claimRefs: readonly string[];
}

export interface PlanOpenThread {
  /** `thread.<hash of its claims>` — the fate is not identity. */
  readonly threadId: string;
  /** The accepted claims the thread keeps in view. Naming a motif-core claim makes it central to that motif. */
  readonly claimRefs: readonly string[];
  readonly resolution: ThreadResolution;
}

export interface PlanMotifTransition {
  readonly motifRef: string;
  readonly toState: MotifState;
}

export interface PlanChapter {
  /** `chapter.<hash of its content>`. Its position in `chapterPlan` is its place in the reading. */
  readonly chapterId: string;
  readonly narrativeOperation: NarrativeOperation;
  readonly claimRefs: readonly string[];
  readonly motifTransitions: readonly PlanMotifTransition[];
  readonly opensThreadRefs: readonly string[];
  readonly closesThreadRefs: readonly string[];
}

/** What the plan touches. Derived, never drafted; every list is sorted. */
export interface PlanCoverage {
  /** Every accepted claim the plan references anywhere. */
  readonly plannedClaimRefs: readonly string[];
  /** Accepted claims of the graph the plan does not use. */
  readonly unplannedClaimRefs: readonly string[];
  /** The facts the planned claims cite. */
  readonly citedFactRefs: readonly string[];
  /** Interpretable facts of the brief no planned claim cites. Excluded facts are never coverable. */
  readonly uncitedFactRefs: readonly string[];
  /** Brief themes (primary and candidate) that group at least one cited fact. */
  readonly touchedThemeRefs: readonly string[];
  readonly untouchedThemeRefs: readonly string[];
}

/** The obligations whoever renders the plan is held to. Stated, so nobody has to guess them. */
export interface PlanConstraints {
  /** The only accepted claims a rendering may express: exactly the planned ones. */
  readonly allowedClaimRefs: readonly string[];
  /** No interpretation that is not an accepted, planned claim. */
  readonly newClaimsForbidden: true;
  /** No chart fact beyond the brief's, no method beyond the released profile's. */
  readonly newChartFactsForbidden: true;
  /** No relation between claims that the accepted graph does not state. */
  readonly newClaimRelationsForbidden: true;
  /** A claim is rendered with its own epistemic class: uncertainty never disappears. */
  readonly epistemicClassesFixed: true;
}

export interface MetaNarrativePlan {
  readonly planVersion: typeof META_NARRATIVE_PLAN_VERSION;
  /** `structuralHash` of the exact NarrativeBrief — also the graph's. */
  readonly sourceBriefStructuralHash: string;
  /** `structuralHash` of the exact accepted InterpretiveClaimGraph. */
  readonly claimGraphStructuralHash: string;
  readonly methodProfileRef: string;
  readonly methodProfileVersion: string;
  readonly methodRegistryStructuralHash: string;
  readonly terminologyLexicon: typeof TERMINOLOGY_LEXICON_BINDING;
  readonly reportThesis: PlanReportThesis;
  /** Sorted by `motifId`. */
  readonly primaryMotifs: readonly PlanPrimaryMotif[];
  /** Sorted by `tensionId`. */
  readonly tensions: readonly PlanTension[];
  /** Sorted by `threadId`. */
  readonly openThreads: readonly PlanOpenThread[];
  /** In reading order. */
  readonly chapterPlan: readonly PlanChapter[];
  readonly coverage: PlanCoverage;
  readonly constraints: PlanConstraints;
  readonly structuralHash: string;
}

/** What a drafter hands in. Untrusted; see `planDraftSchema`. Handles are local to the draft. */
export interface MetaNarrativePlanDraft {
  /** The brief the plan was written for. Compared, never trusted. */
  readonly sourceBriefStructuralHash: string;
  /** The accepted graph the plan was written for. Compared, never trusted. */
  readonly claimGraphStructuralHash: string;
  readonly reportThesis: Readonly<{ claimRefs: readonly string[] }>;
  readonly primaryMotifs: readonly Readonly<{ motifId: string; coreClaimRefs: readonly string[] }>[];
  readonly tensions: readonly Readonly<{ claimRefs: readonly string[] }>[];
  readonly openThreads: readonly Readonly<{
    threadId: string;
    claimRefs: readonly string[];
    resolution: ThreadResolution;
  }>[];
  readonly chapterPlan: readonly Readonly<{
    narrativeOperation: NarrativeOperation;
    claimRefs: readonly string[];
    motifTransitions: readonly Readonly<{ motifRef: string; toState: MotifState }>[];
    opensThreadRefs: readonly string[];
    closesThreadRefs: readonly string[];
  }>[];
}

export interface MetaNarrativePlanContext extends ClaimGraphContext {
  /** Verified intact for `model`, `brief` and `registry`, never trusted. */
  readonly graph: InterpretiveClaimGraph;
}

export type MetaNarrativePlanErrorCode =
  | 'PLAN_SCHEMA_INVALID'
  | 'PLAN_BRIEF_HASH_MISMATCH'
  | 'PLAN_CLAIM_GRAPH_HASH_MISMATCH'
  | 'PLAN_UNGROUNDED'
  | 'PLAN_UNKNOWN_CLAIM'
  | 'PLAN_DANGLING_REFERENCE'
  | 'PLAN_DUPLICATE_HANDLE'
  | 'PLAN_DUPLICATE_REF'
  | 'PLAN_DUPLICATE_CONTENT'
  | 'PLAN_MOTIF_COUNT_OUT_OF_RANGE'
  | 'PLAN_MOTIF_CORES_OVERLAP'
  | 'PLAN_INSUFFICIENT_CENTRAL_CLAIMS'
  | 'PLAN_TENSION_NOT_IN_GRAPH'
  | 'PLAN_TENSION_UNDECLARED'
  | 'PLAN_ILLEGAL_MOTIF_TRANSITION'
  | 'PLAN_MOVEMENT_UNGROUNDED'
  | 'PLAN_MOTIF_SILENTLY_DROPPED'
  | 'PLAN_THREAD_LIFECYCLE_INVALID'
  | 'PLAN_NOT_INTACT';

export class MetaNarrativePlanError extends Error {
  readonly code: MetaNarrativePlanErrorCode;
  constructor(code: MetaNarrativePlanErrorCode, message: string) {
    super(message);
    this.name = 'MetaNarrativePlanError';
    this.code = code;
  }
}

/** Long-Form contract, section 8: "three to five primaryMotifs where the chart supports them" (PO decision, ADR 0008). */
const MIN_PRIMARY_MOTIFS = 3;
const MAX_PRIMARY_MOTIFS = 5;
/** Method Profile v1.0.0, section 11: fewer than three central claims stops the reading. */
const MIN_CENTRAL_CLAIMS = 3;

/** Bounded for the same reason as in the claim graph: refusals name the offending id. */
const idLike = z.string().min(1).max(256);

/**
 * The closed SHAPE of a draft. `strictObject` throughout: a field this contract
 * does not name — a salience, a weight, a label, a fact, a statement, a
 * provider or run id, a lexicon — is a refusal, not something dropped quietly.
 */
const planDraftSchema = z.strictObject({
  sourceBriefStructuralHash: idLike,
  claimGraphStructuralHash: idLike,
  reportThesis: z.strictObject({ claimRefs: z.array(idLike) }),
  primaryMotifs: z.array(z.strictObject({ motifId: idLike, coreClaimRefs: z.array(idLike) })),
  tensions: z.array(z.strictObject({ claimRefs: z.array(idLike).length(2) })),
  openThreads: z.array(z.strictObject({
    threadId: idLike,
    claimRefs: z.array(idLike),
    resolution: z.enum(THREAD_RESOLUTIONS),
  })),
  chapterPlan: z.array(z.strictObject({
    narrativeOperation: z.enum(NARRATIVE_OPERATIONS),
    claimRefs: z.array(idLike),
    motifTransitions: z.array(z.strictObject({ motifRef: idLike, toState: z.enum(MOTIF_LIFECYCLE) })),
    opensThreadRefs: z.array(idLike),
    closesThreadRefs: z.array(idLike),
  })),
});

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function byKey<T>(key: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

function refuseRepeated(where: string, what: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new MetaNarrativePlanError(
        'PLAN_DUPLICATE_REF',
        `${where} names ${what} "${value}" more than once; saying a thing twice does not make it weigh more`,
      );
    }
    seen.add(value);
  }
}

/**
 * Maps a drafter's handle to the accepted id of the element it names. A handle
 * used twice would make every reference to it ambiguous.
 */
function handleIndex(what: string, handles: readonly string[], acceptedIds: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  handles.forEach((handle, position) => {
    if (index.has(handle)) {
      throw new MetaNarrativePlanError('PLAN_DUPLICATE_HANDLE', `two ${what}s share the handle "${handle}"; a reference to it would be ambiguous`);
    }
    index.set(handle, acceptedIds[position] ?? '');
  });
  return index;
}

/** Refuses the second element whose content-derived id is already taken. */
function refuseDuplicateContent(what: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new MetaNarrativePlanError('PLAN_DUPLICATE_CONTENT', `two ${what}s have the same content; submitting it twice does not make it two`);
    }
    seen.add(id);
  }
}

/** A tension is its two claims, whichever of them the graph's relation starts from. */
function tensionIdOf(pair: readonly string[]): string {
  return `tension.${structuralHash({ claimRefs: sorted(pair) })}`;
}

function resolveHandle(index: ReadonlyMap<string, string>, where: string, what: string, handle: string): string {
  const accepted = index.get(handle);
  if (accepted === undefined) {
    throw new MetaNarrativePlanError('PLAN_DANGLING_REFERENCE', `${where} names ${what} "${handle}", which this plan does not declare`);
  }
  return accepted;
}

/**
 * Validates a draft against the accepted graph it claims to plan and assembles
 * the plan. Refuses with `MetaNarrativePlanError`; a central claim below the
 * PD-5 floor with the claim contract's own `ClaimError`; a context that is not
 * an intact graph of this chart, brief and released registry with the graph's
 * or the registry's own error — unchanged. Nothing partial is returned.
 */
export function buildMetaNarrativePlan(draft: unknown, context: MetaNarrativePlanContext): MetaNarrativePlan {
  // The graph is RE-PROVEN for this chart, brief and released registry: the
  // plan can never be more trustworthy than the graph it is built on.
  const { graph } = context;
  assertInterpretiveClaimGraphIntact(graph, context);

  const parsed = planDraftSchema.safeParse(draft);
  if (!parsed.success) {
    // Path + code only: the value is the part most likely to be untrusted bulk.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.code}`)
      .join('; ');
    throw new MetaNarrativePlanError('PLAN_SCHEMA_INVALID', `the plan draft does not satisfy the draft schema (${issues})`);
  }
  const plan = parsed.data;

  if (plan.sourceBriefStructuralHash !== context.brief.structuralHash) {
    throw new MetaNarrativePlanError('PLAN_BRIEF_HASH_MISMATCH', 'the plan was drafted for a different brief than the one it is being accepted against');
  }
  if (plan.claimGraphStructuralHash !== graph.structuralHash) {
    throw new MetaNarrativePlanError('PLAN_CLAIM_GRAPH_HASH_MISMATCH', 'the plan was drafted for a different claim graph than the one it is being accepted against');
  }

  const claimsById = new Map<string, AcceptedInterpretiveClaim>(graph.claims.map((claim) => [claim.claimId, claim]));
  /** A non-empty, repeat-free list of ACCEPTED claims of the bound graph, sorted. */
  const claimRefs = (where: string, refs: readonly string[]): string[] => {
    if (refs.length === 0) {
      throw new MetaNarrativePlanError('PLAN_UNGROUNDED', `${where} names no accepted claim; the plan carries no meaning of its own`);
    }
    refuseRepeated(where, 'claim', refs);
    for (const ref of refs) {
      if (!claimsById.has(ref)) {
        throw new MetaNarrativePlanError('PLAN_UNKNOWN_CLAIM', `${where} names "${ref}", which is not an accepted claim of the bound graph (a draft handle, a fact or an invented claim is not)`);
      }
    }
    return sorted(refs);
  };

  // ---- thesis --------------------------------------------------------------------------
  const reportThesis: PlanReportThesis = { claimRefs: claimRefs('the report thesis', plan.reportThesis.claimRefs) };

  // ---- primary motifs --------------------------------------------------------------------
  const motifCores = plan.primaryMotifs.map((motif) => claimRefs(`primary motif "${motif.motifId}"`, motif.coreClaimRefs));
  const motifIds = motifCores.map((core) => `motif.${structuralHash({ coreClaimRefs: core })}`);
  const motifByHandle = handleIndex('primary motif', plan.primaryMotifs.map((motif) => motif.motifId), motifIds);
  refuseDuplicateContent('primary motif', motifIds);
  // One accepted meaning carries at most one primary motif: recombining the
  // same claims into more cores would make the motif count a function of
  // repetition, not of what the chart carries.
  const coreOwner = new Map<string, string>();
  plan.primaryMotifs.forEach((motif, position) => {
    for (const claimId of motifCores[position] ?? []) {
      const owner = coreOwner.get(claimId);
      if (owner !== undefined) {
        throw new MetaNarrativePlanError(
          'PLAN_MOTIF_CORES_OVERLAP',
          `claim "${claimId}" is in the core of primary motifs "${owner}" and "${motif.motifId}"; recombining the same claims does not make more motifs`,
        );
      }
      coreOwner.set(claimId, motif.motifId);
    }
  });

  // ---- central claims: the PD-5 floor per claim, and the floor on their number -------------
  const centralClaims = sorted([...new Set([...reportThesis.claimRefs, ...motifCores.flat()])]);
  if (centralClaims.length < MIN_CENTRAL_CLAIMS) {
    throw new MetaNarrativePlanError(
      'PLAN_INSUFFICIENT_CENTRAL_CLAIMS',
      `the thesis and the primary motifs rest on ${String(centralClaims.length)} distinct accepted claim(s); a reading rests on at least ${String(MIN_CENTRAL_CLAIMS)} central claims (Method Profile v1.0.0, section 11). Where the graph holds more claims that pass PD-5, the plan may name them; where the chart grounds fewer, stop and escalate — never pad`,
    );
  }
  for (const claimId of centralClaims) {
    assertCentralGraphClaim(graph, claimId, context);
  }

  // ---- motif count: three to five, where the chart supports them ------------------------------
  // After the floor, which it would otherwise make unreachable: three disjoint
  // cores always rest on three claims. A chart grounding fewer central claims
  // gets the floor's refusal; too few motifs over enough claims get this one.
  if (plan.primaryMotifs.length < MIN_PRIMARY_MOTIFS || plan.primaryMotifs.length > MAX_PRIMARY_MOTIFS) {
    throw new MetaNarrativePlanError(
      'PLAN_MOTIF_COUNT_OUT_OF_RANGE',
      `the plan declares ${String(plan.primaryMotifs.length)} primary motifs; a reading has ${String(MIN_PRIMARY_MOTIFS)} to ${String(MAX_PRIMARY_MOTIFS)}, each on its own accepted claims (Long-Form contract, section 8). Where the accepted claims do not carry three genuine motifs, stop and escalate — never pad`,
    );
  }

  // ---- tensions ------------------------------------------------------------------------------
  const contrasts = (from: string, to: string): boolean => (claimsById.get(from)?.relations ?? [])
    .some((relation) => relation.type === 'CONTRASTS_WITH' && relation.targetClaimId === to);
  const tensions = plan.tensions.map((tension): PlanTension => {
    const pair = claimRefs('a tension', tension.claimRefs);
    const [left, right] = pair;
    if (left === undefined || right === undefined || !(contrasts(left, right) || contrasts(right, left))) {
      throw new MetaNarrativePlanError(
        'PLAN_TENSION_NOT_IN_GRAPH',
        `the claims ${pair.map((ref) => `"${ref}"`).join(' and ')} are not related by CONTRASTS_WITH in the bound graph; a plan states tensions the graph accepted, it never creates one`,
      );
    }
    return { tensionId: tensionIdOf(pair), claimRefs: pair };
  });
  refuseDuplicateContent('tension', tensions.map((tension) => tension.tensionId));

  // ---- open threads --------------------------------------------------------------------------
  const threads = plan.openThreads.map((thread): PlanOpenThread => {
    const refs = claimRefs(`thread "${thread.threadId}"`, thread.claimRefs);
    // Resolution is not identity: the same thread declared twice with two fates is one thread twice.
    return { threadId: `thread.${structuralHash({ claimRefs: refs })}`, claimRefs: refs, resolution: thread.resolution };
  });
  const threadByHandle = handleIndex('thread', plan.openThreads.map((thread) => thread.threadId), threads.map((thread) => thread.threadId));
  refuseDuplicateContent('thread', threads.map((thread) => thread.threadId));
  const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));
  const coreOf = new Map(motifIds.map((motifId, position) => [motifId, motifCores[position] ?? []]));

  // ---- chapters (in reading order) ------------------------------------------------------------
  const chapterPlan = plan.chapterPlan.map((chapter, position): PlanChapter => {
    const where = `chapter ${String(position + 1)}`;
    const refs = claimRefs(where, chapter.claimRefs);
    refuseRepeated(where, 'motif transition for', chapter.motifTransitions.map((transition) => transition.motifRef));
    refuseRepeated(where, 'opened thread', chapter.opensThreadRefs);
    refuseRepeated(where, 'closed thread', chapter.closesThreadRefs);
    const motifTransitions = chapter.motifTransitions
      .map((transition): PlanMotifTransition => ({
        motifRef: resolveHandle(motifByHandle, where, 'primary motif', transition.motifRef),
        toState: transition.toState,
      }))
      .sort(byKey((transition) => transition.motifRef));
    const opensThreadRefs = sorted(chapter.opensThreadRefs.map((ref) => resolveHandle(threadByHandle, where, 'thread', ref)));
    const closesThreadRefs = sorted(chapter.closesThreadRefs.map((ref) => resolveHandle(threadByHandle, where, 'thread', ref)));
    // A chapter moves a motif, opens or closes a thread only where it names one
    // of that element's claims: a lifecycle is development, not bookkeeping.
    const named = new Set(refs);
    const carries = (claims: readonly string[]): boolean => claims.some((claimId) => named.has(claimId));
    for (const transition of motifTransitions) {
      if (!carries(coreOf.get(transition.motifRef) ?? [])) {
        throw new MetaNarrativePlanError(
          'PLAN_MOVEMENT_UNGROUNDED',
          `${where} moves motif "${transition.motifRef}" to ${transition.toState} without naming any claim of its core; a motif moves only where its meaning is written`,
        );
      }
    }
    for (const [verb, threadIds] of [['opens', opensThreadRefs], ['closes', closesThreadRefs]] as const) {
      for (const threadId of threadIds) {
        if (!carries(threadById.get(threadId)?.claimRefs ?? [])) {
          throw new MetaNarrativePlanError(
            'PLAN_MOVEMENT_UNGROUNDED',
            `${where} ${verb} thread "${threadId}" without naming any of its claims; a thread moves only where its meaning is written`,
          );
        }
      }
    }
    const content ={ narrativeOperation: chapter.narrativeOperation, claimRefs: refs, motifTransitions, opensThreadRefs, closesThreadRefs };
    return { chapterId: `chapter.${structuralHash(content)}`, ...content };
  });
  refuseDuplicateContent('chapter', chapterPlan.map((chapter) => chapter.chapterId));

  // ---- lifecycle: walk the reading once, in order ---------------------------------------------
  const rank = new Map<MotifState, number>(MOTIF_LIFECYCLE.map((state, index) => [state, index]));
  const stateOf = new Map<string, MotifState>(motifIds.map((motifId) => [motifId, 'UNSEEN']));
  const stepsOf = new Map<string, PlanMotifStep[]>(motifIds.map((motifId) => [motifId, []]));
  const openedAt = new Map<string, number>();
  const closed = new Set<string>();
  chapterPlan.forEach((chapter, position) => {
    const where = `chapter ${String(position + 1)}`;
    for (const transition of chapter.motifTransitions) {
      const current = stateOf.get(transition.motifRef) ?? 'UNSEEN';
      if ((rank.get(transition.toState) ?? 0) <= (rank.get(current) ?? 0)) {
        throw new MetaNarrativePlanError(
          'PLAN_ILLEGAL_MOTIF_TRANSITION',
          `${where} moves motif "${transition.motifRef}" from ${current} to ${transition.toState}; the lifecycle ${MOTIF_LIFECYCLE.join(' -> ')} only moves forward`,
        );
      }
      stateOf.set(transition.motifRef, transition.toState);
      stepsOf.get(transition.motifRef)?.push({ chapterId: chapter.chapterId, state: transition.toState });
    }
    for (const threadId of chapter.opensThreadRefs) {
      if (openedAt.has(threadId)) {
        throw new MetaNarrativePlanError('PLAN_THREAD_LIFECYCLE_INVALID', `${where} opens thread "${threadId}" a second time`);
      }
      openedAt.set(threadId, position);
    }
    for (const threadId of chapter.closesThreadRefs) {
      const opened = openedAt.get(threadId);
      if (opened === undefined || opened === position) {
        throw new MetaNarrativePlanError('PLAN_THREAD_LIFECYCLE_INVALID', `${where} closes thread "${threadId}", which no earlier chapter opened`);
      }
      if (threadById.get(threadId)?.resolution === 'LEAVE_OPEN') {
        throw new MetaNarrativePlanError('PLAN_THREAD_LIFECYCLE_INVALID', `${where} closes thread "${threadId}", which the plan declares left open`);
      }
      if (closed.has(threadId)) {
        throw new MetaNarrativePlanError('PLAN_THREAD_LIFECYCLE_INVALID', `${where} closes thread "${threadId}" a second time`);
      }
      closed.add(threadId);
    }
  });
  for (const thread of threads) {
    if (!openedAt.has(thread.threadId)) {
      throw new MetaNarrativePlanError('PLAN_THREAD_LIFECYCLE_INVALID', `thread "${thread.threadId}" is declared but no chapter opens it`);
    }
    if (thread.resolution === 'CLOSE' && !closed.has(thread.threadId)) {
      throw new MetaNarrativePlanError('PLAN_THREAD_LIFECYCLE_INVALID', `thread "${thread.threadId}" is opened, declared to close, and never closed; a thread is not silently lost`);
    }
  }
  // Only a thread that names one of a motif's core claims can leave that motif
  // explicitly open: a thread about something else says nothing about it.
  const leftOpenClaims = new Set(threads.filter((thread) => thread.resolution === 'LEAVE_OPEN').flatMap((thread) => thread.claimRefs));
  const primaryMotifs = motifIds.map((motifId, position): PlanPrimaryMotif => {
    const finalState = stateOf.get(motifId) ?? 'UNSEEN';
    const resolved = finalState === 'INTEGRATED' || finalState === 'CLOSED';
    const leftOpen = (motifCores[position] ?? []).some((claimId) => leftOpenClaims.has(claimId));
    if (!resolved && (finalState === 'UNSEEN' || !leftOpen)) {
      throw new MetaNarrativePlanError(
        'PLAN_MOTIF_SILENTLY_DROPPED',
        finalState === 'UNSEEN'
          ? `primary motif "${motifId}" is never opened by any chapter; a central motif the reading never develops is forgotten before it starts`
          : `primary motif "${motifId}" is opened and ends ${finalState}: neither integrated nor closed, and no thread naming one of its core claims is left open`,
      );
    }
    return { motifId, coreClaimRefs: motifCores[position] ?? [], lifecycle: stepsOf.get(motifId) ?? [], finalState };
  });

  // ---- coverage and constraints ------------------------------------------------------------------
  const planned = sorted([...new Set([
    ...centralClaims,
    ...tensions.flatMap((tension) => tension.claimRefs),
    ...threads.flatMap((thread) => thread.claimRefs),
    ...chapterPlan.flatMap((chapter) => chapter.claimRefs),
  ])]);
  const plannedSet = new Set(planned);
  // A tension the graph states between two claims the reading uses is part of
  // that reading: declaring it is not optional, or ambivalence is flattened.
  const declaredTensions = new Set(tensions.map((tension) => tension.tensionId));
  for (const claimId of planned) {
    for (const relation of claimsById.get(claimId)?.relations ?? []) {
      if (relation.type === 'CONTRASTS_WITH' && plannedSet.has(relation.targetClaimId)
        && !declaredTensions.has(tensionIdOf(sorted([claimId, relation.targetClaimId])))) {
        throw new MetaNarrativePlanError(
          'PLAN_TENSION_UNDECLARED',
          `the plan uses "${claimId}" and "${relation.targetClaimId}", which the bound graph relates by CONTRASTS_WITH, without declaring that tension; a counter-signal the reading carries is not flattened`,
        );
      }
    }
  }
  const cited = new Set(planned.flatMap((claimId) => claimsById.get(claimId)?.factRefs ?? []));
  const interpretable = context.brief.facts.filter((fact) => fact.interpretable).map((fact) => fact.id);
  const themes = [...context.brief.primaryThemes, ...context.brief.candidateThemes];
  const touched = new Set(themes.filter((theme) => theme.factIds.some((factId) => cited.has(factId))).map((theme) => theme.id));
  const coverage: PlanCoverage = {
    plannedClaimRefs: planned,
    unplannedClaimRefs: sorted(graph.claims.map((claim) => claim.claimId).filter((claimId) => !plannedSet.has(claimId))),
    citedFactRefs: sorted([...cited]),
    uncitedFactRefs: sorted(interpretable.filter((factId) => !cited.has(factId))),
    touchedThemeRefs: sorted([...touched]),
    untouchedThemeRefs: sorted(themes.map((theme) => theme.id).filter((themeId) => !touched.has(themeId))),
  };

  const core = {
    planVersion: META_NARRATIVE_PLAN_VERSION,
    sourceBriefStructuralHash: context.brief.structuralHash,
    claimGraphStructuralHash: graph.structuralHash,
    methodProfileRef: graph.methodProfileRef,
    methodProfileVersion: graph.methodProfileVersion,
    methodRegistryStructuralHash: graph.methodRegistryStructuralHash,
    terminologyLexicon: { ...TERMINOLOGY_LEXICON_BINDING },
    reportThesis,
    primaryMotifs: primaryMotifs.sort(byKey((motif) => motif.motifId)),
    tensions: tensions.sort(byKey((tension) => tension.tensionId)),
    openThreads: threads.sort(byKey((thread) => thread.threadId)),
    chapterPlan,
    coverage,
    constraints: {
      allowedClaimRefs: planned,
      newClaimsForbidden: true as const,
      newChartFactsForbidden: true as const,
      newClaimRelationsForbidden: true as const,
      epistemicClassesFixed: true as const,
    },
  };
  return { ...core, structuralHash: structuralHash(core) };
}

/**
 * The draft a plan is the acceptance of: its bindings and its choices, without
 * anything the builder derives. Building it again yields the same plan.
 */
export function metaNarrativePlanDraftOf(plan: MetaNarrativePlan): MetaNarrativePlanDraft {
  return {
    sourceBriefStructuralHash: plan.sourceBriefStructuralHash,
    claimGraphStructuralHash: plan.claimGraphStructuralHash,
    reportThesis: { claimRefs: plan.reportThesis.claimRefs },
    primaryMotifs: plan.primaryMotifs.map((motif) => ({ motifId: motif.motifId, coreClaimRefs: motif.coreClaimRefs })),
    tensions: plan.tensions.map((tension) => ({ claimRefs: tension.claimRefs })),
    openThreads: plan.openThreads.map((thread) => ({
      threadId: thread.threadId,
      claimRefs: thread.claimRefs,
      resolution: thread.resolution,
    })),
    chapterPlan: plan.chapterPlan.map((chapter) => ({
      narrativeOperation: chapter.narrativeOperation,
      claimRefs: chapter.claimRefs,
      motifTransitions: chapter.motifTransitions.map((transition) => ({ motifRef: transition.motifRef, toState: transition.toState })),
      opensThreadRefs: chapter.opensThreadRefs,
      closesThreadRefs: chapter.closesThreadRefs,
    })),
  };
}

/**
 * Proves that `plan` is, byte for byte, the plan the builder produces from the
 * plan's own choices for this chart, brief, released profile and accepted
 * graph. Anything else — an edited motif, a rewritten lifecycle, a lexicon
 * marked bound, an added field, a binding hash that is not this brief's or
 * this graph's — is refused (`PLAN_NOT_INTACT`, the cause in the message), as
 * the claim graph does for a graph of another chart. A caller that wants the
 * specific binding refusal re-builds the plan's draft (`metaNarrativePlanDraftOf`).
 *
 * A consistency proof, not tamper evidence (plain SHA-256, as for the graph):
 * whoever needs to know a plan is still the one they accepted pins its
 * `structuralHash`. A context that is not an intact graph of this chart, or an
 * unreleased registry, is not a damaged plan and surfaces as what it is.
 */
export function assertMetaNarrativePlanIntact(plan: MetaNarrativePlan, context: MetaNarrativePlanContext): void {
  let presented: string;
  let draft: MetaNarrativePlanDraft;
  try {
    presented = structuralHash(plan);
    draft = metaNarrativePlanDraftOf(plan);
  } catch {
    throw new MetaNarrativePlanError('PLAN_NOT_INTACT', 'the value does not have the shape of an accepted plan');
  }
  let rebuilt: MetaNarrativePlan;
  try {
    rebuilt = buildMetaNarrativePlan(draft, context);
  } catch (error) {
    const refusedPlan = error instanceof ClaimError
      || error instanceof MetaNarrativePlanError;
    if (!refusedPlan) {
      throw error;
    }
    throw new MetaNarrativePlanError('PLAN_NOT_INTACT', `the plan is not acceptable for this graph (${error.message})`);
  }
  if (presented !== structuralHash(rebuilt)) {
    throw new MetaNarrativePlanError('PLAN_NOT_INTACT', 'the plan differs from the plan its own choices produce for this graph');
  }
}
