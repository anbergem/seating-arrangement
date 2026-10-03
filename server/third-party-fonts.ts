/**
 * Removes Google Fonts links from an HTML document.
 *
 * Framework 0.192 redesigned the sign-in page, and since then it adds `<link>` tags for
 * fonts.googleapis.com and fonts.gstatic.com whenever `marketing` is configured — which it
 * is here, for the app name and the environment label. Each one sends the visitor's IP
 * address to Google before they have signed in, which this application promises never to do
 * (decision D17) and which is a GDPR problem in its own right. Without the links the page
 * falls back to the system font; nothing else changes.
 *
 * Pure so it can be unit-tested; `server/plugins/00-no-third-party-fonts.ts` applies it.
 */
const GOOGLE_FONT_LINK =
  /<link\b[^>]*\bhref=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^"']*["'][^>]*>/gi;

export function stripThirdPartyFonts(html: string): string {
  return html.replace(GOOGLE_FONT_LINK, "");
}

export function hasThirdPartyFonts(html: string): boolean {
  GOOGLE_FONT_LINK.lastIndex = 0;
  const found = GOOGLE_FONT_LINK.test(html);
  GOOGLE_FONT_LINK.lastIndex = 0;
  return found;
}
