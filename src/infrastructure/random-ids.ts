/**
 * The real id generator (blueprint B3, B7).
 *
 * Ids are opaque `crypto.randomUUID()` strings, never sequential: an id that
 * counts leaks how many customers an organization has, and a guessable id in a
 * multi-tenant URL is one authorization bug away from being a data leak.
 *
 * `node:crypto` rather than the global, because that is the import the layer
 * rules allow (B2) and it resolves the same on the Node dev server and on
 * Workers, which run with `nodejs_compat`.
 *
 * Tests use `tests/fixtures/in-memory.ts`'s fixed sequence instead; nothing in
 * the repository asserts on a value produced here.
 */

import { randomUUID } from "node:crypto";

import type { IdGenerator } from "../application/ports";

export const randomIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};
