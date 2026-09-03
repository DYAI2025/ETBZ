# `src/adapters`

Concrete implementations of `src/application/ports` — the driven side of the
hexagon (outbound infrastructure). Adapters may depend on `application` and
`domain`; nothing may depend on an adapter except the composition root.

## ETBZ-9 status

**Empty on purpose.** Out of scope for ETBZ-9 and explicitly excluded:
FuFirE adapters or network calls, Etsy, webhooks, receipt handling, SQLite
business persistence, job state, idempotency, PDF/WeasyPrint/Chromium,
approval and delivery.

The inbound HTTP adapter for `/health` and `/ready` lives in `src/http`.
