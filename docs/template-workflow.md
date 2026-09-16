# Working with the template

This repository is a **GitHub template**, not a base branch to keep rebasing on. An application
created from it develops independently and diverges on purpose. That decision has consequences
in both directions, and this document is about handling them deliberately.

- [Who should own what](#who-should-own-what)
- [Creating an application](#creating-an-application)
- [Why not a fork](#why-not-a-fork)
- [Porting a change with format-patch](#porting-a-change-with-format-patch)
- [Deciding whether to port at all](#deciding-whether-to-port-at-all)
- [Sending an improvement back](#sending-an-improvement-back)
- [Community template registration](#community-template-registration)
- [When to extract a package](#when-to-extract-a-package)
- [Keeping the template healthy](#keeping-the-template-healthy)

## Who should own what

This template is public and owned by its maintainer. **An application built from it should live
in accounts owned by the company that uses it.** Not in the consultant's personal account, and
not in an agency account that the customer cannot reach.

When the starter becomes a real deployed application, the customer or company should own:

| Thing | Why it matters that they own it |
| --- | --- |
| The GitHub organization and the private repository | The source of their business logic; access outlives any contract |
| The Cloudflare account | The Workers, the D1 databases, the API tokens |
| The domain and DNS | Losing DNS is losing the application |
| The Google Cloud project and OAuth client | Their employees' identities |
| The production D1 data | Obviously, and it is not portable out of an account you cannot log into |
| R2 or any other object storage | Same |
| The backup destination | A backup inside somebody else's account is not a backup |
| The LLM and API billing accounts | Where practical: the spend is theirs and so is the rate limit |

The consultant or developer is granted **administrative access** to those, rather than hosting
critical customer infrastructure permanently inside a personal account.

This is not paperwork. It is the difference between a handover and a hostage situation: a
company that owns its accounts can change developer, and a company that does not has to
migrate production first. Set it up this way at the start, when it costs one afternoon, rather
than at the end, when it costs a migration.

Practical version, at the start of an engagement:

1. The customer creates the GitHub organization, the Cloudflare account and the Google Cloud
   project, with their own billing.
2. They add the developer as an admin/owner of each.
3. The developer runs `docs/bootstrap.md` inside those accounts.
4. The developer's own accounts hold nothing but a git clone.

## Creating an application

**"Use this template"** on GitHub, choosing the customer's organization as the owner and
Private as the visibility. That creates a repository with this repository's files and **no
shared git history**, which is exactly what you want — the new repository's first commit is its
own.

Then `docs/bootstrap.md`, which covers the rename, the accounts, the databases, the secrets,
the environments and the first deployments.

The alternative path, once this repository has a stable tag, is the framework's own CLI:

```bash
npx @agent-native/core create my-app --template community:<owner>/<repo>#<tag>
```

See [Community template registration](#community-template-registration) below for what has to
be true first.

Do **not** create an application by cloning and pushing to a new remote: you inherit this
repository's entire history, including the implementation plan's commits, and `git log` in the
customer's repository becomes a record of somebody else's project.

## Why not a fork

A fork keeps git ancestry, which makes `git merge upstream/main` possible. That sounds like an
advantage and is mostly a trap for this kind of application:

- **The interesting changes conflict.** An application replaces the sample domain entirely.
  Every upstream change to `src/domain/job.ts` conflicts with a file the application deleted,
  and every upstream change to the sample UI conflicts with a UI that looks nothing like it.
- **Merging becomes a habit rather than a decision.** The whole point of taking an upstream
  change is deciding you want it. A merge that mostly succeeds invites accepting things nobody
  read.
- **Ancestry creates an expectation.** A fork implies a maintenance relationship: the
  application's owner starts assuming that upstream fixes arrive, and the template's
  maintainer starts owing them.

So: no ancestry, and improvements move as reviewed patches. The cost is that porting is manual.
The benefit is that every port is a decision somebody made.

Nothing in this repository requires git ancestry to work — that is a design constraint, not an
accident. There is no submodule, no `upstream` remote in any script, and no workflow that
compares against a base branch.

## Porting a change with format-patch

The tool is `git format-patch` to produce, `git am --3way` to apply. It works between
repositories with no common history because a patch is text, not a merge.

**Template → application** (the common direction: a fix or an improvement you want):

```bash
# in the template clone
git log --oneline -20                        # find the commit(s)
git format-patch -1 <sha> -o /tmp/patches    # one commit
git format-patch <base>..<head> -o /tmp/patches   # a range

# in the application
git switch -c port/upgrade-playbook
git am --3way /tmp/patches/*.patch
```

When `git am` stops on a conflict:

```bash
git status                     # the conflicted paths
# resolve them, then
git add -A
git am --continue

# or give up on this patch cleanly
git am --skip                  # skip this one, keep going
git am --abort                 # abandon the whole series, back to where you were
```

`--3way` is what makes this usable across unrelated histories: it uses the blob hashes in the
patch to reconstruct the pre-image, so a patch still applies when the surrounding lines have
moved. Without it, a context mismatch is a hard failure.

Then, before merging the port:

```bash
pnpm install                   # if the patch touched package.json
pnpm check
pnpm test:integration
pnpm verify:worker             # if it touched the Worker, the build or the runtime
```

A ported patch is a change to your application, and it gets the same review as any other.

Two habits that make this much less painful:

- **Keep template-shaped files template-shaped.** `scripts/`, `.github/workflows/`,
  `src/interface/`, `src/application/authorization.ts` and the documents port cleanly if you
  have not reformatted them. Divergence in a file you never needed to change is pure cost.
- **Port promptly, in small pieces.** One commit is usually a clean `git am`. Six months of
  commits is a merge with extra steps.

## Deciding whether to port at all

| Kind of change | Port it? |
| --- | --- |
| A security fix, or a fix to `runAppAction`, the boundary checker, the promotion validators | **Yes**, promptly |
| A framework compatibility patch (`scripts/patch-worker-bundle.mjs`) | **Yes**, together with the framework version bump |
| A workflow or script improvement | Usually, if you have not diverged there |
| A documentation improvement | Cheap, and the documents are what keep a coding agent producing the right shape of code |
| Anything touching the sample domain | **No.** Your domain is not this one. |
| Anything touching the sample UI | **No.** |
| A new sample feature | No — read it, learn from it, do not import it |

Watch this repository's releases and its `CHANGELOG.md` rather than its commits. A tag is a
statement that a set of changes belongs together; a commit is not.

## Sending an improvement back

The direction that keeps the template good. If you fixed something generic in an application —
a bug in a script, a wrong statement in a document, a real gap in the architecture — it belongs
upstream.

```bash
# in the application, isolate the change on its own branch
git switch -c upstream/fix-restore-check
# … commit only the generic change, with no customer-specific content …
git format-patch -1 -o /tmp/patches

# in a fork of the template
git switch -c fix/restore-check
git am --3way /tmp/patches/*.patch
gh pr create
```

Before you send it, check the change carries nothing of the customer's: no company name, no
real email address, no hostname, no account id, no database id, no data. The template's own
rule is that sample names are `Acme Services`, `Example Customer A` and addresses under
`example.invalid` — hold a contribution to the same standard.

If the fix is in the framework rather than in this template, it goes to
[BuilderIO/agent-native](https://github.com/BuilderIO/agent-native) instead.
`docs/plan/upstream-issues/` holds the reports this repository has already prepared, with
minimal reproductions — the format is worth copying.

## Community template registration

After the first stable tag, this repository can be registered as an Agent-Native **community
template**, which makes it available through the framework's own scaffolding:

```bash
npx @agent-native/core create my-app --template community:<owner>/<repo>#<tag>
```

What has to be true first:

- **A stable tag.** `community:<owner>/<repo>#<tag>` pins a tag, not a branch, so people get a
  known-good tree rather than whatever `main` is today.
- **A clean `pnpm install` from a fresh clone**, and `pnpm check` green on that tag.
- **`docs/bootstrap.md` accurate for that tag.** Somebody's first ten minutes are that
  document.
- **The template flag set** on the repository, so "Use this template" also works
  (`gh repo edit <repo> --template`, or `TEMPLATE_REPOSITORY=1` in the bootstrap input).

Registration is a request to the framework's maintainers; the mechanism and its requirements
are theirs, so check the current framework documentation
(`node_modules/@agent-native/core/docs/content/`) rather than assuming this paragraph is up to
date.

Keep "Use this template" as the primary path either way. It needs no third party to agree, and
it works today.

## When to extract a package

The rule, and it is deliberately conservative:

> If the same reusable logic is needed by **several real applications**, consider extracting it
> into a versioned package.

Until then, keep it here, in plain files, where it is readable. Do not prematurely create a
giant custom framework package — a private framework with one consumer is all of the cost of a
framework and none of the benefit, and it makes the one consumer harder to read.

What might eventually deserve extraction, once there are two or three real applications and
their versions of these have converged rather than diverged:

- `src/interface/run-app-action.ts` plus the error model — the smallest genuinely reusable
  piece, and the one every application will have a nearly identical copy of.
- The undo ledger: the `operations` table, `canUndo`, and the undo/redo use cases.
- `scripts/check-boundaries.mjs`, which is already generic apart from its rule table.
- The promotion validators in `scripts/lib/deployment-validation.mjs`.

What should never be extracted: the domain, the authorization policy, the UI. Those are the
application.

When you do extract something, extract it *from* the template — the template keeps using the
package, so the package's consumer count is honest and the template stays the canonical
example.

## Keeping the template healthy

For whoever maintains this repository:

- **The sample application is documentation.** It exists so the architecture is visible, and it
  earns its keep by being small enough to read in an afternoon. Adding a feature to it makes
  every application built from it start heavier. The bar is: does this demonstrate a boundary
  nothing else demonstrates? `send-job-to-accounting` met it. A second integration would not.
- **Every document must stay runnable.** Every command in every document in this repository
  either exists in `package.json` or is a `scripts/` entry point, and the pull request that
  changed a script also changed the document that names it. A document that lies is worse than
  no document.
- **The framework moves fast.** `docs/upgrade-playbook.md` is the procedure, Renovate groups
  the framework packages and never automerges them, and each upgrade re-verifies the
  version-sensitive facts. An upgrade that only checks that the patch still applies has not
  been verified.
- **Keep the boring parts boring.** `ARCHITECTURE.md` section 14 lists what was considered and
  rejected. It is a commitment, and it is the most valuable page in the repository for somebody
  deciding whether to trust it.
