export type JobStatus = "scheduled" | "in_progress" | "completed" | "archived";

export interface Job {
  id: string;
  customerId: string;
  customerName?: string;
  title: string;
  description: string | null;
  scheduledAt: string;
  assignedTo: string | null;
  status: JobStatus;
  version: number;
  completedAt: string | null;
  archivedAt: string | null;
  accountingReference?: string | null;
}
