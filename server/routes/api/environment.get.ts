import { defineEventHandler } from "h3";

import { readAppEnv } from "../../../src/infrastructure/env";

/**
 * Which environment class this deployment is, for the signed-in app's label.
 *
 * Asked at runtime rather than compiled in, because one build is promoted from
 * staging to production (D21): a label baked in at build time would follow the
 * artifact into production. Behind sign-in like every other route — the
 * sign-in page labels itself on the server (`server/plugins/auth.ts`) and does
 * not need this. The answer is a fixed enum, never a configured value.
 */
export default defineEventHandler(() => ({ environment: readAppEnv() }));
