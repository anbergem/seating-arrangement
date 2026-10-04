/**
 * Hides the parts of the framework's sign-in page that describe the framework rather than
 * this application: its "ALPHA" status badge, its "Free & open source" tag, and the
 * subtitle under the heading — "Sign in or create your account", which is untrue wherever
 * membership is by invitation, and adds nothing where it is not.
 *
 * The framework offers no option for any of them, and the page builds its markup in the
 * browser, so there is no element to remove on the server. What is stable is the class
 * names its own stylesheet uses; the rules below are appended to that stylesheet rather
 * than added as a new `<style>` element, so they are covered by whatever policy already
 * allows the page's own styles. The heading inherits the spacing the subtitle provided.
 *
 * Pure so it can be unit-tested; `server/plugins/00-sign-in-page.ts` applies it. If a
 * framework upgrade renames a class, the page simply shows the element again —
 * `tests/e2e/auth.spec.ts` is what notices.
 */
const MARKER = "/* app: sign-in chrome */";

const RULES = `${MARKER}
  .app-status-badge, .oss-badge, .card .subtitle { display: none !important; }
  .card h1 { margin-bottom: 1.5rem; }
`;

export function hideFrameworkChrome(html: string): string {
  if (html.includes(MARKER)) return html;
  const end = html.indexOf("</style>");
  if (end === -1) return html;
  return `${html.slice(0, end)}${RULES}${html.slice(end)}`;
}
