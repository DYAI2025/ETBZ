# `src/application/ports`

Interfaces the application layer requires from the outside world (outbound
ports). Concrete implementations live in `src/adapters` and are injected at the
composition root (`src/app/server.ts`).

## Declared ports

- `fufire-gateway.ts` (ETBZ-24 / ETBZ-29) - the FuFirE boundary. Implementations
  MUST fail closed: schema drift, auth failure, timeout or rejection surfaces as
  an explicit error, never as a locally computed substitute.
- `narrative-provider.ts` (ETBZ-25) - the narrative boundary. The only
  implementation in the repository is deterministic and reaches no network, no
  credential and no cost path; the port exists so that a future creative
  provider faces the same validation without the application layer changing.

A port is only introduced together with the slice that genuinely needs it -
declaring one earlier would imply a capability the service does not have. There
is still no Etsy, database, PDF renderer or delivery port.
