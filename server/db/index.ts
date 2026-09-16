// The framework's typed Drizzle client over the app-owned schema (F8).
//
// Kept because the framework expects it; application code does not use it. Repositories go
// through `getDbExec()` with hand-written parameterized SQL so that the same statements run
// on D1 (`atomicBatch`) and on the local SQLite file (`transaction`) — see D07.

import { createGetDb } from "@agent-native/core/db";

import * as schema from "./schema";

export const getDb = createGetDb(schema);
