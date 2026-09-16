/**
 * The two framework-owned tables the hermetic Node integration database needs.
 *
 * This is copied from @agent-native/core 0.176.5's org migrations (v1001,
 * v1002 and v1010), after inspecting that installed version.  The application
 * migrations intentionally do not own these tables, and no integration test
 * starts the framework server that would normally apply them.
 */

export const FRAMEWORK_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS org_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    UNIQUE(org_id, email)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_lower_email_uidx
    ON org_members (org_id, LOWER(email))`,
] as const;
