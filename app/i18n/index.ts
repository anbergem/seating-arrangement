import { createAgentNativeI18nCatalog } from "@agent-native/core/client/i18n";
import { toolkitMessagesForLocale } from "@agent-native/toolkit/app/i18n";

import enUS from "./en-US";

type Messages = Record<string, unknown>;

/** The app's strings layered over the toolkit's, nested key by nested key. */
function overlay(base: Messages, app: Messages): Messages {
  const merged: Messages = { ...base };
  for (const [key, value] of Object.entries(app)) {
    const current = merged[key];
    merged[key] =
      current &&
      value &&
      typeof current === "object" &&
      typeof value === "object"
        ? overlay(current as Messages, value as Messages)
        : value;
  }
  return merged;
}

// Since 0.198 the settings, team and chat screens come from `@agent-native/toolkit`, which
// carries its own strings: without them those screens render raw keys ("Search
// placeholder", "App fallback name"). The toolkit's `createToolkitI18nCatalog` merges them,
// but only builds loaders for the framework's built-in locales and would drop nb-NO, so
// the merge is done here for both of this app's locales.
export const i18nCatalog = createAgentNativeI18nCatalog({
  messages: overlay(toolkitMessagesForLocale("en-US"), enUS),
  localeLoaders: {
    // Norwegian is not one of the framework's built-in locales, and since 0.198 it does not
    // need to be: `LocaleCode` accepts any locale an app supplies messages for. The toolkit
    // has no Norwegian strings, so its English ones fill the gap.
    "nb-NO": async () =>
      overlay(
        toolkitMessagesForLocale("en-US"),
        (await import("./nb-NO")).default,
      ),
  },
  supportedLocales: ["en-US"],
});
