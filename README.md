# CertiFlow

Skilling certificate issuance platform for the Pragati Skills Mission (hackathon project).

> **Status: Phase 1 of 7 (foundation).** The full requirements note, architecture write-up,
> `DEPLOYMENT.md` and AI-usage note arrive in Phase 7. This README covers what exists today.

## Run it

Needs Docker Desktop (Compose v2) and nothing else.

```bash
docker compose up --build        # starts everything, applies migrations, loads demo data
```

| What | Where |
|---|---|
| Web app (switch-user demo) | http://localhost:8080 |
| API | http://localhost:3000 (`/health`) |
| Fake WhatsApp provider | http://localhost:4000 |
| Postgres (DBeaver / pgAdmin) | `localhost:5432`, user/password/db all `certiflow` |
| Redis | `localhost:6379` |

Demo people: **Anika** (training centre), **Dev, Meera, Kabir** (district officers, Riverside),
**Neha** (quality), **Farah** (state office), plus **Isha**, an officer in a *different* district
(not in the brief; she exists so we can prove district isolation later).

## Run the tests

Tests use the real Postgres and Redis (not mocks), because the rules being proven live there.

```bash
docker compose up -d postgres redis
cd backend && npm install && npm test      # applies migrations + seed itself
```

## What exists (Phase 1)

- **6 containers:** postgres, redis, api, worker (same image as api, different command),
  fake-whatsapp, web (nginx serving the React build and proxying `/api`).
- **Schema** (Prisma, migrations in `backend/prisma/migrations`): District, Centre, User,
  Setting, WorkflowStep.
- **Switch-user login** (`/auth/demo-login`, demo mode only) issuing signed tokens; `/me`; `/config`.
- 38 automated tests (auth tampering, role checks, soft delete, DB constraints, config-as-data).

## Design decisions (and why)

**Every table has the same standard columns:** `id`, `createdAt`, `updatedAt`, `isActive` (soft
delete: false = deleted), `createdById`, `updatedById`, `meta` (JSON). Adding a table or attribute is routine, and
`meta` takes new attributes with no migration. Soft delete is applied centrally in
`backend/src/db.ts`: normal queries hide inactive rows and `delete()` becomes "set isActive = false".
Uniqueness ignores deleted rows (partial unique indexes, hand-written in the migration).
Append-only tables added later (audit log, approvals) deliberately skip `updatedAt`/`isActive`.

**Rules are data, not code.** The approval path (`WorkflowStep`: who acts, own-district scope,
how many approvals, SLA, "applies when") and tunables (`Setting`) live in the database. Edit a
row and behaviour changes within ~15 seconds with no redeploy (verified against running
containers). Config is cached in Redis with a 15 s expiry; if Redis is down it falls back to the
database. The database rejects nonsense (e.g. 0 required approvals) via CHECK constraints.
Defaults come from the brief: 2 district approvals, quality review for batches of 50+, state
final approval, 48 h SLA. These numbers are my choices, not the brief's. Seeding never
overwrites a value someone edited.

**Identity:** the token holds only the user id. Role/district are re-read from the database on
every request, algorithm and issuer are pinned, and the server (not the UI) enforces roles.
No CORS: the browser only talks to its own origin, which proxies to the API.

**API and worker share one image** and scale independently; neither keeps state in memory.

## Known limitations (honest list)

- Soft delete is a flag, so the moment of deletion is not stored (only `updatedAt`, which also
  moves on any later edit). Add a `deactivatedAt` column or an audit entry if that is ever needed.
- `createdById` / `updatedById` are plain columns, not foreign keys, and nothing fills them in
  yet (needed once there are writes by real users).
- Roles are a database enum: a *new role* needs one migration. Changing which role handles a
  step, counts, SLAs, order and thresholds do not.
- Config is edited in the database; there is no admin screen yet (and so no audit of config edits).
- The worker is an empty shell until Phase 4; fake WhatsApp does not fail yet (Phase 4).
- The worker container has no health check yet.
- The React page was built and served but only checked through HTTP, not clicked through by hand.

## Layout

```
backend/        Express + TypeScript API and worker (src/), Prisma schema + migrations (prisma/), tests (test/)
web/            React + Vite, built and served by nginx
fake-whatsapp/  Stand-in WhatsApp provider
docker-compose.yml
```
