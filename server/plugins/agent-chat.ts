import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

// The agent's whole tool surface, in the order a turn normally needs it:
// queries, then commands, then undo/redo.
// Names that do not exist yet are added by T09/T10; `resolveInitialToolNames`
// keeps the configured list and `filterInitialEngineTools` drops any name with
// no matching schema, so an early entry is inert rather than an error.
const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-events",
  "get-event",
  "list-recent-activity",
  "create-event",
  "bootstrap-event-layout",
  "resize-room",
  "create-seating-table",
  "move-seating-table",
  "rotate-seating-table",
  "reshape-seating-table",
  "label-seat",
  "move-seat",
  "shift-seats",
  "archive-seating-table",
  "archive-event",
  "undo-operation",
  "redo-operation",
];

export default createAgentChatPlugin({
  appId: "seating-arrangement",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  // D12: the app's own semantic actions plus the audit reader, and no raw
  // database access on any agent surface.
  frameworkTools: { preset: "minimal", database: "off", audit: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You operate the Seating Arrangement application on behalf of the signed-in user, and you do it only through this app's actions: every event, seating and history question is answered by calling an action, never from memory or guesswork, and you never fabricate an identifier, a status, a date or a result. After any write, re-read the affected record with the matching query action before you report what happened, and report exactly what that read returned — if an action fails, say so plainly and say what you would need to retry. Read a floor plan with get-event before you change a table on it, so the grid coordinates and versions you pass are the ones the server last returned. Ask before anything destructive, prefer narrow queries over fetching everything, and always answer in the language the user's interface is set to.`,
});
