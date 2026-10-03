# Framework upgrade playbook

Renovate opens the pull request — framework packages arrive grouped as "agent-native framework"
with the `framework-upgrade` label, held for three days after release, and never automerged
(`renovate.json`, D22). This is what a human does with that pull request. Work through it in
order; every step is a gate, not a suggestion.

1. Read the Agent-Native release notes for every proposed version. Identify changes to actions, authentication, database drivers, the Node build output, and deployment commands before editing dependencies.
2. Update the exact `@agent-native/core` and `@agent-native/toolkit` pins. Keep related framework packages in one reviewed change. Re-cut `patches/@agent-native__core@<version>.patch` for the new version in the same change — `pnpm patch @agent-native/core@<version>`, re-apply the two edits, `pnpm patch-commit`.
3. Run `pnpm install` and review both `package.json` and `pnpm-lock.yaml`. Do not discard unrelated lockfile changes without understanding their source.
4. Run `pnpm exec agent-native upgrade check`, then `pnpm exec agent-native doctor --only migration-manifest`. Apply scheduled import migrations deliberately; do not run a blind framework upgrade rewrite.
5. Run `pnpm check` and `pnpm test:integration`.
6. Run `pnpm build`. Then `pnpm test:guards`: `core-patch.test.mjs` fails when the patch is not pinned to the installed version, when it did not apply, or when upstream stopped doing the thing it works around. That last case is the good one — remove the patch, and keep the removal in its own commit so a bisect can find it.
7. Run `pnpm test:e2e:full`. It builds the server, migrates and seeds a throwaway database, runs the smoke and then the browser suite: authenticated reads, writes, undo, approval gating and organization isolation.
8. Re-check every version-sensitive claim this repository makes, against the newly installed `node_modules/@agent-native/core/docs/content/` and `dist/`. Five of them have broken at least once: the `defineAction` option names and the `ActionRunContext` shape (`docs/actions-and-use-cases.md`); the deployment configuration and the runtime's behaviour (`docs/deployment.md`, `ARCHITECTURE.md` section 1); the agent-chat plugin's `frameworkTools` options (`AGENTS.md`, "Agent safety"); the i18n interpolation form and the locale list (`docs/internationalization.md`); and the Google redirect URI, verifiable against your own build with `curl -s http://localhost:8080/_agent-native/google/auth-url` (`docs/authentication-and-authorization.md`). Update the affected document and any affected guard in the same pull request. While the implementation plan is still present, `docs/plan/02-framework-facts.md` records the same facts with their original evidence and is updated alongside — F5, F9, F12 and F14 are the sections this step touches.
10. Run the opt-in model evaluations with an explicitly configured provider credential: `RUN_MODEL_EVALS=1 pnpm eval -- --out eval-evidence.json` (`--out`, never a shell redirection — see `evals/README.md`). Record correct target, successful tool result, persisted state, human approval behavior, and member denial. If no credential is available, report this release evidence as pending; a skipped run is not model validation.
11. Merge only after review and green checks, then watch the staging migration, deployment, seed, and smoke run. Promote the exact staging artifact using its run id.

Compatibility workarounds are bounded exceptions. A new runtime patch or broader generated-code rewrite requires reassessing whether the Node/libSQL fallback is safer before making the workaround permanent — `docs/deployment.md` and `docs/database-and-migrations.md` describe what that move would and would not cost.

If the application carries a framework **package patch** — for example the `nb-NO` locale change described in `docs/internationalization.md` — re-derive it on this version before merging, and say in the pull request whether it was still needed. A patch that silently stops applying is how a feature disappears without anyone noticing.
