import { describe, expect, it } from "vitest";

import { hideFrameworkChrome } from "../../../server/sign-in-chrome";

const PAGE =
  "<html><head><style>.subtitle { color: #888; }</style></head><body></body></html>";

describe("hideFrameworkChrome", () => {
  it("appends its rules to the page's own stylesheet", () => {
    const html = hideFrameworkChrome(PAGE);
    expect(html).toContain(
      ".app-status-badge, .oss-badge, .card .subtitle { display: none !important; }",
    );
    // Inside the existing element, not a new one.
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html.indexOf("display: none")).toBeLessThan(
      html.indexOf("</style>"),
    );
    expect(html).toContain(".subtitle { color: #888; }");
  });

  it("is idempotent", () => {
    const once = hideFrameworkChrome(PAGE);
    expect(hideFrameworkChrome(once)).toBe(once);
  });

  it("leaves a document without a stylesheet alone", () => {
    const bare = "<html><body>no styles</body></html>";
    expect(hideFrameworkChrome(bare)).toBe(bare);
  });
});
