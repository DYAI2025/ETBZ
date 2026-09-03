# `src/domain`

The innermost layer: ETBZ business rules and invariants, expressed in plain
TypeScript.

## Dependency rule

`domain` depends on **nothing**. It may not import:

- HTTP frameworks or servers (`express`, `node:http`, ...)
- drivers, clients or SDKs (database, HTTP client, browser automation, ...)
- `src/application`, `src/adapters`, `src/http` or `src/app`

The direction is one-way:

```
http / adapters  ->  application  ->  domain
```

This is enforced by `tests/architecture/dependency-direction.test.ts`, and the
guard is proven to actually fail by the mutation proof in
`scripts/verify-guards.sh`.

## ETBZ-9 status

**Empty on purpose.** ETBZ-9 delivers the service foundation only — no business
pipeline. Inventing placeholder entities now would be a fake abstraction: the
first real domain type arrives with the first business slice that needs it.
