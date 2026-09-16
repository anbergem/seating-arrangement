import { describe, expect, it } from "vitest";

import {
  archiveJob,
  completeJob,
  createJob,
  DomainError,
  JOB_TRANSITIONS,
  markSentToAccounting,
  rescheduleJob,
  restoreJobSchedule,
  restoreJobStatus,
  startJob,
  type Job,
  type NewJobInput,
} from "../../../src/domain";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const evenLater = "2026-01-03T00:00:00.000Z";

function baseInput(overrides: Partial<NewJobInput> = {}): NewJobInput {
  return {
    id: "job_1",
    orgId: "org_1",
    customerId: "cus_1",
    title: "Fix sink",
    scheduledAt: "2026-01-10T08:00:00.000Z",
    createdBy: "owner@example.invalid",
    now,
    ...overrides,
  };
}

describe("createJob", () => {
  it("creates a scheduled job at version 1 with defaults", () => {
    const job = createJob(baseInput());
    expect(job).toEqual<Job>({
      id: "job_1",
      orgId: "org_1",
      customerId: "cus_1",
      title: "Fix sink",
      description: "",
      status: "scheduled",
      scheduledAt: "2026-01-10T08:00:00.000Z",
      assignedTo: null,
      completedAt: null,
      archivedAt: null,
      accountingReference: null,
      accountingSentAt: null,
      version: 1,
      createdBy: "owner@example.invalid",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("trims the title and stores the trimmed value", () => {
    const job = createJob(baseInput({ title: "  Fix sink  " }));
    expect(job.title).toBe("Fix sink");
  });

  it("rejects a title that is empty after trimming", () => {
    expect(() => createJob(baseInput({ title: "   " }))).toThrow(DomainError);
    expect(() => createJob(baseInput({ title: "   " }))).toThrow(
      "Job title must be between 1 and 200 characters",
    );
  });

  it("rejects a title longer than 200 characters", () => {
    expect(() => createJob(baseInput({ title: "a".repeat(201) }))).toThrow(
      "Job title must be between 1 and 200 characters",
    );
  });

  it("accepts a title at the 200 character boundary", () => {
    const job = createJob(baseInput({ title: "a".repeat(200) }));
    expect(job.title).toHaveLength(200);
  });

  it("accepts a description at the 5000 character boundary", () => {
    const job = createJob(baseInput({ description: "d".repeat(5000) }));
    expect(job.description).toHaveLength(5000);
  });

  it("rejects a description longer than 5000 characters", () => {
    expect(() =>
      createJob(baseInput({ description: "d".repeat(5001) })),
    ).toThrow("Job description must be at most 5000 characters");
  });

  it("normalises scheduledAt with Date.parse/toISOString", () => {
    const job = createJob(
      baseInput({ scheduledAt: "2026-01-10T09:00:00+01:00" }),
    );
    expect(job.scheduledAt).toBe("2026-01-10T08:00:00.000Z");
  });

  it("rejects a scheduledAt that Date.parse cannot parse", () => {
    expect(() => createJob(baseInput({ scheduledAt: "not-a-date" }))).toThrow(
      "Job scheduledAt must be a valid date",
    );
  });

  it("lower-cases a valid assignedTo email", () => {
    const job = createJob(baseInput({ assignedTo: "Member@Example.Invalid" }));
    expect(job.assignedTo).toBe("member@example.invalid");
  });

  it("rejects a malformed assignedTo", () => {
    expect(() => createJob(baseInput({ assignedTo: "not-an-email" }))).toThrow(
      "Job assignedTo must be a valid email address",
    );
  });
});

describe("JOB_TRANSITIONS", () => {
  it("matches the blueprint table exactly", () => {
    expect(JOB_TRANSITIONS).toEqual({
      scheduled: ["in_progress", "completed", "archived"],
      in_progress: ["completed", "archived"],
      completed: ["archived"],
      archived: [],
    });
  });
});

describe("startJob", () => {
  it("moves a scheduled job to in_progress and bumps the version", () => {
    const job = createJob(baseInput());
    const started = startJob(job, later);
    expect(started.status).toBe("in_progress");
    expect(started.version).toBe(2);
    expect(started.updatedAt).toBe(later);
  });

  it("refuses to start a job that is already in_progress", () => {
    const started = startJob(createJob(baseInput()), later);
    expect(() => startJob(started, evenLater)).toThrow(DomainError);
    expect(() => startJob(started, evenLater)).toThrow(
      "Cannot start a job that is in_progress",
    );
  });

  it("refuses to start a completed job", () => {
    const completed = completeJob(createJob(baseInput()), later);
    expect(() => startJob(completed, evenLater)).toThrow(
      "Cannot start a job that is completed",
    );
  });

  it("refuses to start an archived job", () => {
    const archived = archiveJob(createJob(baseInput()), later);
    expect(() => startJob(archived, evenLater)).toThrow(
      "Cannot start a job that is archived",
    );
  });
});

describe("completeJob", () => {
  it("completes a scheduled job, sets completedAt and bumps the version", () => {
    const job = createJob(baseInput());
    const completed = completeJob(job, later);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(later);
    expect(completed.version).toBe(2);
  });

  it("completes an in_progress job", () => {
    const started = startJob(createJob(baseInput()), later);
    const completed = completeJob(started, evenLater);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(evenLater);
    expect(completed.version).toBe(3);
  });

  it("refuses to complete an already-completed job", () => {
    const completed = completeJob(createJob(baseInput()), later);
    expect(() => completeJob(completed, evenLater)).toThrow(
      "Cannot complete a job that is completed",
    );
  });

  it("refuses to complete an archived job", () => {
    const archived = archiveJob(createJob(baseInput()), later);
    expect(() => completeJob(archived, evenLater)).toThrow(
      "Cannot complete a job that is archived",
    );
  });
});

describe("rescheduleJob", () => {
  it("reschedules a scheduled job and bumps the version", () => {
    const job = createJob(baseInput());
    const rescheduled = rescheduleJob(job, "2026-02-01T08:00:00.000Z", later);
    expect(rescheduled.scheduledAt).toBe("2026-02-01T08:00:00.000Z");
    expect(rescheduled.version).toBe(2);
    expect(rescheduled.updatedAt).toBe(later);
  });

  it("reschedules an in_progress job", () => {
    const started = startJob(createJob(baseInput()), later);
    const rescheduled = rescheduleJob(
      started,
      "2026-02-01T08:00:00.000Z",
      evenLater,
    );
    expect(rescheduled.scheduledAt).toBe("2026-02-01T08:00:00.000Z");
    expect(rescheduled.version).toBe(3);
  });

  it("refuses to reschedule a completed job", () => {
    const completed = completeJob(createJob(baseInput()), later);
    expect(() =>
      rescheduleJob(completed, "2026-02-01T08:00:00.000Z", evenLater),
    ).toThrow("Cannot reschedule a job that is completed");
  });

  it("refuses to reschedule an archived job", () => {
    const archived = archiveJob(createJob(baseInput()), later);
    expect(() =>
      rescheduleJob(archived, "2026-02-01T08:00:00.000Z", evenLater),
    ).toThrow("Cannot reschedule a job that is archived");
  });

  it("refuses to reschedule to the identical instant", () => {
    const job = createJob(baseInput());
    expect(() => rescheduleJob(job, "2026-01-10T08:00:00.000Z", later)).toThrow(
      "Job is already scheduled at that time",
    );
  });

  it("refuses to reschedule to the identical instant expressed with a different offset", () => {
    const job = createJob(baseInput());
    expect(() =>
      rescheduleJob(job, "2026-01-10T09:00:00+01:00", later),
    ).toThrow("Job is already scheduled at that time");
  });
});

describe("archiveJob", () => {
  it("archives a scheduled job, sets archivedAt and bumps the version", () => {
    const job = createJob(baseInput());
    const archived = archiveJob(job, later);
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).toBe(later);
    expect(archived.version).toBe(2);
  });

  it("archives an in_progress job", () => {
    const started = startJob(createJob(baseInput()), later);
    const archived = archiveJob(started, evenLater);
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(3);
  });

  it("archives a completed job", () => {
    const completed = completeJob(createJob(baseInput()), later);
    const archived = archiveJob(completed, evenLater);
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(3);
  });

  it("refuses to archive an already-archived job", () => {
    const archived = archiveJob(createJob(baseInput()), later);
    expect(() => archiveJob(archived, evenLater)).toThrow(
      "Cannot archive a job that is archived",
    );
  });
});

describe("restoreJobStatus", () => {
  it("restores the previous status and clears completedAt set by completeJob", () => {
    const scheduled = createJob(baseInput());
    const previous = {
      status: scheduled.status,
      completedAt: scheduled.completedAt,
      archivedAt: scheduled.archivedAt,
    };
    const completed = completeJob(scheduled, later);
    expect(completed.completedAt).not.toBeNull();

    const restored = restoreJobStatus(completed, previous, evenLater);
    expect(restored.status).toBe("scheduled");
    expect(restored.completedAt).toBeNull();
    expect(restored.version).toBe(3);
    expect(restored.updatedAt).toBe(evenLater);
  });

  it("restores the previous status and clears archivedAt set by archiveJob, keeping completedAt", () => {
    const completed = completeJob(createJob(baseInput()), later);
    const previous = {
      status: completed.status,
      completedAt: completed.completedAt,
      archivedAt: completed.archivedAt,
    };
    const archived = archiveJob(completed, evenLater);
    expect(archived.archivedAt).not.toBeNull();

    const restored = restoreJobStatus(
      archived,
      previous,
      "2026-01-04T00:00:00.000Z",
    );
    expect(restored.status).toBe("completed");
    expect(restored.archivedAt).toBeNull();
    expect(restored.completedAt).toBe(later);
    expect(restored.version).toBe(4);
  });

  it("bypasses transition rules (no check on the current status)", () => {
    const archived = archiveJob(createJob(baseInput()), later);
    const restored = restoreJobStatus(
      archived,
      { status: "scheduled", completedAt: null, archivedAt: null },
      evenLater,
    );
    expect(restored.status).toBe("scheduled");
    expect(restored.archivedAt).toBeNull();
  });
});

describe("restoreJobSchedule", () => {
  it("restores a previous scheduledAt and bumps the version", () => {
    const job = createJob(baseInput());
    const rescheduled = rescheduleJob(job, "2026-02-01T08:00:00.000Z", later);
    const restored = restoreJobSchedule(
      rescheduled,
      job.scheduledAt,
      evenLater,
    );
    expect(restored.scheduledAt).toBe(job.scheduledAt);
    expect(restored.version).toBe(3);
    expect(restored.updatedAt).toBe(evenLater);
  });

  it("bypasses the identical-instant rule", () => {
    const job = createJob(baseInput());
    const restored = restoreJobSchedule(job, job.scheduledAt, later);
    expect(restored.scheduledAt).toBe(job.scheduledAt);
    expect(restored.version).toBe(2);
  });

  it("refuses to restore the schedule of an archived job", () => {
    const archived = archiveJob(createJob(baseInput()), later);
    expect(() =>
      restoreJobSchedule(archived, "2026-02-01T08:00:00.000Z", evenLater),
    ).toThrow("Cannot reschedule a job that is archived");
  });
});

describe("markSentToAccounting", () => {
  it("sets accountingReference/accountingSentAt on a completed job", () => {
    const completed = completeJob(createJob(baseInput()), later);
    const sent = markSentToAccounting(completed, "INV-1", evenLater);
    expect(sent.accountingReference).toBe("INV-1");
    expect(sent.accountingSentAt).toBe(evenLater);
    expect(sent.version).toBe(3);
  });

  it("refuses to send a job that is not completed", () => {
    const job = createJob(baseInput());
    expect(() => markSentToAccounting(job, "INV-1", later)).toThrow(
      "Cannot send to accounting a job that is scheduled",
    );
  });

  it("refuses to send a job that was already sent", () => {
    const completed = completeJob(createJob(baseInput()), later);
    const sent = markSentToAccounting(completed, "INV-1", evenLater);
    expect(() =>
      markSentToAccounting(sent, "INV-2", "2026-01-04T00:00:00.000Z"),
    ).toThrow("Job was already sent to accounting");
  });
});
