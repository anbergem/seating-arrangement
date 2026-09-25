// The add-on connection-string parser, against both shapes the Clever Cloud CLI has printed.
// The 5.x shape is the default here on purpose: the 4.x shape was the only one this parser
// read, and every deployed-database caller failed against a current CLI because of it
// (DISCREPANCIES.md, 2026-09-25).

import assert from "node:assert/strict";
import test from "node:test";

import { connectionStringFrom } from "../../scripts/lib/addon-url.mjs";

const URI = "postgresql://user:pass@host.example.invalid:5432/db";

test("reads clever-tools 5.x output: one object keyed by variable name", () => {
  assert.equal(
    connectionStringFrom({
      POSTGRESQL_ADDON_HOST: "host.example.invalid",
      POSTGRESQL_ADDON_URI: URI,
    }),
    URI,
  );
});

test("reads clever-tools 4.x output: a list of name/value pairs", () => {
  assert.equal(
    connectionStringFrom([
      { name: "POSTGRESQL_ADDON_HOST", value: "host.example.invalid" },
      { name: "POSTGRESQL_ADDON_URI", value: URI },
    ]),
    URI,
  );
});

test("reports nothing rather than guessing when there is no postgres URI", () => {
  assert.equal(connectionStringFrom({}), undefined);
  assert.equal(connectionStringFrom([]), undefined);
  assert.equal(connectionStringFrom(null), undefined);
  assert.equal(
    connectionStringFrom({ POSTGRESQL_ADDON_URI: "mysql://x" }),
    undefined,
  );
});
