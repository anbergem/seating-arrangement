import { defineAppConfig } from "@agent-native/core/server";

import { readMembershipMode } from "../../src/infrastructure/env";

// Server-only app configuration. `app.id` is this deployment's own identity:
// credential scoping, onboarding and the CLI look the app up by it, so it must
// match the `appId` the agent chat plugin registers (D18).
//
// `access` is the framework's half of the membership mode (D32); the other half is
// `server/plugins/organization-self-admission.ts`, which narrows what the framework
// allows. This layer wins over the environment, so `ORG_CREATION` and
// `AUTO_CREATE_DEFAULT_ORG` set on a deployment change nothing — the mode decides.
// Nobody gets an organization they did not ask for, in either mode: an open
// application offers the form, it does not create one behind a first sign-in.
export default defineAppConfig({
  app: { id: "seating-arrangement", name: "Seating Arrangement" },
  access: {
    orgCreation: readMembershipMode() === "open" ? "open" : "closed",
    autoCreateDefaultOrg: false,
  },
});
