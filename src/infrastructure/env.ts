/**
 * Which environment class this process is running as (blueprint B13,
 * decision D16).
 *
 * The rules themselves live in `env-check.ts`, which is pure and takes the
 * environment as an argument so it can be unit-tested without a process. This
 * file is the one line of impurity: it reads `APP_ENV` and hands it over.
 *
 * `APP_ENV` is set in `wrangler.jsonc` `vars` for every hosted environment and
 * in `.env` locally. An unset value means the Node dev server (B13); a value
 * that is set but unknown is already rejected at startup by the environment
 * plugin (T03), so the fallback below only keeps this function total.
 */

import type { EnvironmentClass } from "./env-check";
import { resolveEnvironmentClass } from "./env-check";

export function readAppEnv(): EnvironmentClass {
  // guard:allow-env-credential — environment class selection, value is never logged
  const appEnv = process.env.APP_ENV;
  return resolveEnvironmentClass({ APP_ENV: appEnv }) ?? "local";
}
