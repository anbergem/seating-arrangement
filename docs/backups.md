# Backups and restore

The database is a managed PostgreSQL add-on, and its backups are the platform's. That is a
smaller surface than the Cloudflare arrangement this replaced — no nightly export workflow, no
object-storage credentials, no age recipient — and it is worth being explicit about what that
does and does not cover.

- [What backs up what](#what-backs-up-what)
- [What is not covered](#what-is-not-covered)
- [Listing and downloading a backup](#listing-and-downloading-a-backup)
- [Restoring](#restoring)
- [Testing the restore](#testing-the-restore)
- [If you need more than this](#if-you-need-more-than-this)

## What backs up what

The `xxs_sml` PostgreSQL plan takes a **daily backup with seven-day retention**, and supports
point-in-time restore through pgBackRest. Retention and frequency can be changed by asking
Clever Cloud support.

Every production promotion records, in its job summary, the backups that existed **before** it
migrated. That is the list to reach for when a migration is the thing that went wrong, and it
is written before any schema change runs rather than after.

The free `dev` plan has no backups at all. It is refused by `scripts/bootstrap.mjs` for a
different reason — five connections against a pool of twenty — but the absence of backups is
its own argument against using it for anything real.

## What is not covered

- **Anything outside the database.** Uploaded files, if the application ever has any, need a
  second backup path.
- **Application settings.** `BETTER_AUTH_SECRET`, `OAUTH_STATE_SECRET`, the Google client
  credentials and `ANTHROPIC_API_KEY` are set on the platform and are readable back with
  `clever env --alias production`, but they are not part of a database backup. Losing the
  application means re-running `scripts/bootstrap.mjs`, which regenerates the signing secrets
  and signs everyone out.
- **The deployed code.** A promotion is a commit, so git is the backup. The rollback is to
  re-promote the previous staging run.

## Listing and downloading a backup

```bash
clever addon list                               # find the add-on's id
clever database backups <addon-id>
clever database backups download <addon-id> <backup-id>
```

The add-on is named `<app>-<environment>-db`. `clever addon list --format json` gives its id
without the table formatting.

## Restoring

Restoring is not a CLI one-liner and should not be: it overwrites a customer's data. The
supported path is the Clever Cloud console, which offers both the daily backups and
point-in-time recovery for the plan.

Before restoring anything:

1. **Stop writing.** `clever stop --alias production`. A restore that races live traffic
   produces a database nobody can reason about.
2. **Note the current state.** `clever activity --alias production` for the deployed commit,
   and the promotion's job summary for the backup list as it was.
3. **Decide what you are undoing.** A bad migration and a bad row are different problems. The
   second is usually better fixed forward — this application keeps an undo ledger and an audit
   trail precisely so that a single wrong change does not need a restore.
4. Restore, then `clever restart --alias production`, then run the production smoke.

## Testing the restore

A backup nobody has restored is a hypothesis. Test it against **staging**, which carries only
the synthetic scenario:

```bash
clever database backups <staging-addon-id>
# restore the most recent one through the console, then:
node scripts/smoke.mjs --base-url "$STAGING_URL" --mode staging \
  --qa-email owner@example.invalid --qa-password "$SEED_PASSWORD" --expect-org-id org_acme
```

A green smoke after a restore is the evidence. Do this when the application first goes live and
after any change to the schema that you would not want to re-run by hand.

## If you need more than this

Seven days of daily backups is a starting point, not a policy. If the data warrants more:

- A larger plan changes what the platform retains — ask support rather than guessing.
- An independent copy, in a different provider, protects against losing the account itself.
  `clever database backups download` in a scheduled workflow is the shape of it; the thing to
  get right is where the download lands and who can read it, which is why this repository does
  not ship one by default rather than shipping one that quietly writes customer data somewhere
  nobody reviewed.

`docs/runbook.md` covers what to do when something is actually broken.
