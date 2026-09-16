/**
 * Job domain model (blueprint B4).
 *
 * Plain object plus pure functions: no I/O, no `Date.now()` — time is always an
 * argument (`now`) so every caller controls it and tests stay deterministic.
 * Every mutation returns a new object with `version: previous.version + 1` and
 * `updatedAt: now`; nothing here mutates its input.
 */

import { DomainError } from "./errors";

export type JobStatus = "scheduled" | "in_progress" | "completed" | "archived";

export interface Job {
  id: string;
  orgId: string;
  customerId: string;
  title: string;
  description: string;
  status: JobStatus;
  scheduledAt: string;
  assignedTo: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  accountingReference: string | null;
  accountingSentAt: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewJobInput {
  id: string;
  orgId: string;
  customerId: string;
  title: string;
  description?: string;
  scheduledAt: string;
  assignedTo?: string | null;
  createdBy: string;
  now: string;
}

/**
 * The status transitions each job status may move to. Forms both the check
 * used by the transition functions below and the source of truth `undoOperation`
 * / `redoOperation` (T10) read when deciding what is reachable.
 */
export const JOB_TRANSITIONS: Readonly<
  Record<JobStatus, readonly JobStatus[]>
> = {
  scheduled: ["in_progress", "completed", "archived"],
  in_progress: ["completed", "archived"],
  completed: ["archived"],
  archived: [],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_TITLE_LENGTH = 1;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;

/** Trimmed length 1..200; the trimmed value is what gets stored. */
function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < MIN_TITLE_LENGTH || trimmed.length > MAX_TITLE_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Job title must be between ${MIN_TITLE_LENGTH} and ${MAX_TITLE_LENGTH} characters`,
    );
  }
  return trimmed;
}

function normalizeDescription(description: string | undefined): string {
  const value = description ?? "";
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new DomainError(
      "VALIDATION",
      `Job description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  return value;
}

/** Parses with `Date.parse` and re-serialises with `toISOString()`; the
 * normalised value is what gets stored. */
function normalizeScheduledAt(scheduledAt: string): string {
  const parsed = Date.parse(scheduledAt);
  if (Number.isNaN(parsed)) {
    throw new DomainError("VALIDATION", "Job scheduledAt must be a valid date");
  }
  return new Date(parsed).toISOString();
}

/** `null`/`undefined` mean "unassigned"; otherwise it must be a lower-cased
 * email matching the shared pattern. */
function normalizeAssignedTo(
  assignedTo: string | null | undefined,
): string | null {
  if (assignedTo === null || assignedTo === undefined) return null;
  if (!EMAIL_PATTERN.test(assignedTo)) {
    throw new DomainError(
      "VALIDATION",
      "Job assignedTo must be a valid email address",
    );
  }
  return assignedTo.toLowerCase();
}

/** Throws `INVARIANT "Cannot <verb> a job that is <status>"` unless `target`
 * is reachable from `job.status` per `JOB_TRANSITIONS`. */
function assertTransition(job: Job, target: JobStatus, verb: string): void {
  if (!JOB_TRANSITIONS[job.status].includes(target)) {
    throw new DomainError(
      "INVARIANT",
      `Cannot ${verb} a job that is ${job.status}`,
    );
  }
}

export function createJob(input: NewJobInput): Job {
  return {
    id: input.id,
    orgId: input.orgId,
    customerId: input.customerId,
    title: normalizeTitle(input.title),
    description: normalizeDescription(input.description),
    status: "scheduled",
    scheduledAt: normalizeScheduledAt(input.scheduledAt),
    assignedTo: normalizeAssignedTo(input.assignedTo),
    completedAt: null,
    archivedAt: null,
    accountingReference: null,
    accountingSentAt: null,
    version: 1,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Allowed from `scheduled` only. */
export function startJob(job: Job, now: string): Job {
  assertTransition(job, "in_progress", "start");
  return {
    ...job,
    status: "in_progress",
    version: job.version + 1,
    updatedAt: now,
  };
}

/** Allowed from `scheduled` or `in_progress`; sets `completedAt`. */
export function completeJob(job: Job, now: string): Job {
  assertTransition(job, "completed", "complete");
  return {
    ...job,
    status: "completed",
    completedAt: now,
    version: job.version + 1,
    updatedAt: now,
  };
}

/** Allowed from `scheduled` or `in_progress`; `INVARIANT` if the new instant is
 * identical to the current one. */
export function rescheduleJob(job: Job, scheduledAt: string, now: string): Job {
  if (job.status !== "scheduled" && job.status !== "in_progress") {
    throw new DomainError(
      "INVARIANT",
      `Cannot reschedule a job that is ${job.status}`,
    );
  }
  const normalized = normalizeScheduledAt(scheduledAt);
  if (normalized === job.scheduledAt) {
    throw new DomainError("INVARIANT", "Job is already scheduled at that time");
  }
  return {
    ...job,
    scheduledAt: normalized,
    version: job.version + 1,
    updatedAt: now,
  };
}

/** Allowed from any status except `archived`; sets `archivedAt`. */
export function archiveJob(job: Job, now: string): Job {
  assertTransition(job, "archived", "archive");
  return {
    ...job,
    status: "archived",
    archivedAt: now,
    version: job.version + 1,
    updatedAt: now,
  };
}

/**
 * Restores a previously recorded status (and the `completedAt`/`archivedAt`
 * pair that goes with it) with no transition-rule check. Used by
 * `undoOperation` (B9) to reverse `start-job`, `complete-job` and
 * `archive-job`; the version is still bumped like any other mutation.
 */
export function restoreJobStatus(
  job: Job,
  previous: {
    status: JobStatus;
    completedAt: string | null;
    archivedAt: string | null;
  },
  now: string,
): Job {
  return {
    ...job,
    status: previous.status,
    completedAt: previous.completedAt,
    archivedAt: previous.archivedAt,
    version: job.version + 1,
    updatedAt: now,
  };
}

/**
 * Restores a previous `scheduledAt`, used by `undoOperation` (B9) to reverse
 * `reschedule-job`. Unlike `rescheduleJob`, it does not check the "already
 * scheduled at that time" rule — undo must be able to restore the exact
 * instant it recorded — it only refuses an archived job.
 */
export function restoreJobSchedule(
  job: Job,
  scheduledAt: string,
  now: string,
): Job {
  if (job.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "Cannot reschedule a job that is archived",
    );
  }
  return {
    ...job,
    scheduledAt: normalizeScheduledAt(scheduledAt),
    version: job.version + 1,
    updatedAt: now,
  };
}

/** `INVARIANT` unless `status === "completed"` and `accountingReference ===
 * null`; sets `accountingReference`/`accountingSentAt`. */
export function markSentToAccounting(
  job: Job,
  reference: string,
  now: string,
): Job {
  if (job.status !== "completed") {
    throw new DomainError(
      "INVARIANT",
      `Cannot send to accounting a job that is ${job.status}`,
    );
  }
  if (job.accountingReference !== null) {
    throw new DomainError("INVARIANT", "Job was already sent to accounting");
  }
  return {
    ...job,
    accountingReference: reference,
    accountingSentAt: now,
    version: job.version + 1,
    updatedAt: now,
  };
}

/** Finishes a durable pending export. Unlike the initial eligibility check,
 * reconciliation remains valid after the job was archived. */
export function reconcileAccountingExport(
  job: Job,
  reference: string,
  now: string,
): Job {
  if (
    job.accountingReference !== null &&
    job.accountingReference !== reference
  ) {
    throw new DomainError(
      "INVARIANT",
      "Job was sent to a different accounting reference",
    );
  }
  return {
    ...job,
    accountingReference: reference,
    accountingSentAt: job.accountingSentAt ?? now,
    version: job.version + 1,
    updatedAt: now,
  };
}
