# ADR 0008 — MetaNarrativePlan (ETBZ-30B)

- **Status:** Proposed — not merged. Merge requires explicit Product Owner
  authorisation **and** the versioned ETBZ-36 lexicon binding (Jira ETBZ-30,
  "DRS — ETBZ-30B MetaNarrativePlan", R4M), which does not exist yet.
- **Date:** 2026-09-19
- **Slice:** ETBZ-30B — the second of two increments of ETBZ-30. Builds on the
  accepted ETBZ-30A `InterpretiveClaimGraph` (ADR 0007).
- **Base:** `main@76eb1b4193cac9a595eb8ed952958641cdd7050f`
- **Canonical product text:** Confluence ETBZ — *Long-Form Meta-Narrative
  Contract v1* (`57802765`, sections 7, 8, 12, 21), *BaZi Method Profile v1*
  (`63012866`, version 1.0.0, sections 3 and 11), *Rebaseline v1* (`62128133`).
  Acceptance list: Jira ETBZ-30, "DRS — ETBZ-30B MetaNarrativePlan".

## Context

The claim graph says which interpretations of one chart are accepted. It does
not say which of them carry the reading, in which order they are developed,
against which counter-meaning, or which lines stay open. Without that, a
long-form reading is either decided in prose (where it cannot be checked) or
not at all. The plan is also the semantic hand-off into the Bazodiac
Interpretation Skill (ETBZ-38): it must be deterministic, plain data, and
consumable without any provider or runtime state.

## Decision

`src/application/interpretation/meta-narrative-plan.ts` adds one acceptance
boundary:

```
NarrativeBrief + InterpretiveClaimGraph + plan draft -> validation -> normalisation -> MetaNarrativePlan
```

The draft is untrusted. A drafter (a person; one day the Skill) proposes the
thesis, the primary motifs, the tensions, the threads and the chapter sequence.
The plan writes no prose, derives no fact, knows no astrology and decides no
importance: it accepts only what the bound graph and the released Method
Profile carry. It composes the existing gates and re-implements none:

- the context graph is re-proven with `assertInterpretiveClaimGraphIntact`
  (which in turn re-derives the brief from the model and requires the released
  registry) — its refusals surface unchanged (`ClaimGraphError`,
  `MethodRegistryError`);
- every central claim goes through `assertCentralGraphClaim` — the PD-5 floor
  of ADR 0007 — and a claim below it surfaces as `ClaimError`
  `CLAIM_INSUFFICIENT_SIGNALS`, unchanged.

Only plan-level refusals are `MetaNarrativePlanError`:

| Concern | Rule | Refusal |
|---|---|---|
| Binding | The draft names the brief and the accepted graph it was written for; both are compared, never trusted. The plan carries `sourceBriefStructuralHash` (the Long-Form contract's `sourceBriefHash`, named as in the claim graph), `claimGraphStructuralHash` and — copied from the re-proven graph — `methodProfileRef`, `methodProfileVersion`, `methodRegistryStructuralHash`. | `PLAN_BRIEF_HASH_MISMATCH`, `PLAN_CLAIM_GRAPH_HASH_MISMATCH` |
| References | Every claim reference in thesis, motif cores, tensions, threads and chapters is an ACCEPTED claim id of the bound graph — not a draft handle, not a fact id, not a claim of another graph. Motif and thread references resolve to elements the plan declares. | `PLAN_UNKNOWN_CLAIM`, `PLAN_DANGLING_REFERENCE` |
| Grounding | A thesis, a motif core, a thread and a chapter each name at least one accepted claim. | `PLAN_UNGROUNDED` |
| Central claims | The thesis claims and every motif-core claim are central: each passes PD-5 (composed), and the plan rests on **at least three distinct** central claims (Method Profile section 11: "fewer than three central claims — stop and escalate, do not pad"). A claim that is both thesis and core counts once. | `CLAIM_INSUFFICIENT_SIGNALS`, `PLAN_INSUFFICIENT_CENTRAL_CLAIMS` |
| Motif count | Three to five primary motifs (Long-Form section 8: "three to five primaryMotifs where the chart supports them"; Product Owner decision, see "Interpretations"). Where the accepted claims do not carry three genuine, non-duplicative motifs, the plan is refused — never padded: recombined or overlapping cores, a repeated motif, a claim below PD-5, an invented claim and a drafted salience are each refused by their own rule. "Non-duplicative" is the claim graph's identity (ADR 0007): two differently worded claims over the same facts are two accepted claims, and detecting paraphrase is left to ETBZ-37. The count is checked after the central-claim floor: three disjoint cores always rest on three claims, so a chart that grounds fewer central claims gets the Method Profile's stop-and-escalate refusal, and too few motifs over enough claims get this one. | `PLAN_MOTIF_COUNT_OUT_OF_RANGE` |
| Disjoint cores | An accepted claim is the core of at most one primary motif. Otherwise three claims recombine into five "motifs" and one claim sits in most of them — repetition manufacturing narrative priority. The thesis may rest on core claims: it interprets the motifs, it is not one. | `PLAN_MOTIF_CORES_OVERLAP` |
| Tensions | A tension names two accepted claims the graph relates by `CONTRASTS_WITH` (either direction). The plan never creates a relation. A `CONTRASTS_WITH` the graph states between two claims the plan uses must be declared (see "Interpretations" below). | `PLAN_TENSION_NOT_IN_GRAPH`, `PLAN_TENSION_UNDECLARED` |
| Lifecycle | Chapters move motifs along `UNSEEN -> SEEDED -> DEVELOPED -> COMPLICATED -> INTEGRATED -> CLOSED`: strictly forward, skipping allowed, never back, never in place, never to `UNSEEN`. | `PLAN_ILLEGAL_MOTIF_TRANSITION` |
| Grounded movement | A chapter moves a motif only if it names one of that motif's core claims, and opens or closes a thread only if it names one of that thread's claims. Otherwise a motif is "developed" or "integrated" on paper while its meaning is never written — requirement 8 satisfied by a label. | `PLAN_MOVEMENT_UNGROUNDED` |
| No forgotten motif | A primary motif ends `INTEGRATED` or `CLOSED`, or — having been opened — is explicitly left open by a `LEAVE_OPEN` thread that names one of its core claims. A primary motif no chapter opens is forgotten before it starts. | `PLAN_MOTIF_SILENTLY_DROPPED` |
| Threads | A thread is a non-empty set of accepted claims, opened by exactly one chapter, and either closed by exactly one LATER chapter (`CLOSE`) or never closed (`LEAVE_OPEN`). It is not bound to a motif; it is *central* to a motif when it names one of that motif's core claims (Long-Form AC16: "central opened threads"). | `PLAN_THREAD_LIFECYCLE_INVALID` |
| Duplication | Refused, never merged, never counted: a repeated reference in any list; two motifs or threads under one handle; two motifs, tensions, threads or chapters with the same content. | `PLAN_DUPLICATE_REF`, `PLAN_DUPLICATE_HANDLE`, `PLAN_DUPLICATE_CONTENT` |
| Shape | `z.strictObject` throughout. A salience, weight, confidence, rank, priority or personality score; a fact, a claim, a method, a statement, a label, prose; a provider, model or run id; any derived field (version, lexicon, coverage, constraints, lifecycle, ids) — each is a refusal, not something dropped. Schema refusals name path and code, never the value. | `PLAN_SCHEMA_INVALID` |
| Consistency | A presented plan must be, byte for byte, what the builder produces from its own choices for this chart, brief, profile and graph — including a plan presented against another brief or graph, or with an edited binding hash (the cause is in the message; as ADR 0007 treats a graph of another chart). | `PLAN_NOT_INTACT` |

### Identity and order

`chapterPlan` is the reading order — the one order in a plan that is meaning.
Every other list is sorted, and every element gets a content-derived id, so
neither the drafter's list order nor its handles can become priority:

```
motif.<structuralHash({ coreClaimRefs })>
tension.<structuralHash({ claimRefs })>                 // the sorted pair
thread.<structuralHash({ claimRefs })>                  // the fate is NOT identity
chapter.<structuralHash({ narrativeOperation, claimRefs, motifTransitions,
                          opensThreadRefs, closesThreadRefs })>   // no position
```

A thread declared twice with two fates is one thread twice (refused). A chapter
repeated verbatim is refused; a later chapter may name the same claims with a
different operation or movement (a callback — whether it adds a semantic delta
is ETBZ-31/32). Each motif carries its derived `lifecycle` (chapter id and
state, in reading order) and `finalState`.

`planVersion = etbz-30.meta-narrative-plan.v1`. `structuralHash` is `sha256:` +
SHA-256 of the canonical JSON of every other field; the unit suite re-derives it
with `node:crypto`. Like the graph's, the consistency check
(`assertMetaNarrativePlanIntact`) is a consistency proof, not tamper evidence:
whoever needs to know a plan is still the one they accepted pins its hash. A
wrong context (unreleased registry, a brief not derived from the model, a
graph that is not intact) is not a damaged plan and surfaces as what it is; the
specific binding refusals come from re-building the plan's draft.

### Coverage and constraints

Both are derived, never drafted, and number-free:

- `coverage.plannedClaimRefs` — every claim the plan names anywhere;
  `unplannedClaimRefs` — accepted graph claims the plan does not use (reported,
  not refused: the contract names no completeness rule);
- `citedFactRefs` / `uncitedFactRefs` — a partition of the brief's
  **interpretable** facts by the planned claims' `factRefs`; an excluded
  (assumed-time, PD-10) fact is never offered as coverable;
- `touchedThemeRefs` / `untouchedThemeRefs` — a partition of the brief's
  primary and candidate themes by membership of a cited fact (theme
  annotations on claims are supplementary and are not used here);
- `constraints` — `allowedClaimRefs` (exactly the planned claims) and four
  literal obligations for whoever renders the plan: `newClaimsForbidden`,
  `newChartFactsForbidden`, `newClaimRelationsForbidden`,
  `epistemicClassesFixed`.

The plan carries no epistemic class and no provisional lineage of its own: a
claim is rendered with the class the graph accepted, so uncertainty cannot
change in the plan.

### ETBZ-36 — Terminology & Wording Lexicon v1

Jira ETBZ-36 is `Zu erledigen`; no lexicon page, version or identity exists in
Confluence space ETBZ. Jira ETBZ-30 (Reconcile & Refinement 2026-09-18) allows
ETBZ-30B to be implemented while the lexicon is being prepared and forbids
final ETBZ-30B merge authorisation without the versioned lexicon reference. The
plan therefore states the dependency as data:

```
terminologyLexicon: { dependency: 'ETBZ-36', status: 'UNRESOLVED' }
```

No version, page id or wording rule is invented; a drafter cannot supply a
lexicon (schema refusal); an accepted plan whose binding is edited is
`PLAN_NOT_INTACT`. The plan itself carries no customer wording at all — no
thesis statement, no motif label. Binding the released lexicon changes this
contract and every plan hash; whether that lands as a revision of this
candidate before merge or as a later `planVersion` is decided when ETBZ-36
exists — it is never an edit of an accepted plan.

## Interpretations — Product Owner review

Each began as a reading of the canonical text, and each rule is pinned by a
test and a dedicated source mutant, so that changing it is a visible decision.
Where the reading is stricter than the text, it fails closed and can be
withdrawn by removing one check. The Product Owner reviewed all nine; the
decision reached this ADR through the ETBZ-30B repair brief of 2026-09-19 and
is not yet recorded in Jira ETBZ-30 or Confluence: 2–9 are accepted unchanged;
1 was not, and is replaced by the Product Owner's rule.

1. **Motif count 3–5 — Product Owner decision.** The first reading here (1–5:
   five a ceiling, three not a floor) was not accepted. The v1 rule is three
   to five chart-supported primary motifs (Long-Form section 8), next to the
   Method Profile's "fewer than three central claims — stop and escalate, do
   not pad": a chart that cannot carry three genuine, disjoint motifs is
   refused, never padded (see the table). Each bound, the former 1–5 rule and
   a count checked before the floor are source mutants that must each be
   killed by their own named test.
2. **Disjoint motif cores** (`PLAN_MOTIF_CORES_OVERLAP`) — stricter than the
   text; read from requirement 7 (duplicate input cannot manufacture narrative
   priority), section 8 ("where the chart supports them") and the Method
   Profile's "do not pad". Found by the adversarial review: without it three
   claims make five motifs.
3. **Grounded movement** (`PLAN_MOVEMENT_UNGROUNDED`) — stricter than the text;
   read from section 8 ("a central motif may not be opened and then silently
   forgotten") and requirement 8: a transition in a chapter that names none of
   the motif's core claims would satisfy the rule on paper only.
4. **Threads are sets of claims, not motif children.** A thread is central to a
   motif when it names one of its core claims (AC16 "central opened threads"),
   and only such a thread, left open, leaves that motif explicitly open.
5. **Tension completeness** (`PLAN_TENSION_UNDECLARED`) — a `CONTRASTS_WITH` the
   graph states between two claims the plan uses must be declared. Read from
   section 8 ("known tensions / counter-motifs"), section 2 (ambivalence is
   preserved, not flattened) and section 12 (tension is explicit).
6. **Tension = `CONTRASTS_WITH` only.** `QUALIFIES` (limitation) and
   `ALTERNATIVE_READING` are not tensions in section 12's sense; the donor
   counted both.
7. **Central-claim floor counts the plan's selection** (as ADR 0007 deferred
   it). The refusal says so: where the graph holds more claims that pass PD-5
   the plan may name them; where the chart grounds fewer, stop and escalate.
8. **The thesis is its `claimRefs` only.** No thesis statement is persisted;
   rendering it is writing the referenced accepted claims together, held to
   `newClaimsForbidden` (ETBZ-38). If the PO wants the thesis synthesis
   persisted, it becomes an accepted claim of the graph (e.g. one that
   `INTEGRATES` the others) — a graph change, not a plan field.
9. **Not modelled here:** the narrative fate of a tension (resolved / left open,
   and in which chapter) and motif-level counter-motif links. A thread naming
   both claims of a tension can carry it; nothing forces one. Judging whether a
   written reading resolves a tension is chapter/QA work (ETBZ-31/32).

## Donor (PR #4) — what was and was not reused

PR #4 is `DONOR / SUPERSEDED_IMPLEMENTATION` (Rebaseline section 12). Its
`meta-narrative-plan.ts` (1383 lines) was read at
`origin/feature/ETBZ-25B-real-llm-narrative-synthesis` =
`c8a3cd23e95a099a5d2581a0e20751c5b90dd8e2`; no file, function or test was copied
or cherry-picked. Reused as concepts, re-derived against ETBZ-30A and Method
Profile v1.0.0:

- content-derived motif / thread / chapter ids without handles and without
  chapter position; thread identity without its fate;
- chapter order as the one semantic order; forward-only lifecycle with skips;
  terminal = `INTEGRATED` / `CLOSED` or explicitly left open;
- refusal of duplicate chapter content; strict draft schema; number-free
  output; permutation / rename / idempotence / independent-hash tests;
- a hard range of three to five primary motifs (first rejected here for 1–5,
  reinstated by the Product Owner decision; see "Interpretations").

Rejected as obsolete or unsupported by the current contracts: a thesis and
motif `statement` (prose in the plan) with its uncited-symbol / number / method
scanners; a thesis floor of two claims; a single
"anchor" claim per motif; thread narrative roles; a mandatory `INTEGRATE`
chapter with two claims and two motifs; mandatory coverage of every graph claim;
`QUALIFIES` / `ALTERNATIVE_READING` as tensions; the donor graph API
(`sourceBriefHash`, graph-level `relations`, `hashInterpretiveClaimGraph`); no
PD-5 at all. The version literal `etbz-30.meta-narrative-plan.v1` equals the
donor's for a different, never-merged shape; nothing of that shape is on `main`.

## Acceptance mapping (ETBZ-30B)

| Criterion | Where it is enforced / proven |
|---|---|
| Plan version, brief + graph bindings explicit and hashed | `META_NARRATIVE_PLAN_VERSION`, bindings; unit P1, P2 |
| Only accepted graph claims / declared structure referenced | negative N1, N10; unit P1 |
| PD-5 for thesis and motif cores; three central claims | negative N2; unit P7 |
| Three to five primary motifs where the chart supports them, never padded | negative N5, N5b; unit P3 |
| Canonical lifecycle; no silently forgotten central motif | negative N6, N7, N8, N12; unit P4 (derivation) |
| Brief / graph change invalidates the plan | negative N3; unit P7 |
| Order / duplicates cannot manufacture salience | negative N2, N4, N5b; unit P2 |
| No numeric score, no new fact / claim / method | negative N11; unit P1, P6 |
| Plain serialisable data, rebuild detects mutation | unit P6 |
| Guards are not decoration | `npm run guards:etbz30b` — source mutants, baseline proven green first; a kill must be an assertion failure (a timeout or a load error is reported as an error) and names the test that caught it |

## What this change deliberately does NOT do

- No `ChapterContract`, `NarrativeDelta`, `NarrativeState`, chapter prose, LLM
  call, provider routing, editorial pass, QA (ETBZ-31 / ETBZ-32), Skill
  (ETBZ-38), `PresentationProjection`, PDF or Etsy.
- No semantic-delta, callback or contradiction check on chapters: the plan
  records the intended movement; judging a written chapter is ETBZ-31/32.
- No selection: the builder never picks a thesis, a motif or a tension by
  counting anything. Numbers appear only inside refusal gates.
- No change to ETBZ-34 or ETBZ-30A code, the registry, the feature set or
  `RELEASED_REGISTRY_HASHES`.

## Consequences

- ETBZ-31 binds each `ChapterContract` to a `chapterId` of an accepted plan and
  the plan's `structuralHash`.
- ETBZ-38 can hand the Skill `BazodiacInterpretationInput v1` + graph + plan as
  plain JSON; `constraints` states what the Skill may render.
- Before ETBZ-30B merge: a released ETBZ-36 lexicon, the plan contract change
  that binds it, and PO authorisation.
- Rollback is a revert of the ETBZ-30B commits; no data migration or runtime
  mutation is involved.
