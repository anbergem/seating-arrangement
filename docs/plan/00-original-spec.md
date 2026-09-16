# Original specification (verbatim, as provided by the maintainer on 2026-09-05)

This is the requirements source. The implementation plan in this directory is derived from it.
Where the plan deviates, `01-decisions.md` records why.

---

# Build a production-grade Agent-Native + Cloudflare application starter

Create an open-source GitHub template repository for building small, production-quality, agent-native business applications.

This repository is not a demo, tutorial, throwaway scaffold, or example-only project. It should be a genuinely usable starting point for real internal business applications that may begin with one or a few users but later become relied upon as a company's operational system.

The repository must contain a complete, minimal working application demonstrating the architectural patterns future applications should follow.

The starter should strongly optimize for:

- extremely low operating cost
- minimal operational burden
- strong defaults
- security
- reliability
- maintainability
- testability
- deterministic CI
- agent-friendly architecture
- human/agent parity
- domain/use-case-oriented design
- safe mutation, auditing, and undo
- easy creation of staging and production environments
- easy extraction into a customer-specific private repository using GitHub's template repository functionality
- high-quality instructions for both humans and coding agents

The resulting public repository should be generic. It must contain no references to any real customer, electrician company, private company data, or private infrastructure.

Use generic example names such as "Acme Services", "Example Customer", and "Example Job".

The repository should be suitable for publication under the MIT license.

---

# 1. Core technology choices

Use the current Agent-Native ecosystem from Builder.io as the application framework.

Use:

- TypeScript
- React
- Agent-Native
- Agent-Native Actions as the application/use-case boundary
- Agent-Native's Better Auth integration for application authentication
- Google OAuth as the intended production identity provider
- Agent-Native organization support for company membership
- Cloudflare Workers for deployment
- Cloudflare D1 as the primary relational database
- Drizzle where appropriate and where it is the Agent-Native-supported persistence approach
- Cloudflare R2 support prepared for future file storage, but do not require files in the example domain unless this remains very lightweight
- Playwright for end-to-end tests
- the normal unit/integration testing stack appropriate to the Agent-Native repository and ecosystem
- GitHub Actions for CI/CD
- pnpm unless the current Agent-Native repository strongly recommends another package manager

Pin Agent-Native and closely coupled framework packages to exact versions rather than loose semver ranges. Agent-Native is still evolving quickly, so upgrades should always be explicit pull requests that run the entire validation pipeline.

Do not use Terraform/OpenTofu unless there is a compelling technical requirement. Prefer Wrangler configuration, scripts, Cloudflare APIs where needed, and clear bootstrap documentation.

---

# 2. Fundamental architectural principle: human and agent parity

This repository must embody the central Agent-Native principle:

Every meaningful application capability that a human user can invoke through the UI should exist as a semantic application Action that an authorized agent can invoke as well.

The UI must not contain business logic that the agent cannot reuse.

The agent must not receive privileged direct database access that bypasses the application's use cases.

The architecture should conceptually be:

UI / Embedded Agent / MCP / HTTP
            |
            v
     Application Actions
            |
            v
       Domain logic
            |
            v
 Repository / infrastructure ports
            |
            v
           D1

Actions are the application API.

Do not model Actions as generic CRUD primitives.

Bad examples:

- setJobStatus
- setCustomerName
- patchRecord
- updateTableRow

Good examples:

- createJob
- rescheduleJob
- completeJob
- recordWork
- archiveCustomer

Actions should represent user intent and meaningful business capabilities.

The example application must demonstrate this clearly.

---

# 3. Relationship to DDD and use-case-based design

Use a pragmatic DDD-inspired architecture.

Do not implement ceremony for its own sake.

The important boundaries are:

## Domain layer

Contains:

- domain concepts
- entities where useful
- value objects where useful
- domain invariants
- domain errors
- domain services/policies where business logic genuinely belongs there
- repository interfaces/ports where appropriate

The domain must not import:

- React
- Agent-Native
- Cloudflare APIs
- D1 bindings
- HTTP concepts
- framework-specific UI concepts

## Application layer

Contains the application's use cases.

Agent-Native Actions belong here.

An Action should:

1. accept a semantic command/query
2. receive authenticated execution context
3. resolve organization/company scope
4. enforce application authorization
5. load required domain state
6. execute domain behavior
7. persist changes
8. participate in audit/history behavior
9. return a semantic result

Actions should orchestrate. They should not accumulate all domain logic.

A useful mental model:

Agent-Native Action ≈ application service ≈ command/query handler ≈ use case.

## Infrastructure layer

Contains concrete implementations of ports:

- D1 repositories
- external API adapters
- R2 storage adapters
- email adapters
- vendor integrations
- clock/ID implementations when useful

Domain/application code should depend on interfaces rather than concrete external systems where that improves testability.

## UI layer

Consumes Actions/use cases.

The UI may own presentation state and interaction state.

The UI must not reimplement domain rules.

---

# 4. Example application

Include a very small but complete sample business application.

Use a generic "Jobs" domain suitable for demonstrating a business application without making the starter specific to electricians.

The sample application should include:

## Organization

One organization represents one company.

The starter should support multiple organizations structurally even though the sample/test data may primarily use one.

## Users and membership

Use Agent-Native/Better Auth organization membership.

At minimum demonstrate these coarse roles:

- owner
- admin
- member

Do not build a large RBAC system.

## Customers

Minimal Customer concept:

- id
- organization/company ownership
- name
- optional contact details
- active/archive state
- version where useful for concurrency/history
- created/updated timestamps

## Jobs

Minimal Job concept:

- id
- organization/company ownership
- customer reference
- title
- description
- status
- scheduled date/time if appropriate
- assigned member if appropriate
- version
- created/updated timestamps

Use a small lifecycle, for example:

- scheduled
- in_progress
- completed
- archived/cancelled where appropriate

Keep it minimal.

The point is architectural demonstration rather than feature quantity.

---

# 5. Required sample Actions

Implement enough Actions to demonstrate the architecture.

At minimum include:

## Queries

- listCustomers
- getCustomer
- listJobs
- getJob
- getRecentActivity/history where supported cleanly

## Commands

- createCustomer
- createJob
- rescheduleJob or updateJobDetails
- startJob
- completeJob
- archiveJob

Do not implement generic update-anything APIs merely for convenience.

Each command must demonstrate:

- organization scoping
- authorization
- domain validation
- persistence
- auditing
- history/undo classification

The UI and agent should call the same Action implementation.

---

# 6. Authentication

Use Agent-Native's Better Auth integration as the application's authentication system.

Do not put Cloudflare Access in front of the app as the primary application authentication system.

The intended production login is Google OAuth.

The architecture must keep the identity-provider choice reasonably replaceable so Microsoft/Entra or another Better Auth-supported provider can be added later.

Provide:

- production Google OAuth configuration documentation
- local development authentication setup
- test authentication setup
- staging QA/test authentication approach

CI and Playwright must not automate Google's real login page.

Use deterministic local/test users through the supported Better Auth/Agent-Native testing mechanism.

The application execution context should make available, directly or indirectly:

- authenticated user
- active organization
- organization membership
- coarse organization role

Never trust organization IDs supplied directly by the browser when they can instead be resolved from the authenticated context.

---

# 7. Authorization

Authentication and authorization must be treated separately.

Better Auth establishes identity.

Organization membership establishes which company the user belongs to.

Our application decides what that user is permitted to do.

Use coarse roles initially:

- owner
- admin
- member

Provide a small central authorization mechanism rather than scattering string comparisons throughout Actions.

Examples:

- members may view normal company Jobs
- members may execute ordinary job workflow Actions
- owner/admin may perform organization administration
- a user from Organization A must never read or mutate Organization B data

All authorization checks must happen server-side in or below the Action/use-case boundary.

Hiding a button in React is not authorization.

Agent execution, MCP calls, HTTP execution, and UI execution must all hit the same authorization rules.

Include explicit tests proving tenant/organization isolation.

---

# 8. Database design and tenancy

Use Cloudflare D1.

Production databases should be created using the EU jurisdiction.

Document clearly that jurisdiction must be decided when creating the D1 database.

Every business-owned table should be organization/company scoped.

Do not make records simply user-owned when they conceptually belong to the business.

For example, Job belongs to organization/company, while fields such as assignedToUserId or createdByUserId describe actors.

Enforce organization boundaries structurally and in queries.

Use:

- primary keys
- foreign keys
- relevant unique constraints
- meaningful check constraints where D1 supports them appropriately
- indexes for normal query patterns
- version/concurrency fields where needed

Do not rely solely on TypeScript to preserve relational integrity.

---

# 9. Database migrations

Use explicit version-controlled database migrations.

Never use destructive schema synchronization such as automatic production "push" behavior.

The same migrations must be used for:

- local development
- CI
- staging
- production

Include commands/scripts for:

- creating/migrating local DB
- resetting local DB
- seeding local DB
- applying migrations to staging
- applying migrations to production

The production deployment workflow must treat migrations as a deliberate step.

Prefer expand/contract migration patterns for changes that would otherwise make application rollback impossible.

Include documentation explaining that rolling back Worker code does not automatically roll back D1 schema/data.

---

# 10. Seed data

Create deterministic seed data.

Do not generate random test fixtures that make failures hard to reproduce.

Provide realistic generic scenarios such as:

Organization:
- Acme Services

Users:
- owner@example.invalid
- admin@example.invalid
- member1@example.invalid
- member2@example.invalid

Customers:
- Example Customer A
- Example Customer B
- Archived Customer

Jobs:
- scheduled job
- in-progress job
- completed job
- archived/cancelled job

Also create a second organization and at least one user/record in it specifically for isolation tests.

Seed helpers should be reusable from:

- local development
- tests
- Playwright CI setup

Prefer named scenario builders over opaque piles of fixture rows.

Examples conceptually:

- createCompanyWithMembers()
- createScheduledJob()
- createCompletedJob()
- createForeignOrganizationJob()

The exact implementation should fit the chosen testing stack.

---

# 11. Audit log

Use Agent-Native's built-in audit facilities wherever they meet the requirement rather than creating a competing parallel audit framework.

All meaningful state-changing Actions should produce useful audit history.

The audit trail should make it possible to determine:

- what Action occurred
- when
- organization
- authenticated human identity
- whether invocation came from UI, agent, MCP, HTTP, or system where available
- affected resource
- success/denial/failure
- agent context when applicable

Do not log secrets.

Avoid placing unnecessary personal/customer data in infrastructure logs.

Document the distinction between:

- business audit trail
- application logs
- Cloudflare request/auth/infrastructure logs

---

# 12. Undo and redo

Undo/redo is a first-class architectural requirement.

Use Agent-Native's current history/versioning facilities where suitable rather than inventing a generic custom system without need.

The guiding principle is:

Every mutating use case must be explicitly classified as one of:

- reversible
- compensatable
- irreversible

For reversible Actions, record enough information/version history to safely undo.

Undo must itself be an application Action/use case.

Do not implement undo as arbitrary client-side database restoration.

Do not blindly overwrite newer changes from another user.

Use optimistic concurrency/version checks or the relevant Agent-Native history mechanism so this scenario is safe:

- User A changes Job version 12 → 13.
- User B later changes Job version 13 → 14.
- User A clicks Undo.
- The system must not blindly restore version 12 and erase User B's legitimate change.

If automatic undo is unsafe because newer conflicting state exists, reject it cleanly or invoke an explicit domain compensation strategy.

Redo should rerun/reapply semantic behavior where safe, not blindly restore database snapshots.

The example app must demonstrate at least one working undo flow.

Example:

- complete Job
- show Undo
- Undo creates a new auditable operation restoring the appropriate prior state when safe

The history UI should make it obvious that undo is itself another recorded operation.

---

# 13. External integrations architecture

The starter should include architecture/documentation for integrations without requiring a real external vendor.

Use ports/adapters.

For example, application/domain code might depend on a generic ExternalAccountingSystem interface rather than a specific REST client.

The actual adapter might later be:

- vendor REST API
- GraphQL API
- SOAP API
- MCP adapter
- mock implementation

Document the architectural rule:

For deterministic backend-to-backend business integration, prefer the vendor's stable API.

MCP is primarily an agent-facing tool interface and should not automatically replace ordinary application API integration.

For business-critical mutations, prefer:

Agent → our application Action → our business rules → vendor API

rather than:

Agent → vendor MCP directly

unless bypassing our application semantics is explicitly desired.

Do not build a real accounting integration in the starter.

Do include a small example/mock integration port if it materially improves the architectural demonstration.

---

# 14. File storage

Prepare the architecture for Cloudflare R2.

Do not store large binary files directly in D1.

The intended future model is:

D1:
- file metadata
- resource relationship
- owner/uploader
- object key
- metadata

R2:
- actual bytes

If no file feature is needed for the minimal example app, R2 may remain documented/configurable rather than actively used.

Make clear that database backup and object-storage backup/retention are separate concerns.

---

# 15. Environments

Support three environment classes from day one:

- local
- staging
- production

They must have separate resources.

At minimum staging and production must use separate:

- Worker deployments
- D1 databases
- secrets
- OAuth configuration where appropriate
- R2 buckets if R2 is enabled

Production data must never be copied into CI automatically.

CI must use local disposable data.

Use Wrangler environments/configuration appropriately.

Provide environment-variable/config validation so accidentally starting production configuration locally is difficult.

---

# 16. Local development experience

Make local development extremely easy.

A new developer should be able to clone the repository and reach a working application with a very small number of commands.

Provide scripts such as conceptually:

- install
- dev
- db:migrate
- db:reset
- db:seed
- test
- test:unit
- test:e2e
- check
- deploy:staging
- deploy:production where suitable

The exact names can differ if ecosystem conventions suggest better names.

Local development should:

1. start the Worker-compatible local runtime
2. use local D1
3. use deterministic development authentication
4. optionally seed example data
5. expose the embedded agent where Agent-Native normally supports it

Do not require access to production Cloudflare resources to work locally.

---

# 17. Testing strategy

Testing is a core part of this starter, not an afterthought.

Establish three layers:

## Unit/domain/application tests

Test:

- domain invariants
- authorization policies
- use-case behavior
- query/application behavior
- undo classification/logic
- integration adapters through mocks where useful

These should be fast.

## Hermetic Playwright E2E tests in CI

For every pull request, GitHub Actions should be able to:

1. install dependencies
2. lint
3. typecheck
4. run Agent-Native doctor/validation
5. run unit/integration tests
6. create a fresh disposable local D1 database
7. apply the real version-controlled migrations
8. seed deterministic scenario data
9. start the actual app using the Cloudflare-compatible local runtime
10. run Playwright headlessly against that local application
11. tear everything down

This is the primary end-to-end suite.

Do not make the full E2E suite depend on a long-lived staging database.

Run Playwright conservatively in CI, initially with one worker unless there is a clear reason not to.

Provide authenticated Playwright fixtures for at least:

- owner
- admin
- member
- user from another organization

Do not automate real Google OAuth in normal CI.

Test examples should include:

- owner can sign into test session and load dashboard
- member can list Jobs
- member can complete a valid Job
- mutation appears in audit/history
- user can undo a reversible Action
- undo does not incorrectly overwrite newer conflicting state
- user from another organization cannot access a Job by manually navigating to its ID/API route
- member cannot perform an owner-only operation
- UI action and agent/action-layer semantics use the same backend capability

If it is practical to test agent invocation deterministically without paid LLM calls, include one such test.

---

# 18. Staging tests

After successful merge to the main branch:

1. run full CI
2. apply staging migrations
3. deploy staging Worker
4. run a small Playwright/smoke test suite against the real staging URL

Do not rerun the entire hermetic suite against shared staging.

The purpose of staging smoke tests is deployment verification.

Test things such as:

- application responds
- authentication boundary responds
- QA/test user can authenticate through the supported staging mechanism
- D1 connectivity works
- a simple read works
- an isolated staging-only reversible write can work if safe
- relevant agent endpoint/runtime is healthy

If staging writes test records, isolate and clean them explicitly.

---

# 19. Production deployment and smoke tests

Production deployment should only happen after staging has succeeded.

Prefer a promotion model rather than rebuilding unrelated artifacts differently for production if the ecosystem makes that practical.

Before production migrations/deployment:

- obtain or record an appropriate D1 Time Travel bookmark/checkpoint if supported in the chosen workflow
- make deployment/migration steps visible and auditable in GitHub Actions

After deploy, run only non-destructive production smoke checks.

Examples:

- Worker responds
- health/readiness endpoint works
- database connectivity works
- login entry point loads

Do not create fake customers or Jobs in production as part of routine smoke tests.

---

# 20. Branch protection and CI expectations

Document recommended GitHub repository settings:

- main branch protected
- pull requests required
- CI checks required
- direct pushes to main disabled
- force pushes disabled
- production environment protected
- production deployment optionally requires approval
- staging deploy allowed automatically after merge if desired

The GitHub Actions workflows should be structured clearly rather than putting every operation in one unreadable YAML file.

Use GitHub Environments for staging/production secrets and deployment protection where appropriate.

---

# 21. Dependency management

Use exact versions for Agent-Native and closely coupled framework packages.

Configure Dependabot or Renovate.

Prefer Renovate if it provides materially better grouped dependency control for this stack.

Framework upgrades should appear as explicit PRs and run:

- lint
- typecheck
- unit tests
- Agent-Native doctor
- migration validation
- Playwright
- staging smoke tests after merge

Do not auto-merge Agent-Native framework upgrades.

Document why.

---

# 22. Agent evals

Include Agent-Native's eval structure from day one if currently supported.

Create an `evals` area even if the starter only contains a tiny number of sample evals.

The distinction should be documented:

Playwright answers:
"Does the application behave correctly?"

Agent evals answer:
"Does the model choose and use the correct application Actions?"

Example conceptual evals:

- user asks to complete a Job → agent should call completeJob
- user asks to show today's Jobs → agent should use appropriate query, not mutate anything
- user asks to undo previous action → agent should use the history/undo capability
- agent must not call an owner-only operation when acting for a normal member

Avoid making expensive/nondeterministic model-backed evaluations mandatory on every PR initially unless Agent-Native provides a stable deterministic testing mode.

A reasonable structure is:

- cheap deterministic validations on every PR
- full model-backed eval suite manually, nightly, or before release

Document the approach.

---

# 23. Observability

Enable sensible Cloudflare Worker logging.

Use structured logs.

Include:

- request/correlation ID where appropriate
- Action name
- result type/status
- execution duration where useful
- organization/user identifiers only where appropriate and privacy-safe
- errors

Do not log:

- passwords
- OAuth tokens
- session secrets
- raw authorization headers
- complete customer records
- arbitrary agent prompts containing sensitive data unless intentionally required

Use Agent-Native's own agent observability facilities where available.

Provide an application health/readiness endpoint appropriate for smoke testing.

Consider Sentry or another external error system an optional documented enhancement rather than a mandatory dependency for the minimal starter.

---

# 24. Secrets and security

Secrets must never be committed.

Use:

- Cloudflare Worker secrets
- GitHub Actions environment/repository secrets
- local `.dev.vars` or currently recommended local secret mechanism
- `.env.example` or equivalent containing names only, no actual values

Provide secret validation on startup where appropriate.

Document required production secrets.

Security principles:

- no public direct DB credentials in frontend code
- D1 accessed through Worker bindings
- all mutations server-side
- all authorization server-side
- tenant/organization scope enforced on every business query
- validate every Action input
- treat agent input as untrusted input
- agent never bypasses authorization
- avoid mass-assignment-style generic updates
- use CSP/security headers appropriate to the framework/runtime
- use secure/session cookie settings appropriate to Better Auth
- require production identity provider MFA through the company's identity provider where possible
- document recommended OAuth redirect URI configuration

Run appropriate dependency/security checks in CI if they provide value without excessive noise.

---

# 25. Reliability and backup strategy

Document production backup/recovery as part of the starter.

The intended production strategy:

## First layer

Cloudflare D1 Time Travel / point-in-time recovery.

Document the current free/paid retention behavior but avoid hardcoding business decisions around limits that may change without linking to official docs.

## Second layer

Independent periodic full database exports.

Create a script/workflow foundation for exporting production D1 to SQL.

The backup copy should be designed to be stored outside the production D1 database.

Prefer a separate provider/account/failure domain for truly independent backups.

For the public starter, it is acceptable for the backup destination to be configurable rather than forcing one external provider.

Recommended retention should be documented, for example:

- daily backups retained for approximately 30 days
- weekly/monthly longer-term backups depending on application needs

Backups should support compression and encryption where practical.

The documentation must emphasize:

A backup strategy is incomplete until restore has been tested.

Include a restore runbook or test procedure.

Do not run destructive restore tests against production.

---

# 26. Runbook

Create `docs/runbook.md`.

It should initially explain:

- how to deploy staging
- how to deploy production
- how to rollback Worker code
- how to inspect failed deployments
- how to inspect logs
- how to restore D1 using Time Travel
- how to restore from an SQL export
- how to rotate Better Auth secret
- how to rotate OAuth credentials
- how to revoke/remove a company user
- how to recover when Google OAuth is unavailable
- where production secrets belong
- how to verify the most recent backup
- how to perform a test restore
- how to recover after a bad migration
- what Worker rollback does and does not undo
- how to handle a compromised account

Keep it practical and command-oriented.

---

# 27. Repository ownership assumptions

This is a public starter/template repository owned by the maintainer.

Applications created from it should normally live in an organization/account owned by the actual customer/company using the resulting application.

Document this recommendation.

Customer/company should own, when the starter becomes a real deployed application:

- GitHub organization/private repository
- Cloudflare account
- domain/DNS
- Google OAuth application/project
- production D1 data
- R2 data
- backup destination
- LLM/API billing accounts where practical

The consultant/developer should be granted administrative access rather than hosting critical customer infrastructure permanently inside a personal account.

---

# 28. Template repository strategy

Design this repository to work as a GitHub Template Repository.

Do not assume customer applications will remain Git forks continuously rebased onto this repository.

A customer/private application should be able to use this template and then develop independently.

Therefore:

- avoid infrastructure that requires the private repo to retain Git ancestry
- document how improvements may be manually ported
- keep reusable concepts well-separated so genuinely reusable components can later be extracted into versioned public packages

Do not prematurely create a giant custom framework package.

Use the rule:

If the same reusable logic is needed by several real applications, consider extracting it into a versioned package.

Until then, keep the template straightforward and understandable.

---

# 29. Coding-agent instruction files

This is essential.

Create a strong root-level `AGENTS.md`.

Also create additional scoped agent instruction files only where they provide meaningful local guidance.

The instructions should make the repository architecture enforceable by coding agents.

`AGENTS.md` should explain at minimum:

## Architecture rules

- every meaningful mutation is an Action/use case
- UI must not contain business rules
- agents and humans invoke the same Actions
- domain code must remain framework-independent
- infrastructure implements ports/adapters
- no direct cross-organization access
- no frontend-only authorization
- no generic database mutation tools exposed to agents
- no production data used in tests

## Adding a new feature

Require the agent to think through:

1. domain concept
2. use case/Action
3. authorization
4. organization scoping
5. persistence/migration
6. audit behavior
7. reversibility classification
8. tests
9. UI
10. agent/eval coverage where relevant

## Mutating Action checklist

Every mutating Action must answer:

- who may perform this?
- which organization owns the target data?
- what are the domain invariants?
- is it transactional?
- how is it audited?
- is it reversible, compensatable, or irreversible?
- what happens if the resource changed concurrently?
- how is it tested?

## Database changes

- always use migrations
- never modify production schema manually
- never use destructive push behavior in deployment
- update seeds/tests where appropriate
- consider backward compatibility

## Testing expectations

A feature is not complete when only the UI works.

Tests should cover the correct layer.

At minimum, meaningful features should normally have:

- domain/application tests
- authorization tests
- organization isolation tests when relevant
- Playwright happy path for important user flows

## Agent safety

- never grant agent direct unrestricted D1 access
- never make the agent responsible for business invariants
- external system writes should normally go through our semantic Actions
- treat prompts and model output as untrusted
- irreversible external effects require deliberate handling

## Scope discipline

Do not add infrastructure, abstraction, packages, or generic frameworks speculatively.

Prefer the simplest implementation that obeys the established boundaries.

This starter is for small business applications, not hyperscale distributed systems.

---

# 30. Architecture documentation

Create `ARCHITECTURE.md`.

It should explain the architecture visually using Mermaid diagrams where helpful.

Cover:

- high-level runtime architecture
- request flow
- Action/use-case flow
- human/agent parity
- auth vs authorization
- organization scoping
- domain/application/infrastructure/UI boundaries
- integration ports/adapters
- audit/history/undo flow
- CI/CD flow
- staging/production separation
- backup/recovery model

Include concrete examples based on the sample Job domain.

Explain why the design deliberately avoids:

- generic CRUD Actions
- direct frontend D1 access
- direct unrestricted agent DB access
- unnecessary event sourcing
- unnecessary microservices
- unnecessary message brokers
- unnecessary Kubernetes
- unnecessary multi-region complexity

---

# 31. Feature-development documentation

Create concise practical documents such as:

- `docs/adding-a-feature.md`
- `docs/actions-and-use-cases.md`
- `docs/authentication-and-authorization.md`
- `docs/database-and-migrations.md`
- `docs/testing.md`
- `docs/undo-and-history.md`
- `docs/integrations.md`
- `docs/deployment.md`
- `docs/backups.md`
- `docs/runbook.md`

Do not create documentation merely to increase file count.

Each document must help either a human developer or coding agent make correct changes.

---

# 32. README

Create a high-quality public README.

It should explain:

## What this is

An opinionated Agent-Native + Cloudflare starter for small production business applications.

## What it includes

Summarize:

- Agent-Native
- React/TypeScript
- Better Auth
- organizations
- DDD/use-case architecture
- Actions
- D1
- audit/history
- undo
- Playwright
- local hermetic CI
- staging/production deployment
- backup foundations
- agent instructions

## Quick start

Make it genuinely short.

## Architecture

Show a compact Mermaid diagram.

## Example application

Explain the generic Jobs example.

## Authentication setup

Explain local/test vs production Google OAuth.

## Deployment

Point to detailed docs.

## Creating a new app

Explain GitHub "Use this template".

## Philosophy

Briefly state principles:

- capabilities over CRUD
- humans and agents share use cases
- security in the application boundary
- boring infrastructure
- deterministic tests
- reversible changes where practical
- small systems should still be reliable systems

---

# 33. Suggested repository structure

Use the framework's normal conventions, but aim for conceptual separation similar to:

- `.github/`
  - workflows/
- `docs/`
- `evals/`
- `migrations/`
- `scripts/`
- `src/`
  - actions/ or application/
  - domain/
  - infrastructure/
  - ui/ or framework-appropriate app structure
  - auth/
  - authorization/
  - observability/
- `tests/`
  - unit/
  - integration/
  - e2e/
  - fixtures/
- `AGENTS.md`
- `ARCHITECTURE.md`
- `README.md`
- `LICENSE`
- `wrangler.jsonc`
- `playwright.config.ts`
- package/workspace configuration

Do not force this exact tree if Agent-Native conventions make another layout substantially cleaner.

The conceptual boundaries matter more than folder aesthetics.

---

# 34. Minimal UI

Build a small but polished usable UI.

Do not spend excessive time on visual design.

Include:

- authenticated application shell
- current organization/user indication
- Customer list
- Job list
- Job detail
- ability to create a Customer
- ability to create a Job
- ability to transition Job through at least one meaningful lifecycle operation
- visible success feedback with Undo when applicable
- recent activity/history view or drawer if supported cleanly
- embedded Agent-Native agent interface

Keep it responsive and usable.

The UI should demonstrate correct application architecture rather than contain elaborate design-system work.

---

# 35. Demonstrate agent parity

The sample app must prove that the agent can use the same capabilities as the UI.

For example:

Human:
- clicks "Complete Job"

Agent:
- user says "Complete the Example Customer job"

Both should ultimately execute the same `completeJob` use case/Action.

Similarly:

Human:
- clicks Undo

Agent:
- user says "Undo that"

Both should execute the same underlying undo/history capability.

Document this in `ARCHITECTURE.md`.

---

# 36. Transactions and consistency

Mutating use cases that change several related records should execute transactionally where D1/framework support allows it.

Do not leave partially applied business operations where an Action logically represents one unit of work.

Where external systems are involved later, document that database transaction and remote side effect cannot be one ACID transaction and should instead use explicit state/compensation/idempotency patterns.

Do not introduce distributed transaction infrastructure now.

---

# 37. Idempotency

Prepare mutating Actions that may be invoked via agents, HTTP, retries, or integrations for sensible idempotency where duplicate execution would be harmful.

Do not add idempotency keys to every trivial local UI mutation without reason.

Document where they are valuable:

- external callbacks/webhooks
- payment-like operations
- create operations that may retry across network boundaries
- external integrations
- agent retries where duplicate side effects matter

---

# 38. Concurrency

Use simple optimistic concurrency where needed.

This is a five-user application starter, so do not invent distributed locking.

Resource version numbers are sufficient for important mutable aggregates.

Demonstrate concurrency primarily through undo/history safety.

---

# 39. Delete/archive policy

The starter should demonstrate conservative business-data deletion.

Prefer archive/cancel/void semantics for meaningful business records.

Do not make destructive hard-delete the default domain operation.

Permanent deletion may still exist for genuinely temporary/test/user-owned data where appropriate.

Document the distinction.

---

# 40. Error model

Define a small coherent error model.

Distinguish at least:

- validation/input errors
- authentication errors
- authorization errors
- not found
- conflict/concurrency
- domain invariant violation
- external dependency failure
- unexpected/internal error

Actions should return/throw errors in the manner recommended by Agent-Native, but UI and agent callers should receive semantically useful failures.

Do not expose stack traces or secrets to normal users.

---

# 41. Agent-Native compatibility and framework investigation

Before implementing, inspect the current Agent-Native documentation and repository.

Use the current recommended:

- project structure
- Action APIs
- Better Auth integration
- organization support
- audit capabilities
- history/undo facilities
- Cloudflare Workers deployment method
- D1 integration
- testing helpers
- eval system
- doctor command
- MCP exposure

Do not implement APIs based on stale assumptions if Agent-Native has changed.

Where the framework already provides a facility matching these requirements, prefer using/extending it over implementing a duplicate framework.

However, preserve the architectural boundaries described in this prompt.

If Agent-Native currently makes one requested pattern impossible or substantially awkward, document the incompatibility clearly and choose the closest maintainable approach rather than hacking around it.

---

# 42. Public API and MCP exposure

Use Agent-Native's standard ability to expose Actions through supported interfaces where appropriate.

Do not expose every internal helper as an agent/MCP capability.

Only semantic application use cases should form the external tool surface.

Use clear names and descriptions so a language model can reliably distinguish capabilities.

Avoid a huge number of overlapping microscopic tools.

Queries and commands should be easy to reason about.

---

# 43. Bootstrap experience

Because this will be a GitHub template, provide a post-template checklist or script.

A developer creating a real application should be guided through:

1. rename application
2. update package metadata
3. configure Cloudflare account
4. create staging D1 in EU jurisdiction
5. create production D1 in EU jurisdiction
6. configure Worker bindings
7. configure staging/production secrets
8. configure Better Auth secret
9. configure Google OAuth
10. configure GitHub environments
11. configure staging and production URLs
12. configure backup destination
13. run migrations
14. run local seed
15. run entire CI suite
16. perform first staging deployment
17. perform first production deployment

Do not automatically create paid or destructive cloud resources without explicit user action.

---

# 44. Definition of done

Do not consider the starter finished until all of the following are true:

- repository installs cleanly from a fresh clone
- local development starts successfully
- local D1 can be initialized from migrations
- deterministic seed data loads
- local authentication works
- production Google OAuth configuration is documented
- organization membership works
- sample Customer flow works
- sample Job flow works
- meaningful operations are Actions/use cases
- UI and embedded agent share the same Actions
- authorization is enforced server-side
- cross-organization access tests fail correctly
- audit records are produced for mutations
- at least one mutation is undoable
- conflicting/newer state is not silently destroyed by undo
- unit/application tests pass
- Playwright tests pass against a fresh disposable local D1
- CI runs successfully in GitHub Actions
- staging deployment workflow exists
- staging smoke suite exists
- production deployment workflow exists
- non-destructive production smoke suite exists
- D1 backup/export workflow/script exists
- restore instructions exist
- Worker rollback instructions exist
- secrets are not committed
- Agent-Native dependencies are pinned
- dependency update automation is configured
- AGENTS.md is comprehensive
- ARCHITECTURE.md is comprehensive
- README is suitable for a public GitHub repository
- repository can be marked as a GitHub template and reused without retaining upstream Git history
- MIT license exists
- no customer-specific/private information exists

---

# 45. Implementation philosophy

Keep this repository boring in the best possible way.

Do not optimize for theoretical scale.

Assume typical applications based on this starter may have:

- 1–20 users
- one small company
- low request volume
- modest relational data
- a few external integrations
- an AI agent
- years of accumulated business data

The system should nevertheless treat that data seriously.

Do not introduce:

- microservices
- Kafka
- event sourcing
- Kubernetes
- CQRS infrastructure frameworks
- distributed caches
- complex service meshes
- elaborate custom dependency injection containers

unless something in the actual framework requires it.

A simple modular monolith on Cloudflare Workers + D1 is the desired architecture.

Use events only if a concrete application requirement later justifies them.

Use ordinary function/interface boundaries first.

---

# 46. Final deliverable

Implement the repository completely rather than merely producing a plan.

After implementation:

1. inspect the resulting repository end to end
2. run all automated checks
3. run the hermetic Playwright suite
4. run Agent-Native doctor
5. fix any failures
6. review security-sensitive paths
7. review organization scoping
8. verify there are no committed secrets
9. verify docs match actual commands and architecture
10. provide a concise final report describing:
   - what was implemented
   - important architectural decisions
   - commands for local development
   - commands/tests that were successfully run
   - any current Agent-Native limitations encountered
   - remaining manual steps for Cloudflare/Google/GitHub setup

When there is tension between making this repository more generic and making it understandable, prefer understandable.

The repository itself should serve as the canonical example of how future applications based on it should be designed.

---

## Amendments agreed on 2026-09-06

- Add a Worker runtime smoke layer to CI (build the real Worker, boot it under `wrangler dev` with local D1, hit health, sign-in, an action, agent chat and MCP).
- Cloudflare-first, not Cloudflare-only: document a Node + libSQL fallback; keep the repository layer thin enough that it needs no code changes.
- Acknowledge two schema owners (framework runtime migrations vs Wrangler migrations for app tables).
- Add a framework upgrade playbook; the post-build patch must fail loudly when its assumptions stop matching.
- Separate coding-agent instructions (`AGENTS.md`) from runtime agent instructions (`agent/AGENTS.md`).
- Membership stays invite-only; domain-based joining is documented as optional, not enabled.
- Undo scope: most recent operation on a resource when no newer operation exists; redo re-runs the forward command with a version check; creates are compensated by archiving.
- Idempotency keys only on the two create commands.
- Build once, promote the artifact to production; bundle-size guard in CI.
- Workers Paid plan is accepted; Time Travel retention documented with links, not hard-coded.
- Trim: R2 documented only; one mock integration port; two or three evals; production smoke = health plus sign-in page.
- Cloudflare Access is optional documentation for staging only.
- Multi-locale support from day one; Norwegian Bokmål prepared as an upstream framework contribution reviewed by the maintainer before submission.
