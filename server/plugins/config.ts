import { defineAppConfig } from "@agent-native/core/server";

// Server-only app configuration. `app.id` is this deployment's own identity:
// credential scoping, onboarding and the CLI look the app up by it, so it must
// match the `appId` the agent chat plugin registers (D18).
export default defineAppConfig({
  app: { id: "example-jobs", name: "Example Jobs" },
});
