CREATE TABLE customers (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email TEXT,
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 5000),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, id)
);
CREATE INDEX customers_org_status_name_idx ON customers (org_id, status, name);

CREATE TABLE jobs (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'in_progress', 'completed', 'archived')),
  scheduled_at TEXT NOT NULL,
  assigned_to TEXT,
  completed_at TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id)
);
CREATE INDEX jobs_org_status_scheduled_idx ON jobs (org_id, status, scheduled_at);
CREATE INDEX jobs_org_customer_idx ON jobs (org_id, customer_id);

CREATE TABLE operations (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('forward', 'undo', 'redo')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('customer', 'job')),
  resource_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('reversible', 'compensatable', 'irreversible')),
  version_before INTEGER NOT NULL,
  version_after INTEGER NOT NULL,
  payload TEXT,
  inverse TEXT,
  related_operation_id TEXT,
  undone_by_operation_id TEXT,
  performed_by TEXT NOT NULL,
  performed_via TEXT NOT NULL,
  performed_at TEXT NOT NULL,
  UNIQUE (org_id, id)
);
CREATE INDEX operations_org_resource_idx ON operations (org_id, resource_type, resource_id, performed_at);
CREATE INDEX operations_org_performed_idx ON operations (org_id, performed_at);

CREATE TABLE idempotency_keys (
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, action, key)
);
