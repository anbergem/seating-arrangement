/**
 * Wrangler does not inherit top-level `vars` into named environments.
 *
 * A var declared only at the top level is therefore absent from every deployed
 * environment, and the only sign is a warning buried in the deploy log:
 *
 *   The following vars exist at the top level, but not on "env.staging.vars".
 *   This is probably not what you want, since "vars" configuration is not
 *   inherited by environments.
 *
 * That is how `AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT` reached a real staging
 * deployment without being set (DISCREPANCIES.md, 2026-09-14). The rule is
 * absolute on purpose: a var that should be off in one environment is set to a
 * disabled value there ("0"), never omitted, so "missing" always means a
 * mistake and there is no exemption list to rot.
 */

/**
 * @param {unknown} wrangler parsed wrangler.jsonc
 * @returns {string[]} one finding per environment missing a top-level var
 */
export function findUninheritedVars(wrangler) {
  if (!wrangler || typeof wrangler !== "object") return [];
  const config = /** @type {Record<string, unknown>} */ (wrangler);
  const topLevel = config.vars;
  if (!topLevel || typeof topLevel !== "object") return [];
  const environments = config.env;
  if (!environments || typeof environments !== "object") return [];

  const findings = [];
  for (const [name, environment] of Object.entries(
    /** @type {Record<string, unknown>} */ (environments),
  )) {
    const vars =
      environment && typeof environment === "object"
        ? /** @type {Record<string, unknown>} */ (environment).vars
        : undefined;
    const present = vars && typeof vars === "object" ? Object.keys(vars) : [];
    const missing = Object.keys(topLevel).filter(
      (key) => !present.includes(key),
    );
    for (const key of missing) {
      findings.push(
        `wrangler.jsonc env.${name}.vars: ${key} is declared at the top level but not here, and wrangler does not inherit vars into environments`,
      );
    }
  }
  return findings;
}
