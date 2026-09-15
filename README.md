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
- The full data model: `organizations`, `users`, `objectives`, `initiatives`,
  `projects`, `tasks`, `sources`, `suggestions`, `audit_log`.
- Google OAuth restricted to one Workspace domain, JWT session cookie.
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
  - The original hardcoded/fake interpretation function
    ([backend/src/interpretation/fakeInterpret.ts](backend/src/interpretation/fakeInterpret.ts),
    still used by `npm run seed:fake`) is kept around for fast, offline tests
    and demos that shouldn't hit a real API.
- A minimal review UI: list pending suggestions with what/where/why/source,
  approve/reject. Approving applies the proposed diff to the target table inside
  a transaction and writes an `audit_log` row.
- Every core table carries `organization_id` directly, and every query is scoped
  to `request.user.organizationId` in the backend query layer — enforced in code,
  not relied on as a database-only property — even though there's one
  organization today.

Explicitly **not** built yet (next sessions):
- Real Gmail/Circleback ingestion (the pipeline exists and is exercised via
  `npm run interpret:real -w backend`, but nothing yet calls it from a real
  Gmail/Circleback source automatically).
- The dashboard / Company Map view.
- Styling polish beyond "readable and scannable."
- Editing a suggestion's proposed diff before approving (schema supports an
  `edited` status; no UI for it yet).

## Security notes

- `suggestions` is the only table the AI pipeline writes to directly. Nothing in
  `objectives`/`initiatives`/`projects`/`tasks` is mutated except through an
  approved suggestion.
- `audit_log` is append-only — application code only ever inserts into it.
- `sources.raw_body` is retained for the interpretation pipeline to read; there is
  no retention/purge job yet (out of scope for this slice) and ingestion code must
  strip patient identifiers before a row is ever written here.
