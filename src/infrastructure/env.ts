/**
 * Which environment class this process is running as (blueprint B13,
 * decision D16).
 *
 * The rules themselves live in `env-check.ts`, which is pure and takes the
 * environment as an argument so it can be unit-tested without a process. This
 * file is the one line of impurity: it reads `APP_ENV` and hands it over.
 *
 * `APP_ENV` is set as an application variable on every hosted environment and
 * in `.env` locally. An unset value means the Node dev server (B13); a value
 * that is set but unknown is already rejected at startup by the environment
 * plugin (T03), so the fallback below only keeps this function total.
 */

import type { MembershipMode } from "../domain/membership";
import { APP_MEMBERSHIP_MODE, parseMembershipMode } from "../domain/membership";
import type { EnvironmentClass } from "./env-check";
import { resolveEnvironmentClass } from "./env-check";

export function readAppEnv(): EnvironmentClass {
  // guard:allow-env-credential — environment class selection, value is never logged
  const appEnv = process.env.APP_ENV;
  return resolveEnvironmentClass({ APP_ENV: appEnv }) ?? "local";
}

/**
 * The membership mode this process runs in (D32): the application's own, unless
 * `MEMBERSHIP_MODE` overrides it for one environment — which is how the browser suite
 * exercises the mode the application does not ship, and how a staging environment can
 * try `open` before production does. An unknown value is rejected at startup by the
 * environment check, so the fallback only keeps this function total.
 */
export function readMembershipMode(): MembershipMode {
  // guard:allow-env-credential — a fixed enum, never a credential, never logged
  const raw = process.env.MEMBERSHIP_MODE;
  return parseMembershipMode(raw) ?? APP_MEMBERSHIP_MODE;
}
