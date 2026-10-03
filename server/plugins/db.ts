import { registerIdentityColumns } from "@agent-native/core/org";
import { defineNitroPlugin } from "@agent-native/core/server";

/**
 * How this app's own email-shaped columns behave when a member changes their email or is
 * removed from an organization (framework 0.181 member offboarding).
 *
 * The framework scans every table for identity-shaped columns and refuses to remove a member
 * — HTTP 503, "local cleanup is pending" — until each one has a declared policy, so this file
 * is what makes removing a member work at all. It is named `db.ts` because the framework's
 * `agent-native identity rekey` CLI reads declarations from exactly this module.
 *
 * Every policy is scoped to `org_id`: removing someone from one organization never touches
 * another organization's rows.
 */
registerIdentityColumns([
  {
    table: "events",
    column: "created_by",
    emailChange: "rekey",
    offboard: "retain",
    orgScope: { column: "org_id" },
    reason:
      "Attribution: who created the event. It follows the person to a new address, and stays theirs when they leave — handing it to a successor would rewrite history. It grants no access.",
  },
  {
    table: "seating_tables",
    column: "created_by",
    emailChange: "rekey",
    offboard: "retain",
    orgScope: { column: "org_id" },
    reason:
      "Attribution: who placed the table, as for events.created_by. A floor plan is shared work; nobody owns a table by having created it.",
  },
]);

// Declarations happen at module load; the plugin itself has nothing to do.
export default defineNitroPlugin(() => {});
