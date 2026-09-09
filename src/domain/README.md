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

## Contents

- `birth-input.ts` (ETBZ-24) — the validated entry fact; never invents a
  birth time, never lets a caller steer transport.
- `sizhu.ts` (ETBZ-24 / ETBZ-29) — the released Sizhu symbol mapping
  (ADR-0003) and the element vocabulary bridge. A lookup table, not a
  calculator.
- `canonical-json.ts` (ETBZ-24) — deterministic canonicalization for stable
  evidence hashes.
- `structural-hash.ts` (ETBZ-25) — SHA-256 over that canonical text. This
  layer may import nothing, so `node:crypto` is unreachable here and the digest
  is written out in plain TypeScript; `tests/unit/structural-hash.test.ts`
  measures it against `node:crypto` across every padding boundary and the
  multi-byte text this repository actually carries. It is a structural
  fingerprint for change detection, never a security boundary.

What the dependency guard actually enforces here is the import allowlist above:
no file, network or driver module can be reached from this layer, because no
bare specifier may be imported at all. Freedom from a clock is a convention of
this layer rather than a gated property - `birth-input.ts` constructs fixed
`Date` values for calendar and timezone validation and reads no current time,
but no test asserts that, so it is stated here as intent, not as a checked
claim.

New domain types arrive with the slice that needs them, never as placeholders.
