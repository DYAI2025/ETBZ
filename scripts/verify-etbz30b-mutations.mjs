#!/usr/bin/env node
/**
 * ETBZ-30B — source-mutation proofs for the guards of the MetaNarrativePlan.
 *
 * For each guard listed below: weaken the SOURCE in one place, run the tests
 * that claim to protect it, and require them to turn RED. A guard whose removal
 * leaves the suite green is decoration. The list is the proof; a guard that is
 * not in it has not been proven. The unmutated baseline must be GREEN first —
 * otherwise "red" proves nothing. Every file is restored byte-for-byte
 * afterwards, and the run fails if the working tree is not clean at the end.
 *
 * RED means a TEST failed: an assertion failed, or the test body threw. A
 * mutant that only makes a test time out, or that breaks loading or collection
 * of the file, proves nothing about the guard and is reported as an error,
 * never as a kill; each kill names the test that caught it. A mutant may name
 * the test that must catch it: that test must then fail an ASSERTION — a throw
 * in its body is not enough — and a kill by any other test alone is an error.
 *
 *   npm run guards:etbz30b
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLAN = 'src/application/interpretation/meta-narrative-plan.ts';

const T = {
  unit: 'tests/unit/meta-narrative-plan.test.ts',
  negative: 'tests/negative/meta-narrative-plan.negative.test.ts',
};

/**
 * [name, file, find, replace, tests, killer?] — `find` must occur exactly once;
 * `killer`, where given, is part of the name of the test that must fail.
 */
const MUTANTS = [
  // --- bindings ---------------------------------------------------------------------------
  ['BIND: the context graph is not re-proven', PLAN, "  assertInterpretiveClaimGraphIntact(graph, context);\n", "", [T.negative]],
  ['BIND: a draft written for another brief is accepted', PLAN, "  if (plan.sourceBriefStructuralHash !== context.brief.structuralHash) {", "  if (plan.sourceBriefStructuralHash === '') {", [T.negative]],
  ['BIND: a draft written for another graph is accepted', PLAN, "  if (plan.claimGraphStructuralHash !== graph.structuralHash) {", "  if (plan.claimGraphStructuralHash === '') {", [T.negative]],
  ['BIND: the plan does not carry its version', PLAN, "    planVersion: META_NARRATIVE_PLAN_VERSION,\n", "", [T.unit]],
  ['BIND: the plan does not name its brief', PLAN, "    sourceBriefStructuralHash: context.brief.structuralHash,\n", "    sourceBriefStructuralHash: '',\n", [T.unit]],
  ['BIND: the plan does not name its graph', PLAN, "    claimGraphStructuralHash: graph.structuralHash,\n", "    claimGraphStructuralHash: '',\n", [T.unit]],
  ['BIND: the plan does not carry the released registry hash', PLAN, "    methodRegistryStructuralHash: graph.methodRegistryStructuralHash,\n", "", [T.unit]],
  ['BIND: the plan does not carry methodProfileVersion', PLAN, "    methodProfileVersion: graph.methodProfileVersion,\n", "", [T.unit]],
  // --- ETBZ-36: the lexicon is not invented ------------------------------------------------
  ['LEXICON: the unreleased lexicon is declared bound', PLAN, "{ dependency: 'ETBZ-36', status: 'UNRESOLVED' } as const;", "{ dependency: 'ETBZ-36', status: 'BOUND' } as const;", [T.unit]],
  ['LEXICON: the binding is left out instead of stated', PLAN, "    terminologyLexicon: { ...TERMINOLOGY_LEXICON_BINDING },\n", "", [T.unit]],
  ['LEXICON: a lexicon version is invented', PLAN, "    terminologyLexicon: { ...TERMINOLOGY_LEXICON_BINDING },\n", "    terminologyLexicon: { ...TERMINOLOGY_LEXICON_BINDING, lexiconRef: 'terminology-lexicon@1.0.0' },\n", [T.unit]],
  // --- references resolve to ACCEPTED claims ------------------------------------------------
  ['REF: an unknown claim is accepted', PLAN, "      if (!claimsById.has(ref)) {", "      if (!claimsById.has(ref) && refs.length < 0) {", [T.negative]],
  ['REF: an empty element is accepted', PLAN, "    if (refs.length === 0) {", "    if (refs.length < 0) {", [T.negative]],
  ['REF: a repeated claim ref is counted instead of refused', PLAN, "    refuseRepeated(where, 'claim', refs);\n", "", [T.negative]],
  ['REF: no repeat is refused anywhere', PLAN, "    if (seen.has(value)) {", "    if (seen.has(value) && values.length < 0) {", [T.negative]],
  ['REF: a dangling motif or thread handle is kept', PLAN, "  if (accepted === undefined) {\n    throw", "  if (accepted === undefined) {\n    return handle;\n    throw", [T.negative]],
  ['REF: a repeated motif transition in one chapter is not looked at', PLAN, "    refuseRepeated(where, 'motif transition for', chapter.motifTransitions.map((transition) => transition.motifRef));\n", "", [T.negative]],
  ['REF: a thread opened twice in one chapter is not looked at', PLAN, "    refuseRepeated(where, 'opened thread', chapter.opensThreadRefs);\n", "", [T.negative]],
  ['REF: a thread closed twice in one chapter is not looked at', PLAN, "    refuseRepeated(where, 'closed thread', chapter.closesThreadRefs);\n", "", [T.negative]],
  // --- duplication ---------------------------------------------------------------------------
  ['DUP: two elements under one handle', PLAN, "    if (index.has(handle)) {", "    if (index.has(handle) && handles.length < 0) {", [T.negative]],
  ['DUP: the same content twice becomes two elements', PLAN, "    if (seen.has(id)) {", "    if (seen.has(id) && ids.length < 0) {", [T.negative]],
  ['DUP: duplicate motifs are not looked at', PLAN, "  refuseDuplicateContent('primary motif', motifIds);\n", "", [T.negative]],
  ['DUP: duplicate tensions are not looked at', PLAN, "  refuseDuplicateContent('tension', tensions.map((tension) => tension.tensionId));\n", "", [T.negative]],
  ['DUP: duplicate threads are not looked at', PLAN, "  refuseDuplicateContent('thread', threads.map((thread) => thread.threadId));\n", "", [T.negative]],
  ['DUP: duplicate chapters are not looked at', PLAN, "  refuseDuplicateContent('chapter', chapterPlan.map((chapter) => chapter.chapterId));\n", "", [T.negative]],
  // --- motif count (three to five, PO decision) and the central-claim floor -------------------------
  ['COUNT: six primary motifs are accepted', PLAN, "plan.primaryMotifs.length > MAX_PRIMARY_MOTIFS) {", "plan.primaryMotifs.length > MAX_PRIMARY_MOTIFS + 1) {", [T.negative], 'refuses six primary motifs'],
  ['COUNT: exactly five primary motifs are refused', PLAN, "plan.primaryMotifs.length > MAX_PRIMARY_MOTIFS) {", "plan.primaryMotifs.length >= MAX_PRIMARY_MOTIFS) {", [T.negative], 'accepts five disjoint cores'],
  ['COUNT: the minimum is removed — a plan without a primary motif is accepted', PLAN, "plan.primaryMotifs.length < MIN_PRIMARY_MOTIFS || ", "", [T.negative], 'refuses zero primary motifs'],
  ['COUNT: the former 1–5 rule — one primary motif is accepted', PLAN, "const MIN_PRIMARY_MOTIFS = 3;", "const MIN_PRIMARY_MOTIFS = 1;", [T.negative], 'refuses one primary motif'],
  ['COUNT: two primary motifs are accepted', PLAN, "plan.primaryMotifs.length < MIN_PRIMARY_MOTIFS ||", "plan.primaryMotifs.length < MIN_PRIMARY_MOTIFS - 1 ||", [T.negative], 'refuses two primary motifs'],
  ['COUNT: exactly three primary motifs are refused', PLAN, "plan.primaryMotifs.length < MIN_PRIMARY_MOTIFS ||", "plan.primaryMotifs.length <= MIN_PRIMARY_MOTIFS ||", [T.negative], 'accepts three disjoint cores'],
  ['COUNT: counted before the central-claim floor, which it makes unreachable', PLAN, "  const motifCores = plan.primaryMotifs.map(", "  if (plan.primaryMotifs.length < MIN_PRIMARY_MOTIFS) {\n    throw new MetaNarrativePlanError('PLAN_MOTIF_COUNT_OUT_OF_RANGE', 'counted before the floor');\n  }\n  const motifCores = plan.primaryMotifs.map(", [T.negative], 'refuses a plan resting on fewer than three distinct central claims'],
  ['FLOOR: fewer than three central claims', PLAN, "  if (centralClaims.length < MIN_CENTRAL_CLAIMS) {", "  if (centralClaims.length < 2) {", [T.negative], 'refuses a plan resting on fewer than three distinct central claims'],
  ['FLOOR: repetition is counted towards the floor', PLAN, "  const centralClaims = sorted([...new Set([...reportThesis.claimRefs, ...motifCores.flat()])]);", "  const centralClaims = sorted([...reportThesis.claimRefs, ...motifCores.flat()]);", [T.negative], 'does not let repetition reach the floor'],
  // --- PD-5 --------------------------------------------------------------------------------------
  ['PD-5: the floor is not composed', PLAN, "    assertCentralGraphClaim(graph, claimId, context);\n", "", [T.negative]],
  ['PD-5: the thesis is not central', PLAN, "  const centralClaims = sorted([...new Set([...reportThesis.claimRefs, ...motifCores.flat()])]);", "  const centralClaims = sorted([...new Set([...motifCores.flat()])]);", [T.negative]],
  ['PD-5: the motif cores are not central', PLAN, "  const centralClaims = sorted([...new Set([...reportThesis.claimRefs, ...motifCores.flat()])]);", "  const centralClaims = sorted([...new Set([...reportThesis.claimRefs])]);", [T.negative]],
  // --- tensions ------------------------------------------------------------------------------------
  ['TENSION: a tension the graph does not state is accepted', PLAN, "    if (left === undefined || right === undefined || !(contrasts(left, right) || contrasts(right, left))) {", "    if (left === undefined || right === undefined) {", [T.negative]],
  ['TENSION: only one direction of the relation is read', PLAN, "!(contrasts(left, right) || contrasts(right, left))", "!contrasts(left, right)", [T.unit]],
  ['TENSION: any relation counts as a tension', PLAN, "    .some((relation) => relation.type === 'CONTRASTS_WITH' && relation.targetClaimId === to);", "    .some((relation) => relation.targetClaimId === to);", [T.negative]],
  ['TENSION: a stated contrast among planned claims may be flattened', PLAN, "      if (relation.type === 'CONTRASTS_WITH' && plannedSet.has(relation.targetClaimId)\n", "      if (relation.type === 'CONTRASTS_WITH' && plannedSet.has(relation.targetClaimId) && planned.length < 0\n", [T.negative]],
  // --- threads -------------------------------------------------------------------------------------
  ['THREAD: the fate enters thread identity', PLAN, "threadId: `thread.${structuralHash({ claimRefs: refs })}`", "threadId: `thread.${structuralHash({ claimRefs: refs, resolution: thread.resolution })}`", [T.negative]],
  ['THREAD: a declared thread no chapter opens', PLAN, "    if (!openedAt.has(thread.threadId)) {", "    if (!openedAt.has(thread.threadId) && threads.length < 0) {", [T.negative]],
  ['THREAD: a thread declared to close is silently lost', PLAN, "    if (thread.resolution === 'CLOSE' && !closed.has(thread.threadId)) {", "    if (thread.resolution === 'CLOSE' && !closed.has(thread.threadId) && threads.length < 0) {", [T.negative]],
  ['THREAD: a thread opened in two chapters', PLAN, "      if (openedAt.has(threadId)) {", "      if (openedAt.has(threadId) && position < 0) {", [T.negative]],
  ['THREAD: a thread opened and closed in one chapter', PLAN, "      if (opened === undefined || opened === position) {", "      if (opened === undefined) {", [T.negative]],
  ['THREAD: a thread declared left open is closed', PLAN, "      if (threadById.get(threadId)?.resolution === 'LEAVE_OPEN') {", "      if (threadById.get(threadId)?.resolution === 'LEAVE_OPEN' && position < 0) {", [T.negative]],
  ['THREAD: a thread closed in two chapters', PLAN, "      if (closed.has(threadId)) {", "      if (closed.has(threadId) && position < 0) {", [T.negative]],
  // --- lifecycle -----------------------------------------------------------------------------------
  ['LIFECYCLE: a step in place is a transition', PLAN, "      if ((rank.get(transition.toState) ?? 0) <= (rank.get(current) ?? 0)) {", "      if ((rank.get(transition.toState) ?? 0) < (rank.get(current) ?? 0)) {", [T.negative]],
  ['LIFECYCLE: any step is allowed', PLAN, "      if ((rank.get(transition.toState) ?? 0) <= (rank.get(current) ?? 0)) {", "      if ((rank.get(transition.toState) ?? 0) < 0) {", [T.negative]],
  ['LIFECYCLE: the walk is not recorded on the motif', PLAN, "      stepsOf.get(transition.motifRef)?.push({ chapterId: chapter.chapterId, state: transition.toState });\n", "", [T.unit]],
  ['DROP: a motif opened and left unfinished is accepted', PLAN, "    if (!resolved && (finalState === 'UNSEEN' || !leftOpen)) {", "    if (!resolved && finalState === 'UNSEEN') {", [T.negative]],
  ['DROP: a motif never opened is accepted when a thread names it', PLAN, "    if (!resolved && (finalState === 'UNSEEN' || !leftOpen)) {", "    if (!resolved && !leftOpen) {", [T.negative]],
  ['DROP: a thread that closes counts as leaving its motif open', PLAN, "threads.filter((thread) => thread.resolution === 'LEAVE_OPEN').flatMap(", "threads.flatMap(", [T.negative]],
  ['DROP: a left-open thread about other claims leaves any motif open', PLAN, "    const leftOpen = (motifCores[position] ?? []).some((claimId) => leftOpenClaims.has(claimId));", "    const leftOpen = leftOpenClaims.size > 0;", [T.negative]],
  // --- grounding of movement and disjoint cores --------------------------------------------------
  ['GROUND: a motif moves in a chapter that names none of its core claims', PLAN, "      if (!carries(coreOf.get(transition.motifRef) ?? [])) {", "      if (!carries(coreOf.get(transition.motifRef) ?? []) && position < 0) {", [T.negative]],
  ['GROUND: a thread moves in a chapter that names none of its claims', PLAN, "        if (!carries(threadById.get(threadId)?.claimRefs ?? [])) {", "        if (!carries(threadById.get(threadId)?.claimRefs ?? []) && position < 0) {", [T.negative]],
  ['GROUND: only the opening of a thread is grounded', PLAN, "of [['opens', opensThreadRefs], ['closes', closesThreadRefs]] as const) {", "of [['opens', opensThreadRefs]] as const) {", [T.negative]],
  ['GROUND: only the closing of a thread is grounded', PLAN, "of [['opens', opensThreadRefs], ['closes', closesThreadRefs]] as const) {", "of [['closes', closesThreadRefs]] as const) {", [T.negative]],
  ['OVERLAP: recombined claims become more primary motifs', PLAN, "      if (owner !== undefined) {", "      if (owner !== undefined && position < 0) {", [T.negative]],
  // --- identity and order ----------------------------------------------------------------------------
  ['IDENTITY: the motif handle enters motif identity', PLAN, "  const motifIds = motifCores.map((core) => `motif.${structuralHash({ coreClaimRefs: core })}`);", "  const motifIds = motifCores.map((core, index) => `motif.${structuralHash({ coreClaimRefs: core, handle: plan.primaryMotifs[index]?.motifId })}`);", [T.unit]],
  ['IDENTITY: the thread handle enters thread identity', PLAN, "threadId: `thread.${structuralHash({ claimRefs: refs })}`", "threadId: `thread.${structuralHash({ claimRefs: refs, handle: thread.threadId })}`", [T.unit]],
  ['IDENTITY: the chapter position enters chapter identity', PLAN, "    return { chapterId: `chapter.${structuralHash(content)}`, ...content };", "    return { chapterId: `chapter.${structuralHash({ ...content, position })}`, ...content };", [T.unit]],
  ['ORDER: reference input order survives into the plan', PLAN, "    return sorted(refs);\n  };", "    return [...refs];\n  };", [T.unit]],
  ['ORDER: motif input order survives into the plan', PLAN, "    primaryMotifs: primaryMotifs.sort(byKey((motif) => motif.motifId)),", "    primaryMotifs,", [T.unit]],
  ['ORDER: tension input order survives into the plan', PLAN, "    tensions: tensions.sort(byKey((tension) => tension.tensionId)),", "    tensions,", [T.unit]],
  ['ORDER: thread input order survives into the plan', PLAN, "    openThreads: threads.sort(byKey((thread) => thread.threadId)),", "    openThreads: threads,", [T.unit]],
  ['ORDER: transition input order survives into the plan', PLAN, "      .sort(byKey((transition) => transition.motifRef));", ";", [T.unit]],
  ['ORDER: opened-thread input order survives into the plan', PLAN, "    const opensThreadRefs = sorted(chapter.opensThreadRefs.map(", "    const opensThreadRefs = (chapter.opensThreadRefs.map(", [T.unit]],
  ['ORDER: closed-thread input order survives into the plan', PLAN, "    const closesThreadRefs = sorted(chapter.closesThreadRefs.map(", "    const closesThreadRefs = (chapter.closesThreadRefs.map(", [T.unit]],
  ['ORDER: the reading order is sorted away', PLAN, "    chapterPlan,\n    coverage,", "    chapterPlan: [...chapterPlan].sort(byKey((entry) => entry.chapterId)),\n    coverage,", [T.unit]],
  // --- coverage and constraints -------------------------------------------------------------------------
  ['COVERAGE: excluded (assumed-time) facts are offered as uncovered', PLAN, "  const interpretable = context.brief.facts.filter((fact) => fact.interpretable).map(", "  const interpretable = context.brief.facts.map(", [T.unit]],
  ['COVERAGE: a claim named only by a motif core is not planned', PLAN, "    ...centralClaims,\n", "", [T.unit]],
  ['COVERAGE: a claim named only by a thread is not planned', PLAN, "    ...threads.flatMap((thread) => thread.claimRefs),\n", "", [T.unit]],
  ['COVERAGE: a claim named only by a tension is not planned', PLAN, "    ...tensions.flatMap((tension) => tension.claimRefs),\n", "", [T.unit]],
  ['CONSTRAINT: every graph claim may be rendered', PLAN, "      allowedClaimRefs: planned,", "      allowedClaimRefs: graph.claims.map((claim) => claim.claimId),", [T.unit]],
  ['CONSTRAINT: new claims are no longer forbidden', PLAN, "      newClaimsForbidden: true as const,", "      newClaimsForbidden: false as unknown as true,", [T.unit]],
  ['NUMBER: a count is published', PLAN, "    plannedClaimRefs: planned,\n", "    plannedClaimRefs: planned,\n    plannedClaimCount: planned.length,\n", [T.unit]],
  // --- the draft is untrusted ------------------------------------------------------------------------------
  ['SCHEMA: unknown fields on the draft are tolerated', PLAN, "const planDraftSchema = z.strictObject({", "const planDraftSchema = z.object({", [T.negative]],
  ['SCHEMA: unknown fields on the thesis are tolerated', PLAN, "  reportThesis: z.strictObject({ claimRefs: z.array(idLike) }),", "  reportThesis: z.object({ claimRefs: z.array(idLike) }),", [T.negative]],
  ['SCHEMA: unknown fields on a motif are tolerated', PLAN, "  primaryMotifs: z.array(z.strictObject({", "  primaryMotifs: z.array(z.object({", [T.negative]],
  ['SCHEMA: unknown fields on a tension are tolerated', PLAN, "  tensions: z.array(z.strictObject({", "  tensions: z.array(z.object({", [T.negative]],
  ['SCHEMA: unknown fields on a thread are tolerated', PLAN, "  openThreads: z.array(z.strictObject({", "  openThreads: z.array(z.object({", [T.negative]],
  ['SCHEMA: unknown fields on a chapter are tolerated', PLAN, "  chapterPlan: z.array(z.strictObject({", "  chapterPlan: z.array(z.object({", [T.negative]],
  ['SCHEMA: unknown fields on a transition are tolerated', PLAN, "    motifTransitions: z.array(z.strictObject({", "    motifTransitions: z.array(z.object({", [T.negative]],
  ['SCHEMA: a tension need not be a pair', PLAN, "z.array(idLike).length(2)", "z.array(idLike)", [T.negative]],
  ['SCHEMA: an empty id is an id', PLAN, "const idLike = z.string().min(1).max(256);", "const idLike = z.string().max(256);", [T.negative]],
  ['SCHEMA: id-like strings are unbounded', PLAN, "const idLike = z.string().min(1).max(256);", "const idLike = z.string().min(1);", [T.negative]],
  ['SCHEMA: a schema refusal echoes what it received', PLAN, "}: ${issue.code}`)", "}: ${issue.message}`)", [T.negative]],
  // --- integrity ------------------------------------------------------------------------------------------------
  ['INTACT: an edited plan passes', PLAN, "  if (presented !== structuralHash(rebuilt)) {", "  if (presented === '') {", [T.unit]],
  ['INTACT: only the printed hash is compared, so an added field passes', PLAN, "  if (presented !== structuralHash(rebuilt)) {", "  if (plan.structuralHash !== rebuilt.structuralHash) {", [T.unit]],
  ['INTACT: a PD-5 refusal escapes as a raw ClaimError', PLAN, "    const refusedPlan = error instanceof ClaimError\n      || error instanceof MetaNarrativePlanError;", "    const refusedPlan = error instanceof MetaNarrativePlanError;", [T.unit]],
  ['INTACT: a value that is not plan-shaped escapes as a raw TypeError', PLAN, "  } catch {\n    throw new MetaNarrativePlanError('PLAN_NOT_INTACT', 'the value does not have the shape of an accepted plan');", "  } catch (shapeError) {\n    throw shapeError;", [T.unit]],
  ['INTACT: a plan of another brief or graph escapes as a raw binding refusal', PLAN, "      || error instanceof MetaNarrativePlanError;", "      || (error instanceof MetaNarrativePlanError && !error.code.endsWith('_HASH_MISMATCH'));", [T.unit]],
  ['INTACT: a wrong context is reported as a damaged plan', PLAN, "    if (!refusedPlan) {\n      throw error;\n    }\n", "", [T.unit]],
];

const REPORT_DIR = mkdtempSync(join(tmpdir(), 'etbz30b-mutants-'));
const REPORT = join(REPORT_DIR, 'vitest.json');

/**
 * Runs the named suites and classifies the run. Only an ASSERTION failure is
 * RED: a run that did not end, a report that is missing, a suite that failed
 * without a failing assertion (load / collect error) or a test that timed out
 * is an error, never "red".
 */
function run(tests) {
  rmSync(REPORT, { force: true });
  const result = spawnSync('npx', ['vitest', 'run', ...tests, '--reporter=json', `--outputFile=${REPORT}`], { encoding: 'utf8' });
  if (result.status === null || result.error !== undefined) return { outcome: 'DID_NOT_FINISH' };
  if (result.status === 0) return { outcome: 'GREEN' };
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT, 'utf8'));
  } catch {
    return { outcome: 'NO_REPORT' };
  }
  const failed = (report.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).filter((test) => test.status === 'failed'));
  if (failed.length === 0) return { outcome: 'NO_ASSERTION_FAILED' };
  if (failed.some((test) => (test.failureMessages ?? []).some((message) => /timed out/iu.test(message)))) return { outcome: 'TIMEOUT' };
  return {
    outcome: 'RED',
    failed: failed.map((test) => ({
      fullName: test.fullName,
      asserted: (test.failureMessages ?? []).some((message) => message.startsWith('AssertionError')),
    })),
  };
}

/**
 * A kill is a failed test — never a timeout, a load or a collection error. A
 * mutant that names its test is killed only by that test failing an assertion.
 */
function verdictOf(verdict, killer) {
  if (verdict.outcome === 'GREEN') return 'STAYED GREEN — guard is decoration';
  if (verdict.outcome !== 'RED') return `RUN_ERROR (${verdict.outcome}) — not a proof`;
  if (killer === undefined) return `RED (guard holds) <- ${verdict.failed[0].fullName}`;
  const named = verdict.failed.filter((test) => test.fullName.includes(killer));
  const by = named.find((test) => test.asserted);
  if (by !== undefined) return `RED (guard holds) <- ${by.fullName}`;
  return named.length > 0
    ? `RUN_ERROR (KILLER_DID_NOT_ASSERT: "${named[0].fullName}" threw instead of failing an assertion) — not a proof`
    : `RUN_ERROR (KILLED_BY_OTHER_TEST: "${verdict.failed[0].fullName}", expected "${killer}") — not a proof`;
}

const baseline = run([T.unit, T.negative]);
if (baseline.outcome !== 'GREEN') {
  process.stdout.write(`BASELINE_NOT_GREEN (${baseline.outcome}): the unmutated suites fail, so a red mutant would prove nothing\n`);
  process.exit(1);
}
process.stdout.write('BASELINE GREEN (unmutated)\n');

const results = [];
for (const [name, file, find, replace, tests, killer] of MUTANTS) {
  const original = readFileSync(file, 'utf8');
  const occurrences = original.split(find).length - 1;
  if (occurrences !== 1) {
    results.push([name, `SETUP_ERROR (pattern occurs ${occurrences}x in ${file})`]);
    continue;
  }
  writeFileSync(file, original.replace(find, replace));
  let verdict;
  try {
    verdict = run(tests);
  } finally {
    writeFileSync(file, original);
  }
  results.push([name, verdictOf(verdict, killer)]);
}
rmSync(REPORT_DIR, { recursive: true, force: true });

let killed = 0;
for (const [name, outcome] of results) {
  if (outcome.startsWith('RED')) killed += 1;
  process.stdout.write(`${name}\n    ${outcome}\n`);
}
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'tests'], { encoding: 'utf8' }).trim();
if (dirty.length > 0) {
  process.stdout.write(`MUTATION_RESIDUE:\n${dirty}\n`);
}
process.stdout.write(`\n${killed}/${results.length} mutants killed; working tree ${dirty.length === 0 ? 'clean' : 'DIRTY'}\n`);
process.exit(killed === results.length && dirty.length === 0 ? 0 : 1);
