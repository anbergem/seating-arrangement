import { defineEventHandler, setResponseHeader } from "h3";

/**
 * Clickjacking protection on every response.
 *
 * Only framing is restricted. The framework's pages rely on inline scripts and
 * styles, so a `script-src`/`style-src` policy would break the app; the one
 * directive we can set without breaking it is `frame-ancestors`, sent alongside
 * the older `X-Frame-Options` for clients that do not implement it.
 *
 * HSTS is production-only: sending it from a plaintext local or CI origin would
 * pin a host that does not serve https.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, "X-Frame-Options", "DENY");
  setResponseHeader(event, "Content-Security-Policy", "frame-ancestors 'none'");

  // guard:allow-env-credential — deployment class only, never a credential value
  if (process.env.APP_ENV === "production") {
    setResponseHeader(
      event,
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
});
