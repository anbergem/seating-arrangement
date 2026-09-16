ALTER TABLE jobs ADD COLUMN accounting_reference TEXT;
ALTER TABLE jobs ADD COLUMN accounting_sent_at TEXT;

CREATE TABLE accounting_exports (
  org_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  external_reference TEXT,
  operation_id TEXT,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (org_id, job_id),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX accounting_exports_org_status_idx
  ON accounting_exports (org_id, status, requested_at);
