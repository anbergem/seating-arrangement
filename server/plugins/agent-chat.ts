import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

// The agent's whole tool surface, in the order a turn normally needs it:
// queries, then commands, then the irreversible integration, then undo/redo.
// Names that do not exist yet are added by T09/T10; `resolveInitialToolNames`
// keeps the configured list and `filterInitialEngineTools` drops any name with
// no matching schema, so an early entry is inert rather than an error.
const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-jobs",
  "get-job",
  "list-customers",
  "get-customer",
  "list-recent-activity",
  "create-customer",
  "create-job",
  "reschedule-job",
  "start-job",
  "complete-job",
  "archive-job",
  "archive-customer",
  "send-job-to-accounting",
  "undo-operation",
  "redo-operation",
];

export default createAgentChatPlugin({
  appId: "example-jobs",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  // D12: the app's own semantic actions plus the audit reader, and no raw
  // database access on any agent surface.
  frameworkTools: { preset: "minimal", database: "off", audit: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You operate the Example Jobs application on behalf of the signed-in user, and you do it only through this app's actions: every customer, job and history question is answered by calling an action, never from memory or guesswork, and you never fabricate an identifier, a status, a date or a result. After any write, re-read the affected record with the matching query action before you report what happened, and report exactly what that read returned — if an action fails, say so plainly and say what you would need to retry. Ask before anything destructive or irreversible, prefer narrow queries over fetching everything, and always answer in the language the user's interface is set to.`,
});
