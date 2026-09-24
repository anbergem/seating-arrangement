/**
 * Map the platform's database variable onto the one the framework reads (T28).
 *
 * Clever Cloud injects `POSTGRESQL_ADDON_URI` for a linked PostgreSQL add-on. The
 * framework reads `DATABASE_URL`, and offers no configuration hook for the primary
 * connection string — `runtime.databaseUrlUnpooled` covers only the direct-client
 * case, and the one platform whose spelling it understands is Netlify's. So the
 * mapping happens here.
 *
 * The alternative is copying the connection string into a second Clever Cloud
 * variable, which is worse: the credential would exist in two places and a rotation
 * on the add-on would silently leave the app pointing at the old one. Mapping keeps
 * one source of truth, which is the add-on.
 *
 * `00-` and alphabetically before `00-env-check`, whose rules include a deployable
 * database: it must see the mapped value, not the absence of one. An explicit
 * `DATABASE_URL` always wins, so local development and the tests are untouched.
 */
export default function mapPlatformDatabaseUrl() {
  if (process.env.DATABASE_URL) return; // guard:allow-env-credential — presence check, value never read or logged
  const platformUri = process.env.POSTGRESQL_ADDON_URI; // guard:allow-env-credential — platform-injected connection string, never logged
  if (!platformUri?.startsWith("postgres")) return;
  // Boot-time and process-scoped by nature: one platform variable renamed to the one
  // the framework reads, before any reader exists. `runWithRequestContext` carries
  // per-request values and cannot hold a connection string the client reads once.
  // guard:allow-env-mutation — platform variable rename at boot; value never logged
  process.env.DATABASE_URL = platformUri;
}
