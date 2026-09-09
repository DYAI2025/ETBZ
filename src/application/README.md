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
  HoroscopeModel -> InterpretationFeatureSet -> ThemeGraph -> NarrativeBrief
                 -> NarrativeProvider -> validated ReportModel
  ```

  The four ARTEFACTS - feature set, theme graph, brief and report - are each
  produced by a pure function and each carry a structural hash; the provider in
  the middle is a boundary, not a hashed stage, and is assumed untrusted. Facts
  are copied verbatim with their source path; themes are set groupings, never
  readings; the brief is the only thing a provider sees; and `report-model.ts`
  re-derives the chain from the HoroscopeModel before it accepts a sentence.

`/health` and `/ready` remain foundation concerns owned by `src/app`, not
business use cases, and are deliberately not modelled here.
