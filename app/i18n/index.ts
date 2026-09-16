import { createAgentNativeI18nCatalog } from "@agent-native/core/client/i18n";

import enUS from "./en-US";

export const i18nCatalog = createAgentNativeI18nCatalog({
  messages: enUS,
  localeLoaders: {
    // Norwegian is not in the framework's locale list yet (BuilderIO/agent-native#3985).
    // @ts-expect-error — remove when the framework accepts nb-NO
    "nb-NO": () => import("./nb-NO"),
  },
  supportedLocales: ["en-US"],
});
