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
- **Auth:** Google OAuth, restricted to one Workspace domain
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
  `audit_log`, `webhook_integrations`.
- Google OAuth restricted to one Workspace domain, JWT session cookie.
- An allowlist + roles gate on top of that OAuth flow, replacing "any account on
  the domain auto-provisions": `authorized_users`
  ([backend/src/db/schema.ts](backend/src/db/schema.ts)) is a separate table from
  `users` (someone can be authorized before they've ever signed in) carrying a
  `user_role` (`member`/`admin`) per `(organizationId, email)`. The OAuth callback
  ([backend/src/auth/identity.ts](backend/src/auth/identity.ts)'s
  `findOrCreateUserForGoogleIdentity`) bootstraps a brand-new organization's first
  sign-in as `admin`, and otherwise requires an `authorized_users` row to exist or
  rejects the sign-in outright (no `users` row created). `role` is embedded in the
  session JWT only as a UI hint;
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
    org's current open objectives/initiatives/projects/tasks. Uses forced
    tool-use for structured output, strongly prefers matching/updating an
    existing item over proposing something new, and validates the model's
    response (schema, target-type/target-id membership in the context it was
    given, and the same field whitelist `suggestions/apply.ts` enforces)
    before it's trusted.
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
  page ("/"): a card per objective with status/priority badges, a chip per non-zero
  task status (status-board-style breakdown), a one-line "N initiatives · M needs
  attention" summary (needs_attention + blocked), and a completed/non-superseded
  progress bar. The suggestions review UI moved to
  [frontend/app/review/page.tsx](frontend/app/review/page.tsx) (`/review`), with a
  minimal shared nav ([frontend/app/components/Nav.tsx](frontend/app/components/Nav.tsx))
  linking the two.
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
  title, soonest `dueDate` first with nulls last), `POST /api/decisions`, and
  `PATCH /api/decisions/:id/resolve` (rejects an already-decided decision). Both
  writes append a `decision.created`/`decision.resolved` `audit_log` row. The
  frontend ([frontend/app/decisions/page.tsx](frontend/app/decisions/page.tsx),
  linked from the nav as "Decisions") lists open decisions with their stakeholder
  chips, due date (overdue ones called out in red), the three narrative sections,
  and the related task's title if set; a plain form creates one (title/decider/
  stakeholders/due date/narrative fields — `relatedTaskId`/`sourceId` are only
  settable via the API for now, no picker UI yet), and "Mark decided" resolves one
  inline, dropping it out of the open list. Not wired into the Claude interpretation
  pipeline yet — this pass is a human filling out a form, not AI-generated decisions.

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
- An activity feed, making the `audit_log` table (written by nearly every
  mutating action — suggestion review, decision review, user management,
  integration token management) actually viewable instead of write-only:
  `GET /api/activity` ([backend/src/routes/activity.ts](backend/src/routes/activity.ts)),
  `requireAuth`-gated and org-scoped, left-joins `users` on `actorId` for the
  actor's name/email (handling a null `actorId` gracefully rather than
  assuming every write site sets one) and returns the most recent 100 entries
  newest-first — no pagination yet, a fine limitation to leave for later.
  The frontend ([frontend/app/activity/page.tsx](frontend/app/activity/page.tsx)),
  linked from the nav for everyone (a read-only audit trail, not a privileged
  action, unlike `/users`/`/integrations`), renders a row-based list rather
  than one card per entry — lighter-weight for a feed that can run to 100
  rows — showing the actor (name, falling back to email, falling back to
  "System"), a small formatter mapping each known `action` string to plain
  English (`suggestion.approved` → "approved a suggestion", with a generic
  fallback for anything unmapped), a "View [entityType]" link into the
  Company Map detail pages when `entityType` is one of
  objective/initiative/project/task, and a relative timestamp.
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

Explicitly **not** built yet (next sessions):
- Real Gmail ingestion (the pipeline exists and is exercised via
  `npm run interpret:real -w backend`, but nothing yet calls it from a real
  Gmail source automatically).
- An async job queue for webhook ingestion (Circleback webhooks currently run
  the interpretation pipeline synchronously in-request).
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
