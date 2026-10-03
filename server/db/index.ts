// The framework's typed Drizzle client over the app-owned schema (F8).
//
// Kept because the framework expects it; application code does not use it. Repositories go
// through `getDbExec()` with hand-written parameterized SQL, applied by `runAtomic`
// (`src/infrastructure/sql/atomic.ts`), so the same statements run against PostgreSQL and
// against the local SQLite file — see D07.

import { createGetDb } from "@agent-native/core/db";

import * as schema from "./schema";

export const getDb = createGetDb(schema);
