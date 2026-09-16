# T05 — Application core: errors, authorization, actor, ports, in-memory doubles

Goal: the application layer's cross-cutting pieces and the in-memory dependency set that every
use-case test uses.

Depends on: T04. Read: B5, B6, B7, B12 (constants only), B13 (env-check rules); D09, D10, D16.

## Steps

1. `src/application/errors.ts` per B5 (`AppError`, `AppErrorCode`, `HTTP_STATUS_FOR`,
   `fromDomainError`, `toAppError(unknown): AppError`).
2. `src/application/authorization.ts` per B6.
3. `src/application/actor.ts` per B7 (`Actor`, `RawContext`, `resolveActor`).
4. `src/application/ports.ts` per B7 (all interfaces, `Dependencies`).
5. `src/infrastructure/env-check.ts`: `validateEnvironment(env)` implementing B13's startup
   rules; returns an array of violation strings (empty = ok). Pure; no I/O.
6. `tests/fixtures/in-memory.ts`: `createInMemoryDependencies(options?: { now?: string; ids?: string[] })`
   returning `Dependencies` plus `state` (maps of customers, jobs, operations, idempotency, and
   `memberships: Map<orgId, Map<email, Role>>`). Behaviour must mirror B7/B11: `getById` and
   `list` filter by `orgId`; `create` for jobs fails NOT_FOUND unless the customer exists in the
   same org and is active; `commit` throws CONFLICT unless the stored version equals
   `expectedVersion`, then stores the resource, inserts the operation, and applies `markUndone`;
   idempotency `find`; a fixed clock (default `2026-09-06T12:00:00.000Z`) and a sequential id
   generator (`id-1`, `id-2`, ...) unless overridden.
7. `tests/fixtures/scenario.ts` **constants only** for now (exact values from B12: org ids and
   names, user emails and roles, customer and job ids/titles/statuses/versions). The SQL
   builders come in T11. Export `seedInMemory(deps)` that loads the scenario into the in-memory
   state (memberships, customers, jobs, operations) so use-case tests can start from it.
8. Tests: `tests/unit/application/authorization.test.ts` (full role × capability matrix as a
   table test; `requireCapability` throws AUTHORIZATION with the exact message);
   `actor.test.ts` (four cases from B7); `errors.test.ts` (`HTTP_STATUS_FOR` complete,
   `fromDomainError` mapping, `toAppError` wraps unknown errors as INTERNAL with message
   `Unexpected error`); `tests/unit/infrastructure/env-check.test.ts` against the existing pure function from T03
   (`validateEnvironment`, `resolveEnvironmentClass`): production missing each required var →
   one violation each; production with `SEED_ENABLED=1` → violation but `SEED_ENABLED=0` → none;
   production with `DATABASE_URL` present → violation; local with `DATABASE_URL=libsql://x` →
   violation; `APP_ENV=production` combined with a local file database → violation; unknown
   `APP_ENV` → violation; missing `APP_ENV` → resolves to `local`; a correct production env →
   empty array; every violation string contains no value from the input.

## Deliverables

`src/application/{errors,authorization,actor,ports}.ts`, `src/infrastructure/env-check.ts`,
`tests/fixtures/{in-memory,scenario}.ts`, `tests/unit/application/*.test.ts`,
`tests/unit/infrastructure/env-check.test.ts`.

## Acceptance

```bash
pnpm check
pnpm test:unit
```
