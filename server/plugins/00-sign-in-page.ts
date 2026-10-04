import { defineNitroPlugin } from "@agent-native/core/server";

import { hideFrameworkChrome } from "../sign-in-chrome";
import { stripThirdPartyFonts } from "../third-party-fonts";

type Fetch = (request: Request) => Response | Promise<Response>;

/** Where the framework serves its sign-in page: the entry path and its legacy spelling. */
const SIGN_IN_PATHS = new Set(["/sign-in", "/_agent-native/sign-in"]);

/**
 * Two corrections to the framework's sign-in page, which has no option for either: it must
 * not load Google Fonts (`../third-party-fonts.ts`), and it must not carry the framework's
 * own badges and sign-up wording (`../sign-in-chrome.ts`).
 *
 * It wraps `nitroApp.fetch`, the application's single entry point: Nitro's node server reads
 * it once, after the plugins have run, so every response passes through here exactly once
 * and after every framework middleware — including the auth guard that serves the sign-in
 * page, which the framework prepends. An earlier version kept an h3 middleware first in the
 * framework's middleware list by moving it there on each request; moving entries in a list
 * that in-flight requests were iterating stalled some of them.
 *
 * Only the sign-in page is read. Reading a response means waiting for all of it, and an
 * earlier version read every HTML page: a server-rendered page whose stream stays open then
 * never reached the browser at all, which showed up as navigations that hung until the
 * test run timed out. Every other response is returned exactly as it came, still streaming.
 * The browser suite's same-origin assertion is what fails if a framework upgrade loads the
 * fonts from some other page.
 */
export default defineNitroPlugin((nitroApp) => {
  const app = nitroApp as { fetch?: Fetch };
  if (typeof app.fetch !== "function") {
    throw new Error(
      "00-sign-in-page: nitroApp.fetch is not a function; re-check after a Nitro upgrade",
    );
  }
  const original = app.fetch.bind(nitroApp);
  app.fetch = async (request) => {
    const response = await original(request);
    if (request.method !== "GET") return response;
    if (!SIGN_IN_PATHS.has(new URL(request.url).pathname)) return response;
    if (!response.headers.get("content-type")?.includes("text/html")) {
      return response;
    }
    const html = await response.clone().text();
    const corrected = hideFrameworkChrome(stripThirdPartyFonts(html));
    if (corrected === html) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(corrected, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
});
