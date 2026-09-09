# `src/application`

Use cases and orchestration. Depends on `src/domain` and on **ports**
(interfaces) declared in `src/application/ports`, never on concrete
infrastructure.

## Dependency rule

`application` may import `src/domain`. It may not import:

- HTTP frameworks, servers, drivers, clients or SDKs
- `src/adapters`, `src/http` or `src/app`

Enforced by `tests/architecture/dependency-direction.test.ts`.

## Contents

- `horoscope-model.ts` (ETBZ-24 / ETBZ-29) — the consumer-owned product fact:
  FuFirE snapshots in, immutable `HoroscopeModel` out, fail-closed on any
  symbol, day-master, precision or natal contradiction.
- `horoscope-use-case.ts` (ETBZ-24) — validate first, then call the gateway.
- `ports/fufire-gateway.ts` — the FuFirE boundary as the application sees it.
- `ports/narrative-provider.ts` (ETBZ-25) — the narrative boundary. No
  implementation behind it reaches a network, a credential or a cost path.
- `interpretation/` (ETBZ-25) — the free, deterministic narrative core:

  ```
  HoroscopeModel -> InterpretationFeatureSet -> ThemeGraph
                 -> PrimaryThemeProjection -> NarrativeBrief
                 -> NarrativeProvider -> validated ReportModel
  ```

  The five ARTEFACTS - feature set, theme graph, primary projection, brief and
  report - are each produced by a pure function and each carry a structural
  hash; the provider in the middle is a boundary, not a hashed stage, and is
  assumed untrusted. Facts are copied verbatim with their source path; themes
  are set groupings, never readings; the brief is the only thing a provider
  sees; and `report-model.ts` re-derives the chain from the HoroscopeModel
  before it accepts a sentence.

  **Two theme layers, and what each is for.** `theme-graph.ts` produces the
  exhaustive CANDIDATE graph: one node per pillar, the day master, the month
  command, every Ten God and every Wu Xing element the chart names. That is the
  right shape for a structural index and the wrong shape for a sold report, so
  `primary-theme.ts` projects those candidates onto exactly four v1 PRIMARY
  families - `self_role`, `seasonal_anchor`, `elemental_profile`,
  `positional_context`. Only a primary theme may become a report section; a
  section naming a candidate id is refused
  (`REPORT_CANDIDATE_THEME_NOT_NARRATABLE`), and the section count is held
  between `SPECIFICITY_POLICY.minSections` and `maxSections`.

  The four family names are ETBZ grouping categories, not astrological terms:
  they say WHERE a fact was read from, never what it means, and nothing in the
  projection is a strength, favourability, ranking or selection. Nothing is
  discarded either - every candidate theme belongs to exactly one family, the
  complete candidate graph and its edges travel in the brief as nuance, and the
  primary layer's fact union equals the candidate layer's.

  **What this core does NOT prove.** The guards are structural: they prove a
  sentence is ATTACHED to cited facts of this chart, not that it means the right
  thing. Two semantic failure modes survive every check here and are documented
  as required future Narrative-QA gates rather than silently implied to be
  covered:

  1. a cited symbol can still be given the wrong linguistic role in free prose;
  2. a provider can attach a structurally correct uncertainty note while the
     prose beside it expresses certainty.

`/health` and `/ready` remain foundation concerns owned by `src/app`, not
business use cases, and are deliberately not modelled here.
