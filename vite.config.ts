import { createRequire } from "node:module";

import { agentNative } from "@agent-native/core/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const reactRouterPlugins = reactRouter as unknown as () => any[];
const agentNativePlugins = agentNative as unknown as (
  options?: Parameters<typeof agentNative>[0],
) => any[];
const appRequire = createRequire(import.meta.url);
const coreRequire = createRequire(
  appRequire.resolve("@agent-native/core/vite"),
);

export default defineConfig({
  // Cold start used to serve a blank page.
  //
  // React Router has no `index.html`, so Vite's dependency scanner never
  // reaches `app/root.tsx` — and root.tsx is where the framework's 40-odd
  // `@agent-native/core/client/*` and `@agent-native/toolkit/*` subpaths are
  // imported. They were therefore discovered only when the browser requested
  // the client entry, mid-load: the optimizer re-bundled, every in-flight
  // request 504'd with "Outdated Optimize Dep", and the page came up empty
  // until a manual reload. `holdUntilCrawlEnd` (on by default) cannot help,
  // because the crawl it waits for never saw those imports.
  //
  // Warming the entry and the routes runs that discovery at server start
  // instead, before any browser request exists to invalidate.
  server: {
    warmup: {
      // The whole app tree, not just the entry: the toolkit's dialog, command,
      // popover and sonner subpaths are imported by components that no static
      // crawl from `root.tsx` reaches, so listing only the entry and the routes
      // still left them to be discovered mid-load.
      clientFiles: ["./app/**/*.tsx"],
    },
  },
  optimizeDeps: {
    // Vite discovers dependencies by crawling from the entry. Most of these are
    // reached only through a dynamic import inside `@agent-native/core`'s own
    // client code — the agent chat panel and its composer — so no crawl of this
    // app's files finds them. They were therefore discovered mid-load, which
    // re-bundles the optimizer's output, 504s every in-flight request and can
    // leave the page blank until a manual reload (DISCREPANCIES.md, 2026-09-09
    // and 2026-09-11).
    //
    // This list is the set actually observed being optimized late, taken from
    // the dev server's own "new dependencies optimized" lines rather than
    // guessed. It will drift as the framework changes: an entry that no longer
    // resolves prints "Cannot optimize dependency: …, present in
    // 'optimizeDeps.include'" and is otherwise inert, which is the same warning
    // the framework's own excalidraw and mermaid entries already produce here.
    // Re-derive it after a framework upgrade by grepping a cold-start log.
    include: [
      "@agent-native/core/client/agent-chat",
      "@agent-native/core/client/analytics",
      "@agent-native/core/client/api-path",
      "@agent-native/core/client/hooks",
      "@agent-native/core/client/i18n",
      "@agent-native/core/client/navigation",
      "@agent-native/core/client/org",
      "@agent-native/core/client/route-chunk-recovery",
      "@agent-native/core/client/ui",
      "@agent-native/toolkit",
      "@agent-native/toolkit/app-shell",
      "@agent-native/toolkit/chat-history",
      "@agent-native/toolkit/composer",
      "@agent-native/toolkit/composer/PastedTextChip",
      "@agent-native/toolkit/composer/attachment-accept",
      "@agent-native/toolkit/composer/model-selection",
      "@agent-native/toolkit/composer/pasted-text",
      "@agent-native/toolkit/composer/realtime-voice-transcript",
      "@agent-native/toolkit/design-system",
      "@agent-native/toolkit/sharing",
      "@agent-native/toolkit/ui/alert-dialog",
      "@agent-native/toolkit/ui/avatar",
      "@agent-native/toolkit/ui/badge",
      "@agent-native/toolkit/ui/button",
      "@agent-native/toolkit/ui/checkbox",
      "@agent-native/toolkit/ui/command",
      "@agent-native/toolkit/ui/cube-loader",
      "@agent-native/toolkit/ui/dialog",
      "@agent-native/toolkit/ui/dropdown-menu",
      "@agent-native/toolkit/ui/input",
      "@agent-native/toolkit/ui/pagination",
      "@agent-native/toolkit/ui/popover",
      "@agent-native/toolkit/ui/select",
      "@agent-native/toolkit/ui/sheet",
      "@agent-native/toolkit/ui/sonner",
      "@agent-native/toolkit/ui/spinner",
      "@agent-native/toolkit/ui/switch",
      "@agent-native/toolkit/ui/textarea",
      "@agent-native/toolkit/ui/tooltip",
      "@agent-native/toolkit/utils",
      "@radix-ui/react-dialog",
      "@tabler/icons-react",
    ],
  },
  resolve: {
    // Core and toolkit both use assistant-ui contexts. Keep published and
    // linked graphs on one store so the agent sidebar can compose reliably.
    dedupe: [
      "@assistant-ui/react",
      "@assistant-ui/core",
      "@assistant-ui/store",
      "@assistant-ui/tap",
    ],
    alias: [
      {
        find: /^@assistant-ui\/react$/,
        replacement: coreRequire.resolve("@assistant-ui/react"),
      },
      {
        find: /^@assistant-ui\/core$/,
        replacement: coreRequire.resolve("@assistant-ui/core"),
      },
      {
        find: /^@assistant-ui\/store$/,
        replacement: coreRequire.resolve("@assistant-ui/store"),
      },
      {
        find: /^@assistant-ui\/tap$/,
        replacement: coreRequire.resolve("@assistant-ui/tap"),
      },
      {
        find: /^assistant-stream$/,
        replacement: coreRequire.resolve("assistant-stream"),
      },
      {
        find: /^assistant-stream\/utils$/,
        replacement: coreRequire.resolve("assistant-stream/utils"),
      },
    ],
  },
  plugins: [
    ...reactRouterPlugins(),
    ...agentNativePlugins({
      // shiki only runs in AssistantChat's useEffect — keep it out of the
      // CF Pages Functions bundle (25 MiB limit).
      ssrStubs: ["shiki"],
    }),
  ],
});
