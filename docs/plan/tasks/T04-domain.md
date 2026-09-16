# T04 — Domain layer

Goal: the pure domain model for customers, jobs and operations, with exhaustive unit tests.

Depends on: T01. Read: B3, B4; D08.

## Steps

1. Create `src/domain/errors.ts`, `src/domain/customer.ts`, `src/domain/job.ts`,
   `src/domain/operation.ts`, `src/domain/index.ts` exactly with the exported names and
   signatures in B4. Add `restoreJobSchedule(job, scheduledAt, now)` (used by undo; allowed when
   status is not archived; version + 1) to `job.ts`. Add `payload: Record<string, unknown> | null`
   to `Operation` (B9 step 5).
2. Validation rules (throw `DomainError("VALIDATION", ...)`): customer name trimmed length 1–200;
   email, when present, matches `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` and is stored lower-cased; phone
   ≤ 40; notes ≤ 5000; job title trimmed 1–200; description ≤ 5000 (default `""`); `scheduledAt`
   parses with `Date.parse` and re-serialises with `toISOString()` (store the normalised value);
   `assignedTo`, when present, is a lower-cased email by the same regex.
3. Transition rules per `JOB_TRANSITIONS`; violations throw `DomainError("INVARIANT",
   "Cannot <verb> a job that is <status>")`. `rescheduleJob` to the identical instant throws
   INVARIANT "Job is already scheduled at that time".
4. `canUndo` per B4.
5. Tests in `tests/unit/domain/customer.test.ts`, `job.test.ts`, `operation.test.ts` covering:
   every validation rule (valid and invalid), every allowed transition, every forbidden
   transition, version increments, `completedAt`/`archivedAt` set and cleared by
   `restoreJobStatus`, `canUndo` for all four failure reasons and the success case.

## Deliverables

`src/domain/*.ts`, `tests/unit/domain/*.test.ts`; remove `src/domain/.gitkeep`.

## Acceptance

```bash
pnpm check
pnpm test:unit -- tests/unit/domain
node scripts/check-boundaries.mjs
```
