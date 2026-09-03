# `src/application/ports`

Interfaces the application layer requires from the outside world (outbound
ports). Concrete implementations live in `src/adapters` and are injected at the
composition root (`src/app/server.ts`).

## ETBZ-9 status

**Empty on purpose.** ETBZ-9 has no outbound dependency: no FuFirE, no Etsy, no
database, no PDF renderer, no delivery channel. A port is only introduced
together with the slice that genuinely needs it — declaring one now would imply
a capability the service does not have.
