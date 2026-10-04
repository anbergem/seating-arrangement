import { createAuthPlugin } from "@agent-native/core/server";

import { readAppEnv } from "../../src/infrastructure/env";
import {
  environmentLabel,
  isGoogleOnlySignIn,
} from "../../src/infrastructure/env-check";

// No `workspaceAppPublicPaths`: every page requires sign-in, including `/`
// (D11 — membership is invite-only and there is no marketing surface).
//
// `marketing.tagline` is required by `AuthOptions["marketing"]`, so it carries a
// neutral one-liner rather than the template's product pitch. No screenshot, no
// feature list and no "learn more" link: the sign-in page is internal.
// `rootAuth` defaults to true whenever `marketing` is set, which serves the
// sign-in document at `/` for everyone — signed in or not — and never reaches
// the `_index` route. `/` is an ordinary authenticated page here (B17), so it
// has to be off; the auth guard still sends anonymous visitors to sign in.
//
// Every environment but production names itself on the sign-in page, so a
// staging tab is never mistaken for the real one. The framework renders
// `appName` as the heading and in the page title, as text; this plugin runs
// once per process, where `APP_ENV` is known, so one build shows the right
// label wherever it is promoted. Production gets no label and an unchanged page.
const appEnv = readAppEnv();
const label = environmentLabel(appEnv);

export default createAuthPlugin({
  rootAuth: false,
  // Production offers Google and nothing else (D11). Password sign-up is already refused
  // there by configuration, so a password form on the page would be a door painted on a
  // wall: this removes the form. Every other environment keeps it, for the seeded and QA
  // accounts.
  googleOnly: isGoogleOnlySignIn(appEnv),
  // The readiness probe (B19) must answer before anyone can sign in — and a load balancer
  // or a smoke test has no session. It exposes migration file names and nothing else.
  publicPaths: ["/api/ready"],
  marketing: {
    appName: label ? `Seating Arrangement (${label})` : "Seating Arrangement",
    tagline: label
      ? `${label} environment. Sign in to continue.`
      : "Sign in to continue.",
  },
});
