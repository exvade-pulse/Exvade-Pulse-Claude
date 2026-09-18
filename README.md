# Exvade Pulse

Internal operating system for Exvade Bioscience. Ingests operational communications
and maintains a structured, source-backed picture of company work
(Objectives → Initiatives → Projects → Tasks) instead of treating every message as
a new task. AI proposes changes as `suggestions`; humans review and approve before
anything becomes authoritative.

This repo currently contains a **vertical slice**, not the full app — see
[Scope](#scope-of-this-slice) below.

## Stack

- **Backend:** Fastify + TypeScript, Drizzle ORM, Postgres
- **Frontend:** Next.js (App Router)
- **Auth:** Google OAuth, invite-only past a one-time home-domain bootstrap
- **CI:** GitHub Actions (typecheck, tests, build) — see [.github/workflows/ci.yml](.github/workflows/ci.yml)

## Project layout

```
backend/    Fastify API, Drizzle schema + migrations, tests
frontend/   Next.js review UI
```

## Local setup

Requires Node 22+ and a Postgres database (a local instance, or a free
[Neon](https://neon.tech) project — Neon works fine here since the backend talks to
it over the standard Postgres wire protocol, not just Neon's HTTP driver).

1. Install dependencies from the repo root:

   ```bash
   npm install
   ```

2. Copy env files and fill them in:

   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```

   - `DATABASE_URL` — your Postgres connection string.
   - `TEST_DATABASE_URL` — a **separate, disposable** database for the test suite
     (tests truncate all tables between runs). Never point this at real data.
   - `SESSION_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a Google Cloud OAuth client
     (Web application type; authorized redirect URI
     `http://localhost:3001/auth/google/callback` for local dev). Not required
     to run the backend, only to sign in.
   - Sign-in is allowlisted, not open: the **first** person to sign in from a
     given Google Workspace domain bootstraps that domain's organization and is
     made `admin` automatically (nothing to configure — this is how you get in
     on a fresh setup). Anyone after that must already have an `authorized_users`
     row for their email, added by an existing admin via the `/users` page (or
     `POST /api/users`), or their sign-in is rejected.
   - `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
     (Settings → API Keys). Not required to run the backend or test suite, only
     to run the real interpretation pipeline (`npm run interpret:real -w backend`)
     or real ingestion.

3. Apply migrations:

   ```bash
   npm run db:migrate -w backend
   ```

4. (Optional) Seed one fake suggestion to see the review flow without wiring up
   real ingestion yet:

   ```bash
   npm run seed:fake -w backend
   ```

   Or, with `ANTHROPIC_API_KEY` set, run one raw email through the real
   Claude-driven pipeline (noise filter → interpretation → suggestion):

   ```bash
   npm run interpret:real -w backend
   # or against your own email-shaped JSON file:
   npm run interpret:real -w backend -- path/to/email.json
   ```

5. Run both apps:

   ```bash
   npm run dev:backend
   npm run dev:frontend
   ```

   Frontend at http://localhost:3000, backend at http://localhost:3001.

## One-time historical import

A batch script for importing a folder of real historical meeting-minutes documents
(`.docx`/`.pdf`) through the same ingestion pipeline as every other source, in
chronological order (oldest first — suggestions are reviewed in the order this
script runs in, so importing out of order risks a newer update being approved
before, and then overwritten by, an older one):

```bash
npm run import:minutes -w backend -- path/to/folder --dry-run
```

**Always dry-run first.** It scans the folder recursively, extracts text, resolves
each document's date (from the filename primarily, falling back to the document's
own content), sorts them, and prints the full planned order plus anything it
couldn't confidently date — with zero Claude API calls and zero database writes.
Once the order and date coverage look right, drop `--dry-run` to actually ingest:

```bash
npm run import:minutes -w backend -- path/to/folder
```

Requires `ANTHROPIC_API_KEY`. Re-running the same command is safe — already-ingested
files are skipped, not duplicated (see
[backend/src/scripts/importHistoricalMinutes.ts](backend/src/scripts/importHistoricalMinutes.ts)),
so an interrupted run can just be re-run. `path/to/folder` defaults to
`C:\Users\meeha\Documents\ExvadePulse-Import`, a local folder deliberately kept
outside this repo so real company documents are never at risk of being committed.

## Deployment

Prepared but **not yet deployed or validated against a live host** — these are a
starting point for when Neon/Fly.io/Vercel accounts exist, not a tested path.

### Backend → Fly.io

[backend/Dockerfile](backend/Dockerfile) is a multistage build (`npm ci` at the
workspace root, `npm run build -w backend`, then a slim runtime image) and
[fly.toml](fly.toml) configures a Fly app around it, including a
`release_command` that runs migrations before each new version takes traffic.

1. `fly launch --no-deploy` from the repo root — it'll detect `fly.toml` and let
   you adjust `app`/`primary_region` (both are placeholders) before anything ships.
2. Point `DATABASE_URL` at a real Postgres instance (Neon works over the standard
   wire protocol, not just its HTTP driver — see "Local setup" above).
3. Set the rest as Fly secrets (never in `fly.toml`, which is committed):
   `fly secrets set DATABASE_URL=... SESSION_SECRET=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_CALLBACK_URL=... ALLOWED_GOOGLE_DOMAIN=... FRONTEND_URL=... BACKEND_URL=... ANTHROPIC_API_KEY=...`
   — `GOOGLE_CALLBACK_URL`, `FRONTEND_URL`, and `BACKEND_URL` all need their real
   production values (not `localhost`), and the Google OAuth client's authorized
   redirect URIs need the production callback URL added.
4. `fly deploy`.

Render is a viable alternative to Fly.io (per the original kickoff spec) — it can
build directly from the same `backend/Dockerfile`, just without `fly.toml`.

### Frontend → Vercel

A standard Next.js app needs no extra config file for Vercel — connect the repo,
set the **root directory to `frontend/`**, and set `NEXT_PUBLIC_API_URL` to the
backend's real deployed URL as an environment variable. Update the backend's
`FRONTEND_URL` secret to match the resulting Vercel URL (CORS is locked to it).

### GitHub Actions

No deploy-on-push workflow exists yet — [.github/workflows/ci.yml](.github/workflows/ci.yml)
only gates merges on typecheck/test/build. Adding an automated deploy step needs
`FLY_API_TOKEN`/`VERCEL_TOKEN` secrets configured first; wiring that up without
those in place would just fail, so it's deliberately left as a manual `fly deploy`
for now rather than a half-working automation.

## Tests & typecheck

```bash
npm run typecheck
npm run test -w backend
```

Backend tests need `TEST_DATABASE_URL` (or `DATABASE_URL`) set to a real,
disposable Postgres database — they run real migrations and queries against it,
not mocks.

## Scope of this slice

Built:
- Repo scaffold (npm workspaces), Drizzle migrations, GitHub Actions CI
  (typecheck/test/build gate before merge).
- The full data model: `organizations`, `users`, `authorized_users`, `objectives`,
  `initiatives`, `projects`, `tasks`, `sources`, `suggestions`, `decisions`,
  `audit_log`, `webhook_integrations`. `objectives`/`initiatives`/`projects`/`tasks`
  each carry a nullable `owner` (free text, "who's responsible") -- see the
  Company Map bullet below for why it's a single field rather than a
  `decisions`-style `stakeholders` array.
- Google OAuth, invite-only past a one-time bootstrap, JWT session cookie.
  `ALLOWED_GOOGLE_DOMAIN` names one "home" Workspace domain whose very
  first-ever signer bootstraps the organization and becomes its admin
  ([backend/src/auth/identity.ts](backend/src/auth/identity.ts)'s
  `findOrCreateUserForGoogleIdentity`). Every sign-in after that -- home
  domain or not -- requires an explicit `authorized_users` row for that exact
  email; an invite is honored regardless of what domain the email is on, so
  an admin can bring in a contractor or advisor on a personal Gmail address
  without that domain getting its own organization. (The Google OAuth `hd`
  parameter, which would narrow the account chooser to one domain, is
  deliberately left unset for this reason.) An email with no invite and no
  claim to the home-domain bootstrap is rejected outright, full stop -- there
  is no self-service org creation past that first admin.
- An allowlist + roles gate on top of that OAuth flow: `authorized_users`
  ([backend/src/db/schema.ts](backend/src/db/schema.ts)) is a separate table from
  `users` (someone can be authorized before they've ever signed in) carrying a
  `user_role` (`member`/`admin`) per `(organizationId, email)`, and
  [backend/src/users/manage.ts](backend/src/users/manage.ts)'s `authorizeUser`
  (used by `POST /api/users`) validates only that the invited value looks like
  an email address -- not that it matches the inviting org's own domain.
  `role` is embedded in the session JWT only as a UI hint;
  [backend/src/auth/middleware.ts](backend/src/auth/middleware.ts)'s `requireAuth`
  re-reads `authorized_users` fresh on every request and 401s if the row is gone —
  the actual enforcement boundary, so a revoked person's session dies immediately
  rather than lingering for the cookie's 7-day life — and a `requireAdmin`
  preHandler 403s non-admins on admin-only routes. Admin CRUD lives in
  [backend/src/users/manage.ts](backend/src/users/manage.ts) /
  [backend/src/routes/users.ts](backend/src/routes/users.ts) (`GET`/`POST /api/users`,
  `PATCH /api/users/:email/role`, `DELETE /api/users/:email`), each writing an
  `audit_log` row; both the role-change and revoke routes refuse to target the
  caller's own email (the database transaction rejects it, not just the UI). The
  frontend ([frontend/app/users/page.tsx](frontend/app/users/page.tsx), linked from
  the nav only for admins) lists everyone authorized for the org — email, display
  name once they've signed in, a role `<select>`, and a Revoke button — with an
  "authorize someone" form, and disables the role/revoke controls on the viewer's
  own row (server-side check is the real guard).
- A real, Claude-driven interpretation pipeline:
  - [backend/src/interpretation/claudeClient.ts](backend/src/interpretation/claudeClient.ts) —
    a single interface wrapping the Anthropic SDK, so the model call is
    swappable and tests can stub it without mocking the SDK itself.
  - [backend/src/interpretation/noiseFilter.ts](backend/src/interpretation/noiseFilter.ts) —
    a cheap Haiku pre-pass that decides whether a source is worth the full
    interpretation pass, or obviously noise (out-of-office, calendar
    decline, spam). Fails open (never silently drops a source) and never
    fabricates a "not worth it" suggestion — a noise verdict just skips
    creating one.
  - [backend/src/interpretation/interpret.ts](backend/src/interpretation/interpret.ts) —
    the real interpretation pass (Claude Sonnet), given a source and the
    org's current open objectives/initiatives/projects/tasks. `tool_choice`
    is deliberately `auto`, not forced -- Sonnet 5 only runs extended
    thinking (`adaptive`, `effort: "xhigh"`) when tool_choice is auto,
    verified empirically against the real API, and giving the model room to
    actually reason before deciding how to decompose a multi-topic source and
    match each piece against existing context is the point of this pass. It
    strongly prefers matching/updating an existing item over proposing
    something new, and validates the model's response (schema,
    target-type/target-id membership in the context it was given, and the
    same field whitelist `suggestions/apply.ts` enforces) before it's
    trusted. A task can only be created under a project that already exists
    -- when a source names a distinct, individually-owned action item whose
    real project doesn't exist yet, the prompt directs the model to a
    standing "Unsorted / Needs Triage" project (a real Objective ->
    Initiative -> Project a human creates once per org) rather than losing
    that item into some other entity's description text; a human re-files it
    into real structure later.
  - [backend/src/interpretation/pipeline.ts](backend/src/interpretation/pipeline.ts) —
    wires the above into one call: insert `sources` row → noise filter →
    interpretation → insert `suggestions` row (or stop, keeping the source
    row either way).
  - [backend/src/scripts/runRealInterpretation.ts](backend/src/scripts/runRealInterpretation.ts) —
    a script (`npm run interpret:real -w backend`) to exercise the real
    pipeline locally against one raw email-shaped input.
  - [backend/src/scripts/importHistoricalMinutes.ts](backend/src/scripts/importHistoricalMinutes.ts) —
    a one-time batch script (`npm run import:minutes -w backend`, see
    [One-time historical import](#one-time-historical-import)) that feeds a folder
    of real historical `.docx`/`.pdf` meeting minutes through the same pipeline,
    oldest first.
  - The original hardcoded/fake interpretation function
    ([backend/src/interpretation/fakeInterpret.ts](backend/src/interpretation/fakeInterpret.ts),
    still used by `npm run seed:fake`) is kept around for fast, offline tests
    and demos that shouldn't hit a real API.
- A minimal review UI: list pending suggestions with what/where/why/source,
  approve/reject. Approving applies the proposed diff to the target table inside
  a transaction and writes an `audit_log` row.
- Editing a suggestion's proposed diff before approving: `PATCH /api/suggestions/:id`
  ([backend/src/routes/suggestions.ts](backend/src/routes/suggestions.ts) →
  [backend/src/suggestions/apply.ts](backend/src/suggestions/apply.ts)'s
  `editSuggestion`) merges a reviewer's partial edit into the existing
  `proposedDiff`, re-runs it through the same `pickAllowedFields` whitelist the AI
  output is held to, and sets status to `edited` (writing a `suggestion.edited`
  `audit_log` row) without touching `reviewedBy`/`reviewedAt`. The review UI
  ([frontend/app/page.tsx](frontend/app/page.tsx)) exposes this as an Edit/Save/Cancel
  affordance on each card; an `edited` suggestion still shows Approve/Reject, and
  approving it applies the edited diff.
- Every core table carries `organization_id` directly, and every query is scoped
  to `request.user.organizationId` in the backend query layer — enforced in code,
  not relied on as a database-only property — even though there's one
  organization today.
- A strategy-map dashboard, one card per Objective, for a leadership-level,
  zoomed-out view of company work: `GET /api/dashboard/objectives`
  ([backend/src/routes/dashboard.ts](backend/src/routes/dashboard.ts)) returns
  every objective in the caller's org with `initiativeCount` and a `taskCounts`
  breakdown by every `task_status` value, aggregated with real SQL `groupBy`/`count`
  down the full Objective → Initiative → Project → Task hierarchy (not fetched and
  reduced in JS), ordered critical → high → medium → low priority then title. An
  objective with no initiatives/tasks still appears, with all counts at zero.
  The frontend ([frontend/app/page.tsx](frontend/app/page.tsx)) is now the landing
  page ("/"), restructured to lead with "what needs attention today" rather than
  the objective-level rollup alone: a Decisions Needed panel (the soonest 1-3 open
  decisions, reusing `fetchOpenDecisions`/`/api/decisions`'s own due-date ordering,
  with a link through to `/decisions`); a company-wide status-count strip (three
  new endpoints below); a flat, urgency-sorted Needs Attention task list (blocked
  before needs_attention, each row showing owner, the objective/initiative/project
  it belongs to, a latest-update/next-action snippet, and a relative "updated"
  time); and a Recent Progress list of the 10 most recently completed/resolved
  tasks. The original objective-card strategy overview — status/priority badges, a
  chip per non-zero task status, a one-line "N initiatives · M needs attention"
  summary, and a completed/non-superseded progress bar — is kept as-is, unchanged
  and undeleted, under a "Strategy map" heading further down the same page. Three
  new endpoints in [backend/src/routes/dashboard.ts](backend/src/routes/dashboard.ts)
  back this: `GET /api/dashboard/status-summary` (org-wide task-status counts via
  `backend/src/tasks/rollup.ts`'s shared helpers), `GET /api/dashboard/needs-attention`,
  and `GET /api/dashboard/recent-progress` (the 10 most recent completed/resolved
  tasks). This schema has no "not started" task status and no per-task priority
  field, so the status strip honestly omits a fabricated "not started" bucket
  (folding `superseded` out of the top-line summary rather than inventing one) and
  no per-task priority badge is shown. The suggestions review UI moved to
  [frontend/app/review/page.tsx](frontend/app/review/page.tsx) (`/review`), with a
  minimal shared nav ([frontend/app/components/Nav.tsx](frontend/app/components/Nav.tsx))
  linking the two. Needs Attention is sorted to surface actual risk, not just
  recent churn, and shows *why* a task is stuck rather than a bare status chip:
  `GET /api/dashboard/needs-attention` fetches every blocked/needs_attention task
  org-wide with its full parent chain in one set of scoped joins (not N+1 per
  task), then applies a three-factor sort in memory (this data scale doesn't
  justify a CASE-ranked multi-join `ORDER BY`, matching the flat-queries-
  assembled-in-JS pattern already used in `companyMap.ts`): severity first
  (blocked before needs_attention), then the task's *inherited* priority — tasks
  have no priority field of their own, so this walks the same task → project →
  initiative → objective chain already resolved for the parent-chain columns and
  uses the objective's `priority` as the tiebreak — then staleness, deliberately
  **ascending** (oldest `updatedAt` first) within a tier, since a task quietly
  stuck for weeks is a bigger risk than one that just became blocked an hour ago.
  Each row also now carries `blockingDecision` (id/title of the open decision, if
  any, whose `relatedTaskId` points at it — a batched lookup, not N+1 — `null` if
  none, and a *decided* decision pointing at the task doesn't count), rendered on
  the dashboard as "Blocked — waiting on decision: …" linking to `/decisions`.
  `GET /api/tasks/:id` ([backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts))
  carries the same `blockingDecision` field, and the task detail page
  ([frontend/app/tasks/[id]/page.tsx](frontend/app/tasks/[id]/page.tsx)) shows the
  matching "Blocked by open decision: …" callout.
- Drill-down detail pages for the full Objective → Initiative → Project → Task
  hierarchy ("Company Map"), the piece deferred from the dashboard's first pass
  above: [backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts) adds
  `GET /api/objectives/:id`, `GET /api/initiatives/:id`, `GET /api/projects/:id`,
  and `GET /api/tasks/:id`, each `requireAuth`-gated and org-scoped in the query
  itself (not fetch-then-check-in-JS), returning the row's full detail plus its
  immediate children (an objective's initiatives, an initiative's projects, a
  project's full task rows including `latestUpdate`/`nextAction`) or, for a
  project/initiative, its immediate parent for a breadcrumb. `GET /api/tasks/:id`
  additionally resolves the full parent chain up to the objective in one join
  (rather than three round trips) and lists that task's approved suggestions
  (`target_type='task'`, `status='approved'`) for traceability back to the source
  update that produced it. A malformed or nonexistent id, or one belonging to
  another organization, 404s rather than 500ing or leaking existence. The frontend
  adds one page per level —
  [frontend/app/objectives/[id]/page.tsx](frontend/app/objectives/[id]/page.tsx),
  [frontend/app/initiatives/[id]/page.tsx](frontend/app/initiatives/[id]/page.tsx),
  [frontend/app/projects/[id]/page.tsx](frontend/app/projects/[id]/page.tsx),
  [frontend/app/tasks/[id]/page.tsx](frontend/app/tasks/[id]/page.tsx) — each with a
  text breadcrumb back up the chain, reusing the existing card/badge/chip classes
  rather than introducing new styling. The project page's task list is the
  densest/most useful view: each task row shows its status badge plus a truncated
  latest-update and next-action snippet so the list is scannable without opening
  every task. The dashboard's objective card title
  ([frontend/app/page.tsx](frontend/app/page.tsx)) now links to `/objectives/:id`,
  the actual drill-down entry point. A bad/stale id in the URL renders a plain
  "not found" message instead of crashing the page.
- A decisions registry, for things that need an explicit human call rather than a
  status update: `decisions` ([backend/src/db/schema.ts](backend/src/db/schema.ts))
  carries a `title`, three optional narrative fields (`whyItMatters`,
  `relevantContext`, `suggestedNextStep`) instead of one description blob, a
  `decider` (free text — not a `users` FK, since decision-makers here are often
  external: board members, advisors, investors), a `stakeholders` text array, a
  `status` (`open`/`decided`), `dueDate`, and `resolution`/`decidedAt` once decided.
  It optionally links to the specific `task` it arose from (`relatedTaskId`) and the
  `source` it was cited from (`sourceId`) — both nullable, both validated to belong
  to the caller's organization before being accepted, the same defensive-validation
  spirit as the interpretation pipeline's `targetId` check. Logic lives in
  [backend/src/decisions/manage.ts](backend/src/decisions/manage.ts)
  (`createDecision`/`resolveDecision`, mirroring `suggestions/apply.ts`'s
  thin-route/logic-module split), exposed via
  [backend/src/routes/decisions.ts](backend/src/routes/decisions.ts):
  `GET /api/decisions` (defaults to `status=open`, joins in the related task's
  title and current `status` as `relatedTaskTitle`/`relatedTaskStatus`, soonest
  `dueDate` first with nulls last), `POST /api/decisions`, and
  `PATCH /api/decisions/:id/resolve` (rejects an already-decided decision). Both
  writes append a `decision.created`/`decision.resolved` `audit_log` row.
  Resolving now closes the loop with whatever task the decision was blocking
  instead of leaving it stuck forever: the resolve route accepts an optional
  `alsoUnblockTask` flag, and `resolveDecision` — inside the same transaction
  that resolves the decision — checks whether `relatedTaskId` points at a task
  that's currently `blocked` (deliberately *only* `blocked`, not
  `needs_attention` — blocked is the direct "waiting on this decision" signal a
  decision can concretely resolve, `needs_attention` is a much weaker/broader one
  this one decision shouldn't presume to fix) and, if the flag is set and it is,
  flips that task to `active` and writes a second `task.unblocked_via_decision`
  `audit_log` row. Left unset, or when the related task isn't blocked, resolving
  behaves exactly as before. The frontend
  ([frontend/app/decisions/page.tsx](frontend/app/decisions/page.tsx), linked from
  the nav as "Decisions") lists open decisions with their stakeholder chips, due
  date (overdue ones called out in red), the three narrative sections, and the
  related task's title if set; a plain form creates one (title/decider/
  stakeholders/due date/narrative fields — `relatedTaskId`/`sourceId` are only
  settable via the API for now, no picker UI yet), and "Mark decided" resolves one
  inline — showing a "this decision was blocking '[task]', currently marked
  blocked — also mark it active?" checkbox only when `relatedTaskId` is set and
  `relatedTaskStatus` is `blocked`, so the option doesn't clutter every decision's
  resolve form — dropping the decision out of the open list once resolved. The
  Claude interpretation pipeline
  ([backend/src/interpretation/interpret.ts](backend/src/interpretation/interpret.ts))
  can now propose creating a decision, not just human-filled forms: `targetType`
  gained a fifth value, `"decision"`, alongside objective/initiative/project/task,
  and `SYSTEM_PROMPT` gives Claude a concrete signal for when a decision (rather
  than an operational update) is the right call — "the fractional CFO scope needs
  clarifying with leadership" is a decision, "the firmware patch passed testing" is
  not. Decisions now follow the same "prefer updating over duplicating" principle
  used everywhere else in this pipeline: `CompanyContext` gained a `decisions` pool
  (open decisions only — `pipeline.ts`'s `loadCompanyContext` queries
  `status = 'open'` for the org), rendered in the prompt with each decision's
  `decider` and `whyItMatters` alongside its id/title, since matching a follow-up
  to the right open decision needs more than a bare title the way a task title
  usually suffices. `SYSTEM_PROMPT` asks Claude to check for a plausible existing
  open decision before proposing a new one (e.g. "any update on the CFO scope
  question?" should match rather than duplicate an already-open "What should the
  CFO engagement's scope be?"), and `isKnownEntityId` validates a non-null decision
  `targetId` against that pool exactly like every other target type — a hallucinated
  decision id is rejected the same way a hallucinated task/objective id is. An
  update's `proposedDiff` is guided toward refreshing `whyItMatters`/
  `relevantContext`/`suggestedNextStep`/`stakeholders`; the model is asked not to
  include `decider` on an update, since reassigning who owns a decision is meant to
  stay a deliberate human action rather than an AI inference (a reviewer can still
  edit it in by hand before approving — `ALLOWED_FIELDS.decision` doesn't
  distinguish create from update). Approving a decision-type suggestion
  ([backend/src/suggestions/apply.ts](backend/src/suggestions/apply.ts)) does not
  go through the generic insert-by-table path the other four target types use;
  it branches on `targetId`: `null` calls `createDecision` (unchanged), non-null
  calls the new `updateDecision`
  ([backend/src/decisions/manage.ts](backend/src/decisions/manage.ts)) — both
  invoked inside the same transaction via a postgres savepoint, so org-scoped
  `relatedTaskId`/`sourceId` validation and their own
  `decision.created`/`decision.updated` audit_log entries stay owned by
  decisions/manage.ts instead of being duplicated. `updateDecision` only touches
  fields actually present in the (already-whitelisted) diff and refuses to update
  a decision that's already `decided`, since reopening one via an inferred match
  would undo a deliberate human resolution.

- Real Circleback (meeting-transcript) ingestion via a signed, per-org webhook
  token, feeding the existing interpretation pipeline for real:
  - `webhook_integrations` ([backend/src/db/schema.ts](backend/src/db/schema.ts))
    is one row per `(organizationId, integration_type)` — `integration_type` is
    a separate enum from `source_type`, currently just `circleback`, deliberately
    easy to extend for a second transcript/communication source later without a
    rewrite. Only a sha256 hash of the token is stored (`tokenHash`); the raw
    token is returned exactly once, at generation time, and is not retrievable
    again. Rotating a token updates the row in place rather than creating a new
    one, so a stale row never lingers as a second valid credential.
  - Admin token management —
    [backend/src/integrations/manage.ts](backend/src/integrations/manage.ts) /
    [backend/src/routes/integrations.ts](backend/src/routes/integrations.ts) —
    behind `requireAuth` + `requireAdmin`, org-scoped, mirroring
    `users/manage.ts`'s thin-route/logic-module split and `audit_log` writes:
    `GET /api/integrations` (status per type: configured, `lastReceivedAt`,
    `createdAt` — never the token) and `POST /api/integrations/:type/token`
    (generate or rotate; returns the raw token and the full composed webhook
    URL once). The webhook URL is built from a new `BACKEND_URL` config value
    ([backend/src/config.ts](backend/src/config.ts), defaulting to
    `http://localhost:3001` — optional, nothing else depends on it).
  - The public ingestion endpoint —
    [backend/src/routes/webhooks.ts](backend/src/routes/webhooks.ts) →
    [backend/src/integrations/webhookIngest.ts](backend/src/integrations/webhookIngest.ts) —
    `POST /api/public/webhooks/circleback?token=...` is deliberately **not**
    behind `requireAuth`: Circleback has no Exvade Pulse user session, so a
    per-org token in the query string is the only credential. A missing or
    unrecognized token 401s (identically either way, so nothing about *why* a
    token failed is leaked) before anything is looked at, let alone ingested.
    A valid token resolves straight to an organization (the token itself picks
    the org — Circleback never sends one). Payload field names are guessed
    defensively across plausible variants (`title`/`name`/`meetingTitle`,
    `id`/`meetingId`/`externalId`, `occurredAt`/`date`/`startTime`, etc. — see
    [backend/src/integrations/circlebackPayload.ts](backend/src/integrations/circlebackPayload.ts))
    to populate the `sources` row's title/external id/received-at, falling back
    to a hash of the raw body for the id if nothing recognizable is present —
    **we do not have real Circleback payload docs for this**, so these field
    names are a best guess and should be verified against a real payload the
    first time a live Circleback automation is connected. The full raw JSON
    body is always stored verbatim as `sources.rawBody`, regardless of what the
    field-name guessing finds, so nothing is ever lost to a parsing miss. From
    there it's a straight handoff into the existing, source-type-agnostic
    `runInterpretationPipeline` ([backend/src/interpretation/pipeline.ts](backend/src/interpretation/pipeline.ts)) —
    no pipeline changes were needed. Runs synchronously in-request (no job
    queue exists in this codebase yet); a comment in `webhookIngest.ts` flags
    this as the thing to change if/when ingestion volume grows. A repeat
    delivery of the same `(organizationId, externalId)` — Circleback retries on
    a non-200 response or timeout — hits the `sources` table's existing unique
    index and is caught and answered 200 idempotently rather than erroring; a
    genuine downstream failure (e.g. the Claude API call) leaves the already-
    inserted `sources` row in place and answers 5xx so Circleback retries.
  - Frontend: [frontend/app/integrations/page.tsx](frontend/app/integrations/page.tsx)
    (admin-only, linked from the nav like `/users`) shows each integration
    type's status and last-received time, a Generate/Rotate token button
    (rotating asks for confirmation first, since it invalidates the existing
    token), and on generation, the full webhook URL with a copy-to-clipboard
    button and a one-time-shown-token warning.
  - **To connect a real Circleback account:** an admin generates a token on
    `/integrations`, copies the webhook URL, and pastes it into a Circleback
    automation configured to send meeting notes and action items (transcript
    optional) — no code changes needed. Given the lack of real payload docs,
    the first live delivery is the point to double-check the field-name
    guessing above actually matches.
- Real inbound-email ingestion, closing the kickoff spec's original "forward an
  email, same as today" priority — until now the only way an email reached the
  interpretation pipeline was running `npm run interpret:real -w backend` by
  hand, one message at a time. Structurally identical to the Circleback
  integration above, extended rather than parallel-built:
  - `integration_type` gets a new `'email'` value (not `'postmark'`) —
    [backend/src/db/schema.ts](backend/src/db/schema.ts). No inbound-email
    provider is actually connected yet, so the value is named after the
    category rather than today's guessed provider, meaning swapping providers
    later doesn't need a migration — the same "don't bake in assumptions that
    make a second source a rewrite" reasoning the Circleback work above already
    established. `source_type`'s existing `'gmail'` value is reused for these
    rows rather than adding a third overlapping "this is an email" enum
    value, matching how `seedFakeSuggestion.ts`/`runRealInterpretation.ts`
    already use `'gmail'` for email-shaped ingestion; the mismatch between that
    literal name and "any inbound email via Postmark" is pre-existing and out
    of scope to rename here.
  - No official provider account is connected yet (same "future step" gap
    Circleback had before a real automation was wired up), so this targets
    **Postmark's inbound webhook JSON shape** — a well-documented, common
    choice for "forward mail to an address, get a JSON webhook" absent a
    specific provider being chosen yet.
    [backend/src/integrations/emailPayload.ts](backend/src/integrations/emailPayload.ts)
    guesses field names defensively the same way `circlebackPayload.ts` does
    (`From`/`FromFull.Email`+`FromFull.Name`, `Subject`, `MessageID`, `Date`,
    body preferring `TextBody` then a crude regex-stripped `HtmlBody`, falling
    back to the full raw JSON if neither is present) — **we do not have
    official Postmark reference docs loaded for this task**, so these field
    names are a best guess from general knowledge of that shape and should be
    verified against a real payload the first time a live provider is
    connected, the same honest hedge as the Circleback caveat above. The full
    raw JSON body is always stored verbatim as `sources.rawBody` regardless of
    what the field-name guessing finds.
  - The public ingestion endpoint —
    `POST /api/public/webhooks/email?token=...` in
    [backend/src/routes/webhooks.ts](backend/src/routes/webhooks.ts) →
    `ingestEmailWebhook` in
    [backend/src/integrations/webhookIngest.ts](backend/src/integrations/webhookIngest.ts) —
    mirrors the Circleback route exactly: token-gated (not `requireAuth`,
    since an email provider has no Exvade Pulse session), duplicate
    `(organizationId, externalId)` delivery (by `MessageID`) answered 200
    idempotently, a genuine downstream failure leaving the already-inserted
    `sources` row in place and answering 5xx so the provider retries, and a
    straight handoff into the existing `runInterpretationPipeline` — no
    pipeline changes were needed here either.
  - Admin token management and the `GET /api/integrations` list route
    ([backend/src/integrations/manage.ts](backend/src/integrations/manage.ts),
    [backend/src/routes/integrations.ts](backend/src/routes/integrations.ts))
    needed no new logic — both were already parameterized by
    `integration_type` rather than hardcoded to Circleback, so adding
    `'email'` to the enum and to `integrations.ts`'s `VALID_TYPES` was enough
    for both integration types to show up.
  - Frontend: [frontend/app/integrations/page.tsx](frontend/app/integrations/page.tsx)
    now renders both Circleback and Email as rows of the same table (looped
    by type, not a duplicated page or duplicated card JSX), each with its own
    label and its own one-time-token setup instructions.
  - **To connect a real inbound-email provider:** an admin generates a token
    on `/integrations`, copies the webhook URL, and configures a provider
    (e.g. Postmark's inbound webhook settings) to forward mail to it — no code
    changes needed. Given the lack of real payload docs, the first live
    delivery is the point to double-check the field-name guessing above
    actually matches.
  - **A per-integration activity log**, closing the gap where `/integrations`
    could show *that* an integration last received something but not *what*.
    `GET /api/integrations` now also returns `totalSuggestions` per type
    (all-time count of suggestions whose source is that integration's own
    `sources.type`), and a new `GET /api/integrations/:type/activity`
    returns its most recent 20 sources, newest first, each tagged with its
    own suggestion count. Both live in
    [backend/src/integrations/manage.ts](backend/src/integrations/manage.ts):
    `SOURCE_TYPE_BY_INTEGRATION` is the explicit `IntegrationType ->
    sources.type` mapping (`email` -> `gmail`, matching webhookIngest.ts's
    existing reuse of that value) that both new queries key off, and
    `listIntegrationActivity`'s per-source suggestion count is a batch
    lookup (one query for up to 20 sources), not N+1. A suggestion count of
    0 on an item is reported as-is rather than guessing whether that item
    was noise-filtered or failed interpretation -- that verdict isn't
    persisted anywhere after the fact, only the count itself is a fact. The
    frontend ([frontend/app/integrations/page.tsx](frontend/app/integrations/page.tsx))
    adds a "Suggestions" column and a per-row "View activity" toggle that
    lazy-loads the log for just that integration type.
- A real, live Gmail pull integration — a genuine OAuth connection to a
  specific inbox that's polled for new mail, as opposed to the push-based
  webhook integrations above (which still need a real provider connected to
  actually deliver anything). Deliberately a separate mechanism, not another
  `webhookIntegrations`/`integrationTypeEnum` row:
  - `gmail_connections` ([backend/src/db/schema.ts](backend/src/db/schema.ts))
    is one row per org, holding the connected mailbox's address, a real
    (reversible) OAuth refresh token — unlike `webhookIntegrations`' one-way
    token hash, a refresh token has to be retrievable to actually call the
    Gmail API, so hashing it isn't an option; stored in plain text, consistent
    with this app's existing security posture (no field-level encryption
    exists anywhere else) — and `lastHistoryId`, Gmail's own cursor for
    incremental sync.
  - The connect flow —
    [backend/src/integrations/gmailOAuth.ts](backend/src/integrations/gmailOAuth.ts),
    [backend/src/routes/gmailAuth.ts](backend/src/routes/gmailAuth.ts) —
    is incremental authorization on the *same* Google OAuth client sign-in
    already uses, not a second client: `GET /auth/gmail/connect` (admin-only)
    redirects to Google requesting `gmail.readonly` plus
    `access_type=offline&prompt=consent` (forces a fresh refresh token on
    every connect, not just an account's first-ever consent) at its own
    `GOOGLE_GMAIL_CALLBACK_URL` redirect URI, separate from sign-in's own
    callback since it's a fundamentally different grant ("read this inbox,"
    not "prove who's signing in"). `GET /auth/gmail/callback` verifies a
    state cookie (the same CSRF pattern as `routes/auth.ts`'s sign-in flow),
    exchanges the code, fetches the connected mailbox's own address purely
    for display, and upserts the connection row — a reconnect always resets
    `lastHistoryId` to null, safe because `runInterpretationPipeline`'s
    `externalId` uniqueness makes re-processing an already-ingested message a
    no-op rather than a duplicate. The person authorizing needs to be signed
    into the *target* Google account (e.g. `pulse@exvadebio.com`) in their
    browser at the consent screen — a separate session from their own Pulse
    admin login on accounts.google.com, not something the app can do for them.
  - Syncing — [backend/src/integrations/gmailSync.ts](backend/src/integrations/gmailSync.ts) —
    the first-ever sync for a connection lists the whole inbox (`labelIds:
    INBOX`) and captures the mailbox's current `historyId` as the baseline;
    every sync after that calls `users.history.list(startHistoryId=...)` for
    just what's new since the last check, falling back to a full re-list if
    Gmail reports the stored `historyId` has expired (its documented 404
    signal, which happens after roughly a week of inactivity). Each new
    message is fetched via `messages.get`, parsed by
    [backend/src/integrations/gmailMime.ts](backend/src/integrations/gmailMime.ts)
    (depth-first search for a `text/plain` part, falling back to a stripped
    `text/html` part, falling back to the top-level body for a genuinely
    non-multipart message), and handed to the same
    `runInterpretationPipeline` every other source type uses — no pipeline
    changes needed. An in-process 5-minute `setInterval` poller
    (`startGmailPoller`, started in
    [backend/src/index.ts](backend/src/index.ts)) checks every connected
    org's inbox — the same "simplest thing that works at this scale" choice
    as the webhook integrations' synchronous in-request processing, not a
    placeholder for a job queue.
  - `GET /api/integrations` now also returns a `gmail` field (connection
    status, connected address, last synced time, last sync error) alongside
    the existing per-type webhook integration list; its `totalSuggestions`
    reads the same `sources.type = "gmail"` count the (still-unconnected)
    "email" webhook integration above would also report — see the comment on
    `GmailConnectionStatus` in
    [backend/src/integrations/manage.ts](backend/src/integrations/manage.ts)
    for why that overlap is accepted rather than engineered around, given
    only one of the two mechanisms is expected to actually be in use at a
    time. `POST /api/integrations/gmail/sync` lets an admin force a check
    immediately instead of waiting for the next scheduled pass;
    `DELETE /api/integrations/gmail` disconnects.
  - Frontend: [frontend/app/integrations/page.tsx](frontend/app/integrations/page.tsx)
    adds a Gmail row to the same integrations table — "Connect Gmail" (a
    real link to `/auth/gmail/connect`, not a fetch call, since it has to
    navigate the browser to Google) when not connected, "Sync now" /
    "Disconnect" once it is, reusing the existing per-row activity-log toggle.
  - **To connect a real Gmail inbox:** create the mailbox in Google Workspace
    admin, click "Connect Gmail" on `/integrations`, and sign into that
    mailbox's Google account (not your own) at Google's consent screen. The
    connecting Google Cloud project also needs `GOOGLE_GMAIL_CALLBACK_URL`
    added to the OAuth client's authorized redirect URIs and the
    `gmail.readonly` scope added to the consent screen (with the connecting
    account added as a test user if the app is in Testing mode, which is
    expected and fine for an internal tool).
- A "What changed" activity feed, making the `audit_log` table (written by
  nearly every mutating action — suggestion review, decision review, user
  management, integration token management) actually viewable instead of
  write-only, and framed around each user's own last visit rather than just a
  flat chronological dump: `GET /api/activity`
  ([backend/src/routes/activity.ts](backend/src/routes/activity.ts)),
  `requireAuth`-gated and org-scoped, left-joins `users` on `actorId` for the
  actor's name/email (handling a null `actorId` gracefully rather than
  assuming every write site sets one) and returns the most recent 100 entries
  newest-first — no pagination yet, a fine limitation to leave for later. A
  nullable `users.lastActivityViewAt` timestamp (per-user, not per-org, since
  two people watching the same org's feed each have their own "since I last
  looked") is read before this request, so the response can report the
  caller's *previous* visit time alongside a deterministic, templated
  executive summary computed from real counts — advancing that timestamp is
  deliberately a *separate* `POST /api/activity/mark-visited` call, not a side
  effect of the `GET`: a read that mutates state would have two open tabs, a
  page refresh, or any future polling each silently consume the "since last
  visit" window before the user actually saw it. The frontend calls the POST
  once per genuine page visit, guarded by a `useRef` against React
  StrictMode's dev-mode double-invoke firing it twice. That summary covers
  status moves and completions (`suggestion.approved` entries whose
  `details.appliedFields` includes a `status` key), new decisions
  (`decision.created` entries) since that previous visit, plus the
  present-tense count of currently-open decisions and the single most urgent
  one (same soonest-due-date-first ordering as `GET /api/decisions`) — no
  Claude call involved. The frontend
  ([frontend/app/activity/page.tsx](frontend/app/activity/page.tsx)), linked
  from the nav for everyone (a read-only audit trail, not a privileged action,
  unlike `/users`/`/integrations`), renders that summary as a sentence above a
  "Last visit [relative time]" subline, then the unchanged row-based list
  below it — lighter-weight for a feed that can run to 100 rows — showing the
  actor (name, falling back to email, falling back to "System"), a small
  formatter mapping each known `action` string to plain English
  (`suggestion.approved` → "approved a suggestion", with a generic fallback
  for anything unmapped), a "View [entityType]" link into the Company Map
  detail pages when `entityType` is one of objective/initiative/project/task,
  and a relative timestamp.
- A global search bar in the nav, covering the whole company map plus
  decisions in one place rather than requiring five separate list pages.
  `GET /api/search` ([backend/src/routes/search.ts](backend/src/routes/search.ts)),
  `requireAuth`-gated and org-scoped, runs five parallel, capped (8 rows each)
  `ILIKE '%q%'` queries — objectives/initiatives/projects on title +
  description, tasks on title + description + `latestUpdate` + `nextAction`
  (reusing `taskParentChainQuery` for the same breadcrumb shape the dashboard
  already returns), decisions on title + all three narrative fields — and
  returns all-empty results for a query under 2 characters rather than
  scanning on every keystroke. The frontend
  ([frontend/app/search/page.tsx](frontend/app/search/page.tsx)) is a
  Suspense-wrapped client page (required for `useSearchParams` under app
  router prerendering) that debounces its own input 300ms before calling the
  API and mirrors the URL's `?q=` both ways — typing here updates the URL via
  `router.replace`, and a query typed into the nav's own search box
  ([frontend/app/components/Nav.tsx](frontend/app/components/Nav.tsx)) lands
  here via `router.push`. Results render grouped by type with the same
  card/badge styling as the rest of the app, each linking into its real
  detail page (decisions link to `/decisions`, which has no per-id route yet).
- A manual "Add update" entry point on `/review`, for typing a note directly
  instead of routing it through email/Circleback/a document. It is not a
  shortcut: `POST /api/sources/manual`
  ([backend/src/routes/sources.ts](backend/src/routes/sources.ts)),
  `requireAuth`-gated (any authenticated user, not admin-only — this is
  everyday operational logging), feeds the note through the *exact same*
  `runInterpretationPipeline` every other source uses — redaction, then the
  noise filter, then interpretation — rather than writing a suggestion
  straight from the typed text. There is no external delivery to dedup
  against the way a webhook has an `externalId`, so each submission gets its
  own `randomUUID()`; resubmitting the same words is a legitimate repeat
  note, not a retry. A new `sourceTypeEnum` value, `"manual"`
  ([backend/drizzle/0009_clumsy_reaper.sql](backend/drizzle/0009_clumsy_reaper.sql)),
  distinguishes these in the audit trail from gmail/circleback/document
  sources. The frontend form lives beside the suggestion queue itself
  ([frontend/app/review/page.tsx](frontend/app/review/page.tsx)) rather than
  on its own page, since the note's own resulting suggestion (if any) lands
  in that same queue — submitting reports back either "N suggestions now
  pending review below" or, honestly, "nothing operational was found in it"
  when the noise filter (which still fails open, same as every other source)
  screens it out.
- Two Decision Center actions on `/decisions`: "Add information" and
  "Assign", both restricted to `open` decisions (a decided one is closed —
  `PATCH .../add-info` and `PATCH .../assign`
  ([backend/src/routes/decisions.ts](backend/src/routes/decisions.ts)) both
  409 on one, same conflict handling as `.../resolve`).
  `addDecisionInfo`/`assignDecision`
  ([backend/src/decisions/manage.ts](backend/src/decisions/manage.ts)) write
  distinct `decision.info_added`/`decision.assigned` audit_log actions rather
  than the generic `decision.updated` `updateDecision` already writes (that
  one stays reserved for the AI-interpretation-match path) — so the Activity
  feed can label them precisely rather than falling back to a humanized raw
  action string. "Add information" *appends* a dated, attributed entry to
  `relevantContext` (`[2026-09-16 — user@domain] note text`) instead of
  overwriting it, since a decision can accumulate several rounds of new
  information before anyone is ready to decide, and forcing a reviewer to
  retype existing context to add one fact would be a good way to lose it by
  accident. "Assign" sets `decider` (who is on the hook to decide) — distinct
  from `stakeholders` (who needs to be consulted/informed), which these
  actions don't touch. The frontend
  ([frontend/app/decisions/page.tsx](frontend/app/decisions/page.tsx)) adds
  both as inline forms alongside the existing "Mark decided" one, updating
  only the changed field in local state on save rather than replacing the
  whole card (the PATCH response is the raw `decisions` row, without the
  `relatedTaskTitle`/`relatedTaskStatus` join the list endpoint adds).
- Source-count and blocking-decision tags on task cards in the Company Map
  tree and dashboard lists, so "has this been backed by a real source" and
  "why is this stuck" are visible at a glance without opening the task.
  `taskSourceCounts`/`blockingDecisionsForTasks`
  ([backend/src/tasks/sourceCounts.ts](backend/src/tasks/sourceCounts.ts),
  [backend/src/tasks/blockingDecisions.ts](backend/src/tasks/blockingDecisions.ts))
  are shared, batch (not N+1) lookups keyed by task id — `taskSourceCounts`
  is all-time (every approved suggestion ever citing a task), deliberately
  distinct from `reports.ts`'s own week-scoped source count.
  `blockingDecisionsForTasks` factors out the same open-decision-pointing-
  at-a-task lookup `GET /api/tasks/:id` already did for one task, now reused
  across many. `GET /api/company-map`
  ([backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts)) and
  `GET /api/dashboard/needs-attention`/`recent-progress`
  ([backend/src/routes/dashboard.ts](backend/src/routes/dashboard.ts)) all
  merge both onto their task rows in memory, the same "few flat queries,
  joined in memory" pattern this codebase already uses rather than one
  bigger multi-join query. The frontend renders a neutral "N sources" chip
  (hidden at zero, not a bare "0") wherever a task row appears
  ([frontend/app/company-map/page.tsx](frontend/app/company-map/page.tsx),
  [frontend/app/page.tsx](frontend/app/page.tsx)), plus a red "blocked by
  decision" chip on Company Map task rows specifically -- the dashboard's
  Needs Attention list already had a full blocking-decision sentence, so it
  only gains the source-count chip, not a redundant second decision tag.
- Confidence tiering and a reviewed-history view on `/review`, closing two gaps
  in the review queue: every suggestion carried a `confidence` score but the
  queue rendered one flat list, and an approved/rejected suggestion vanished
  from the page entirely with no way to see it again short of reading raw
  `/activity` entries.
  [frontend/app/review/page.tsx](frontend/app/review/page.tsx) now splits the
  pending+edited queue into "Ready to approve" (confidence at or above a single
  `CONFIDENCE_THRESHOLD` constant, `0.7`) and "Needs a closer look" (below it)
  sections, each rendered only when it has at least one item; the threshold is
  set from `interpret.ts`'s own system-prompt framing of confidence (0-1, "how
  sure the model is that this specific target and diff are correct") since the
  prompt draws no other line itself. A Pending/Approved/Rejected tab row toggles
  between the live queue and a read-only history view for the other two
  statuses — same title/diff/reasoning/source card, minus the approve/reject/edit
  actions, plus who reviewed it and when. On the backend,
  `GET /api/suggestions` ([backend/src/routes/suggestions.ts](backend/src/routes/suggestions.ts))
  already filtered correctly on an explicit `?status=` (verified against the
  existing code, not assumed, before touching it) and keeps defaulting to
  pending+edited with no param; it now also left-joins `users` on
  `suggestions.reviewedBy` (mirroring how `activity.ts` resolves `actorId`) to
  return `reviewedAt`/`reviewerName`/`reviewerEmail` alongside every row.
  [frontend/lib/api.ts](frontend/lib/api.ts) adds `fetchSuggestionsByStatus` next
  to the existing `fetchPendingSuggestions`, and extends the `Suggestion` type
  with the three new fields.
- A Company Map overview page, plus richer context throughout — the piece of
  user feedback ("still very sparse... company map is missing") this session
  closes, in four parts:
  - **The actual Company Map.** Every prior "Company Map" page was drill-down
    only — one level at a time, no page showing the whole Objective →
    Initiative → Project → Task tree at once, and no nav entry for it.
    `GET /api/company-map` ([backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts)),
    `requireAuth`-gated and org-scoped, assembles the full nested tree from
    four flat, org-scoped queries (one per level) run in parallel and joined
    in memory by parent id, rather than one query per objective — stays flat
    regardless of tree size. Task nodes include `latestUpdate`/`nextAction`
    inline (the app's scale makes the extra response size worth saving a
    click). [frontend/app/company-map/page.tsx](frontend/app/company-map/page.tsx)
    renders it as an expand/collapse tree (`frontend/app/components/Nav.tsx`
    gains a "Company Map" link, ungated like Dashboard/Review/Decisions/
    Activity): objectives and initiatives start expanded (seeing the whole
    structure at once is the point), projects start collapsed (task lists are
    the most numerous leaf level, the one place a real org's map could get
    unwieldy). Each node is its own small component
    (`ObjectiveNode`/`InitiativeNode`/`ProjectNode`/`TaskRow`) with manual
    React-state expand/collapse rather than nested native `<details>`, since a
    `<summary>` containing a `<Link>` makes click targets conflict; clicking a
    title still navigates to that item's existing detail page — this is a map,
    not a replacement for drill-down detail.
  - **Rollup chips at every level, not just the top.** Only the dashboard's
    objective cards had a task-status breakdown; initiative/project detail
    pages just listed child rows with no "what's the state of everything under
    here" summary. The initiative and project detail endpoints
    ([backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts))
    now return a `taskCounts` breakdown alongside their existing response —
    real SQL `groupBy`/`count`, scoped by `initiativeId` (joined up through
    projects, since tasks don't carry it directly) or `projectId` respectively
    — reusing the exact rollup shape dashboard.ts already established rather
    than reinventing it: `TASK_STATUSES`/`TaskCounts`/`emptyTaskCounts` moved
    out of dashboard.ts into [backend/src/tasks/rollup.ts](backend/src/tasks/rollup.ts)
    so all three routes share one definition. The frontend's chip-row
    rendering (workflow-ordered statuses, attention/done color variants) moved
    the same way, from `frontend/app/page.tsx` into
    [frontend/app/components/TaskStatusChips.tsx](frontend/app/components/TaskStatusChips.tsx),
    now used by the dashboard, [frontend/app/initiatives/[id]/page.tsx](frontend/app/initiatives/[id]/page.tsx),
    and [frontend/app/projects/[id]/page.tsx](frontend/app/projects/[id]/page.tsx) alike.
  - **Richer history on task detail pages.** `GET /api/tasks/:id`'s
    `approvedSuggestions` now also returns each suggestion's `proposedDiff`;
    the task page renders it with the same `formatDiff` logic the review page
    uses, moved to [frontend/lib/formatDiff.ts](frontend/lib/formatDiff.ts) so
    "what changed" reads identically in both places instead of two
    implementations drifting apart. A history entry now reads as "here's what
    happened and when," not just a bare reasoning string and a date.
  - **Source evidence, available but not prominent.** Per explicit user
    feedback, source content needed to be *available* on suggestion/decision
    cards without competing with the title/reasoning/diff for attention.
    [backend/src/routes/sources.ts](backend/src/routes/sources.ts) adds
    `GET /api/sources/:id` (`requireAuth`-gated, org-scoped, 404 for a
    malformed/nonexistent/other-org id) returning one source's full row
    including `rawBody` — kept out of the `GET /api/suggestions`/
    `GET /api/decisions` list responses (which only ever needed
    type/externalId/receivedAt, now also `id` on the suggestions join) so a
    potentially-long raw email/transcript body isn't bundled into every list
    fetch when it's usually never read.
    [frontend/app/components/SourceToggle.tsx](frontend/app/components/SourceToggle.tsx)
    is a plain `<details>`/`<summary>` "View source" toggle — collapsed by
    default, zero extra state for open/close, fetching the body lazily via
    `fetchSource` only on first open — used on both
    [frontend/app/review/page.tsx](frontend/app/review/page.tsx) (every
    suggestion card) and [frontend/app/decisions/page.tsx](frontend/app/decisions/page.tsx)
    (only when a decision has a `sourceId`).
  - A shared `UUID_RE` malformed-id check, previously only in companyMap.ts,
    moved to [backend/src/routes/uuid.ts](backend/src/routes/uuid.ts) so the
    new sources route uses the identical check rather than a second copy.
- An `owner` field on objectives/initiatives/projects/tasks, closing the other
  half of the "company map is missing stakeholders and related people"
  feedback. Every card in the reference Lovable app this session is
  maturing showed "Owner: [Name]"; scoped here to a single nullable
  `owner` text column per level (`backend/src/db/schema.ts`), not a
  `decisions`-style `stakeholders` array -- `owner` (singular, "who's
  responsible") is the proven-useful pattern the feedback actually calls
  for, and a full stakeholders array at four levels is real added UI scope
  with no evidence yet that it's needed; a natural follow-up if it is.
  [backend/src/suggestions/apply.ts](backend/src/suggestions/apply.ts)'s
  `ALLOWED_FIELDS` whitelists `owner` for objective/initiative/project/task
  only, deliberately excluding `decision` (which already owns `decider`/
  `stakeholders`). The interpretation pipeline
  ([backend/src/interpretation/interpret.ts](backend/src/interpretation/interpret.ts))
  can propose `owner` in a suggestion's `proposedDiff` only when the source
  names a specific person as doing or owning the work -- same
  evidence-based restraint as the rest of the prompt, never defaulting to
  the sender's name. Every dashboard/company-map/detail response in
  [backend/src/routes/dashboard.ts](backend/src/routes/dashboard.ts) and
  [backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts) now
  includes `owner`, and the frontend renders a small "Owner: X" line
  (`.owner-line` in `frontend/app/globals.css`) on the dashboard, every
  level of the company-map tree, and all four detail pages -- omitted
  entirely, not shown blank, when unset.
- A Weekly Report page, a deterministic, structured roll-up of one week's
  real data -- deliberately **not** an AI-generated summary (no Claude call,
  no narrative paragraph; every figure is a direct read or an in-memory
  group/count of rows that already exist, credits or no credits). `GET
  /api/reports/weekly?weekOf=YYYY-MM-DD`
  ([backend/src/routes/reports.ts](backend/src/routes/reports.ts)),
  `requireAuth`-gated and org-scoped, resolves `weekOf` (any date inside the
  target week, defaulting to the current week) to a Monday-start week
  computed in UTC as the half-open range `[weekStart, weekStart + 7d)` -- a
  task updated at exactly the following Monday belongs to next week, not
  this one, tested at both edges. The response carries `weekStart`/`weekEnd`
  (display dates, Monday/Sunday), `decisionsNeeded` (every open decision,
  current-state rather than date-filtered, same shape/ordering as `GET
  /api/decisions`), `blockers` (every currently blocked task org-wide with
  its full parent chain, also current-state), `workstreams` (tasks whose
  `updatedAt` actually falls inside the week, grouped by the objective they
  roll up to -- only objectives with at least one in-range task appear, only
  in-range tasks are listed), a `sources` appendix, and a `taskCount`. The
  traceability chain for `workstreams`/`sources` walks from a week-updated
  task to the approved suggestion(s) that produced the change
  (`suggestions.targetType='task' AND targetId=<task> AND status='approved'
  AND reviewedAt` inside the same week) to that suggestion's source, so every
  task row's `sourceCount` and the appendix's source list are both real
  citations, not every source in the org. The task -> project -> initiative
  -> objective join chain (previously written twice, in dashboard.ts's
  needs-attention and recent-progress) is now shared via
  [backend/src/tasks/parentChain.ts](backend/src/tasks/parentChain.ts)'s
  `taskParentChainQuery`, used by both those existing routes and by this
  one's blockers/workstream queries, rather than becoming a third and fourth
  copy. The frontend
  ([frontend/app/reports/weekly/page.tsx](frontend/app/reports/weekly/page.tsx),
  linked from the nav as "Weekly Report") renders the header (date range,
  task count, Prev/Next week buttons that just adjust `weekOf` and refetch)
  followed by Decisions Needed, Blockers, one card per workstream, and the
  Sources appendix, each with a terse "None." empty state; a "Copy report"
  button builds a plain-text (not HTML) rendering of the already-fetched JSON
  client-side and copies it via `navigator.clipboard.writeText`, with a
  transient "Copied" label on the button itself rather than a toast.
- **Context suggestions can no longer overwrite a task/objective/initiative/
  project's current operational state.** Closes a real gap: `context`
  (Info Share) suggestions were only conventionally supposed to add
  background, not change `status`/`latestUpdate`/`nextAction` -- but nothing
  in code actually enforced that, so an AI-authored (or hand-edited) context
  suggestion could legally set `latestUpdate` exactly like an
  `operational_update` one could.
  [backend/src/suggestions/apply.ts](backend/src/suggestions/apply.ts)'s
  `pickAllowedFields` now takes `changeType` as well as `targetType`: when
  `changeType === "context"` on one of the four hierarchy types, the
  whitelist narrows from the normal `ALLOWED_FIELDS` set down to just
  `description`/`owner` (`CONTEXT_ONLY_FIELDS`) -- `decision` is untouched,
  since it already has its own changeType vocabulary and a dedicated
  `relevantContext` field for this. Enforced at all three call sites that
  ever sanitize a diff (`interpret.ts`'s post-tool-call sanitization,
  `approveSuggestion`, and `editSuggestion`), so it holds regardless of
  whether the offending field came from the model or from a reviewer's edit.
  [interpret.ts](backend/src/interpretation/interpret.ts)'s `SYSTEM_PROMPT`
  now also explicitly explains the operational_update-vs-context
  distinction and which fields context is restricted to, so the model is
  steered toward the right changeType up front rather than relying on
  fields being silently stripped after the fact.
- **Evidence grounding for `owner`/`status`/`dueDate`, and a fabricated-
  ingestion-date guard.** Closes another real gap: nothing previously
  stopped the model from writing a plausible-sounding but ungrounded owner,
  status, or due date straight into a suggestion at full confidence. The
  `propose_suggestion` tool now has an `evidenceQuotes` field (verbatim
  quotes from the source); whenever `proposedDiff` sets `owner` or `status`
  on a hierarchy target, or `dueDate` on a decision,
  [interpret.ts](backend/src/interpretation/interpret.ts)'s
  `stripUngroundedProtectedFields` checks that at least one quote is an
  actual (whitespace/case-insensitive) substring of the raw source body --
  an invented or paraphrased "quote" doesn't count, since it won't literally
  match. If nothing grounds it, only that field is dropped; the rest of the
  diff (and the suggestion itself) still goes through for review. Separately,
  `stripFieldsWithFabricatedDates` catches a specific hallucination pattern
  seen in practice: the model restating the source's own ingestion date
  (`Received: ...` in the prompt) as if the source had stated it -- e.g.
  writing "As of September 14, 2026, the vendor confirmed..." purely because
  that's when the message happened to arrive. It checks a few common
  renderings of the source's `receivedAt` against both the proposed text and
  the source body itself: if the date appears in the proposal but the source
  never actually said it, the whole field is dropped (not surgically edited,
  to avoid leaving a mangled sentence behind) -- a source that genuinely does
  reference its own received date is left alone. Both checks run inside
  `validateSuggestionInput`, after `pickAllowedFields`, so they apply
  regardless of changeType. `SYSTEM_PROMPT` explains both requirements up
  front so the model doesn't waste a call on a field that'll just get
  stripped.
- **Current-vs-proposed state on the review card**, closing the gap where a
  suggestion showed what the AI wants to change a field to but not what it
  currently is. `GET /api/suggestions`
  ([backend/src/routes/suggestions.ts](backend/src/routes/suggestions.ts))
  now also returns `currentState` per suggestion: `loadCurrentStates` batch-
  fetches (one query per targetType actually present among the returned
  rows, not N+1) the live row for every suggestion's `(targetType,
  targetId)`, org-scoped, then `pickCurrentStateFields` narrows each one
  down to just the keys the suggestion's own `proposedDiff` touches --
  `null` for a brand-new entity (`targetId` null) or an unresolved target.
  The frontend's `formatDiffWithCurrentState`
  ([frontend/lib/formatDiff.ts](frontend/lib/formatDiff.ts)) renders
  `field: current → proposed` for any key present in both, falling back to
  the old plain `field: proposed` form otherwise; wired into
  [frontend/app/review/page.tsx](frontend/app/review/page.tsx)'s pending
  queue only -- the Approved/Rejected history tabs keep the plain diff,
  since by the time something's approved `currentState` and the proposed
  value are usually the same thing, which would read as a confusing no-op
  arrow.
- **Cross-source deduplication**, so a newer source describing something
  already awaiting review enriches the existing pending suggestion instead
  of spawning a second review card for the same underlying event.
  [backend/src/suggestions/dedupe.ts](backend/src/suggestions/dedupe.ts)'s
  `mergeOrInsertSuggestion` replaces `pipeline.ts`'s old direct
  `insert(suggestions)` call: when a draft's `targetId` is set (an update to
  something that already exists -- a brand-new-entity draft has nothing to
  merge into by definition) and a `pending`/`edited` suggestion already
  targets that exact `(targetType, targetId)`, it enriches that row instead
  of inserting a new one -- `proposedDiff` fields merge shallowly (the newer
  draft wins on overlapping keys, older/hand-edited fields it doesn't touch
  survive), `reasoning` is *appended* to rather than replaced so neither
  source's rationale is lost, `confidence` takes the newer read, and
  `sourceId` moves to the newest source (consistent with this app's general
  newer-evidence-precedence principle). `status` is deliberately left alone
  either way -- enrichment isn't a review decision, so an in-progress
  hand-edit doesn't get silently reset to `pending`. Writes a
  `suggestion.enriched` audit_log entry (no actor -- this happens as a side
  effect of ingestion, same as suggestion creation itself was never
  audit-logged) so it's visible on `/activity`, labeled via
  [frontend/app/activity/page.tsx](frontend/app/activity/page.tsx)'s
  `ACTION_LABELS`.
- **Planned-vs-happened and negation/correction guidance in the
  interpretation prompt.** Two related reading traps that were previously
  unaddressed: (1) treating a stated *intention* ("Don will run the test,"
  "shipping is scheduled for Friday") as if it were a completed fact, and
  (2) missing that a sentence containing a completed-sounding phrase inside
  a negation ("this was **not** completed") is evidence against that
  status, not for it, or that a later message corrects an earlier claim.
  `SYSTEM_PROMPT` ([backend/src/interpretation/interpret.ts](backend/src/interpretation/interpret.ts))
  now explicitly walks through both with concrete examples and tells the
  model to lower confidence rather than guess when it's genuinely
  ambiguous. Unlike the rest of this session's safeguards, this one is
  **prompt-only, not mechanically enforced** -- there's no reliable way to
  validate "did the model correctly read a negation" in code without
  another model call, so the only test coverage is a smoke test asserting
  the guidance text is actually present in `SYSTEM_PROMPT` (protects
  against accidental regression, not against the model getting it wrong).
  Whether it actually improves real interpretation quality can only be
  judged once the real historical batch run happens.
- **A typed relationship graph between Company Map entities, plus
  first-class external Company Entities** (Duke, FDA, NIH, a vendor -- orgs
  and people worth tracking for their relationships to real work, but not
  part of the Objective/Initiative/Project/Task hierarchy and not an app
  user). Two new tables
  ([backend/src/db/schema.ts](backend/src/db/schema.ts)):
  `company_entities` (`name`, free-text `kind` -- deliberately not an enum,
  since a real entity like Duke is a trial site, a university, and a
  collaborator all at once, so a fixed category would misrepresent more
  entities than it would classify -- and `notes`), and `entity_relationships`
  (a directed, typed edge between any two nodes: `fromType`/`fromId` ->
  `toType`/`toId`, both drawn from a six-member `entity_node_type` enum --
  the four hierarchy levels, `decision`, and `company_entity` -- plus a
  10-member `relation_type` enum lifted directly from the design doc this
  session was auditing against: depends_on, blocks, informs, affects,
  part_of, funded_by, performed_by, awaiting_response_from, coupled_with,
  constrains). `fromId`/`toId` are deliberately plain uuids with no FK
  constraint (a single column can't reference six different tables), so
  [backend/src/relationships/manage.ts](backend/src/relationships/manage.ts)'s
  `createRelationship` validates both ends exist and belong to the caller's
  org in application code before the edge is allowed, and rejects a
  self-referential edge. This graph is **human-curated, not AI-proposed** --
  `createdBy` is required and nothing in the interpretation pipeline writes
  here, a deliberate scope line for this session. `listRelationshipsForEntity`
  returns every edge touching one entity from either side, oriented relative
  to it (`direction: "outgoing" | "incoming"`), with the other side's
  name/title batch-resolved (one query per type present, not N+1) rather
  than making the frontend resolve six different id spaces itself.
  `GET/POST /api/company-entities` and `GET/POST/DELETE /api/relationships`
  ([backend/src/routes/entities.ts](backend/src/routes/entities.ts),
  [backend/src/routes/relationships.ts](backend/src/routes/relationships.ts))
  are `requireAuth`-gated like decisions (not admin-only). The frontend adds
  a `/company-entities` list+add page and a shared
  [RelationshipsPanel](frontend/app/components/RelationshipsPanel.tsx) --
  wired into all four Company Map detail pages (objective/initiative/
  project/task) -- that lists existing relationships and a mini form to add
  one: pick a relation type, a target type, then a target chosen by name
  from a live-fetched list (the Company Map tree flattened client-side for
  the four hierarchy types, `fetchOpenDecisions` for decisions,
  `fetchCompanyEntities` for entities) rather than typing a raw id, plus a
  single checkbox to reverse which side is "this" vs. "the target" instead
  of two separate from/to entity pickers. **Not yet wired into `/decisions`**
  (its cards, not per-id detail pages, would need their own integration) --
  the API fully supports `decision` as either side of a relationship today,
  only the dedicated UI section there is deferred.
- **Per-task/decision visibility levels (Team/Leadership/Restricted).** A
  `visibility` enum column (default `team`) on `tasks` and `decisions`
  ([backend/src/db/schema.ts](backend/src/db/schema.ts)), deliberately
  excluded from `ALLOWED_FIELDS`
  ([backend/src/suggestions/apply.ts](backend/src/suggestions/apply.ts)) so
  no AI suggestion can ever change it -- visibility is a human-only, admin-only
  call. This app has exactly two roles (`member`/`admin`), so the mapping is
  honest rather than invented: `team` is visible to anyone, and
  **both** `leadership` and `restricted` gate on `admin`
  ([backend/src/access/visibility.ts](backend/src/access/visibility.ts)'s
  `canViewVisibility`) -- there's no real third role to give `leadership` its
  own distinct audience, so rather than fabricate one, the two upper levels
  currently collapse to the same enforcement and exist as separate values
  for future role granularity and for labeling intent in the UI today.
  `visibilityFilter` splices an `eq(column, "team")` predicate (or no filter,
  for an admin) into every list/detail query that touches tasks or
  decisions -- dashboard (`needs-attention`/`recent-progress`), the Company
  Map tree and project task list, `/api/tasks/:id`, `GET /api/decisions`,
  search, the weekly report, and the suggestion review queue (a suggestion
  targeting a restricted task/decision is hidden from a member's queue, and
  the approve/edit/reject routes 404 rather than 403 if a member tries one
  directly, so a probing request can't distinguish "restricted" from
  "doesn't exist"). Two admin-only routes,
  `PATCH /api/tasks/:id/visibility` and `PATCH /api/decisions/:id/visibility`
  ([backend/src/routes/companyMap.ts](backend/src/routes/companyMap.ts),
  [backend/src/routes/decisions.ts](backend/src/routes/decisions.ts)), are
  the only way to change it. The frontend adds a shared
  [VisibilityControl](frontend/app/components/VisibilityControl.tsx) --
  an admin gets a live `<select>` on the task detail page and each decision
  card; a member sees nothing for `team` items (the common case) and a
  plain read-only badge for the rare `leadership`/`restricted` item an admin
  chose to still surface to them by other means. Two known, deliberate gaps
  rather than bugs: the aggregate task-status counts (dashboard's
  status-summary strip, and the Objective/Initiative/Project `taskCounts`
  rollups) still count restricted tasks toward their totals -- unfiltered
  counts, not unfiltered content; and a task's surfaced `blockingDecision`
  (title + link, shown when a task is blocked on an open decision) isn't
  itself visibility-checked, so a restricted decision's title could appear
  on an otherwise-visible task's page.
- An actual inbound-email provider account connected to the new `/api/public/webhooks/email`
  endpoint (the endpoint exists and is tested against a Postmark-shaped payload,
  but no real provider has been wired up yet — see the email integration section
  above).
- An async job queue for webhook ingestion (Circleback and email webhooks
  currently both run the interpretation pipeline synchronously in-request).
- Styling polish beyond "readable and scannable."

## Security notes

- `suggestions` is the only table the AI pipeline writes to directly. Nothing in
  `objectives`/`initiatives`/`projects`/`tasks` is mutated except through an
  approved suggestion.
- `audit_log` is append-only — application code only ever inserts into it.
- `sources.raw_body` is retained for the interpretation pipeline to read; there is
  no retention/purge job yet (out of scope for this slice).
- Every ingestion path runs through `runInterpretationPipeline`
  ([backend/src/interpretation/pipeline.ts](backend/src/interpretation/pipeline.ts)),
  which redacts patient identifiers
  ([backend/src/interpretation/redactPatientIdentifiers.ts](backend/src/interpretation/redactPatientIdentifiers.ts))
  before anything is inserted into `sources.raw_body` or handed to the noise
  filter/interpretation pass -- raw unredacted content is never persisted, not
  even transiently. Redaction uses Sonnet with forced tool-use, the same
  structured-output pattern as `interpret.ts`/`noiseFilter.ts`. Unlike the noise
  filter (which fails open), this pre-pass fails **closed**: if the redaction
  call itself errors or returns an untrustworthy result, the `sources` row is
  still written for traceability but with a safe placeholder body, and the
  pipeline stops there -- no noise check, no interpretation, no suggestion --
  leaving it for manual review.
