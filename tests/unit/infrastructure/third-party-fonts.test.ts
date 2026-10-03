import { describe, expect, it } from "vitest";

import {
  hasThirdPartyFonts,
  stripThirdPartyFonts,
} from "../../../server/third-party-fonts";

// The tags framework 0.198's sign-in page emits, verbatim.
const SIGN_IN_HEAD =
  '<head><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap"/><link rel="icon" href="/favicon.svg"/></head>';

describe("stripThirdPartyFonts", () => {
  it("removes every Google Fonts link and nothing else", () => {
    const stripped = stripThirdPartyFonts(SIGN_IN_HEAD);
    expect(stripped).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(stripped).toBe(
      '<head><link rel="icon" href="/favicon.svg"/></head>',
    );
  });

  it("detects the links, and leaves a page without them alone", () => {
    expect(hasThirdPartyFonts(SIGN_IN_HEAD)).toBe(true);
    expect(hasThirdPartyFonts(SIGN_IN_HEAD)).toBe(true);
    const plain = "<head><title>App</title></head>";
    expect(hasThirdPartyFonts(plain)).toBe(false);
    expect(stripThirdPartyFonts(plain)).toBe(plain);
  });
});
