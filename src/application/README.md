# `src/application`

Use cases and orchestration. Depends on `src/domain` and on **ports**
(interfaces) declared in `src/application/ports`, never on concrete
infrastructure.

## Dependency rule

`application` may import `src/domain`. It may not import:

- HTTP frameworks, servers, drivers, clients or SDKs
- `src/adapters`, `src/http` or `src/app`

Enforced by `tests/architecture/dependency-direction.test.ts`.

## ETBZ-9 status

**Empty on purpose.** No use case exists yet. `/health` and `/ready` are
foundation concerns owned by `src/app`, not business use cases, so they are
deliberately not modelled here.
