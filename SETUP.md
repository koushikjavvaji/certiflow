# Setup guide

From a fresh clone to a running system with demo data and passing tests.

## You need
- **Docker Desktop** (Compose v2): `docker compose version` should print a version.
- **Node.js 22+** only if you want to run the tests or the smoke script outside Docker (`node -v`).

Nothing else: no database, Redis or `.env` file is required.

## 1. Start everything

```bash
git clone <repo-url> certiflow && cd certiflow
docker compose up --build
```
The first build takes a few minutes. When it settles you have six containers:

| Container | What it is | Where |
|---|---|---|
| `web` | The React app (nginx), also forwards `/api/*` to the API | http://localhost:8080 |
| `api` | Express API. Applies migrations and loads demo data on start | http://localhost:3000/health |
| `worker` | Background jobs: certificates, PDFs, WhatsApp, overdue scan | (no port) |
| `fake-whatsapp` | Stand-in WhatsApp provider that fails on purpose | http://localhost:4000/messages |
| `postgres` | Database | `localhost:5432` (user, password and db are all `certiflow`) |
| `redis` | Queues, live updates, cache | `localhost:6379` |

Check: `docker compose ps` shows `healthy`, and `curl localhost:8080/api/health` returns
`{"status":"ok",...}`.

## 2. Try it

Open **http://localhost:8080** and use the *act as* dropdown.

| Person | Role |
|---|---|
| Anika | Training centre (Sunrise Skills Centre, Riverside district) |
| Dev, Meera, Kabir | District officers (Riverside) |
| Neha | Quality team |
| Farah | State office |
| Isha | District officer in a *different* district (to show isolation) |

**Suggested walk-through:** as Anika create a batch and upload `bad-rows` (see the errors, nothing
saved) then `big-60`, and submit. Switch to Dev then Meera and approve. Neha approves (60 is a big
batch). Farah approves. Watch the certificates arrive live. Open a certificate's verification link,
cancel it as Farah, and reload the link. Sample CSVs are linked on the centre's upload screen and also
live in `web/public/samples/`. (A person can be certified once per course, so each sample works once
per fresh database; see "Start over".)

To watch the whole journey run by itself: `node scripts/smoke.mjs` (Node 18+; it plays every role).

## 3. Run the tests

The tests use the real Postgres and Redis, but in their **own** database and Redis namespace, so they
never touch demo data.

```bash
docker compose up -d postgres redis      # if the stack is not already running
cd backend
npm install
npm test                                 # 106 tests, about 15 seconds
npm run typecheck
```
They create `certiflow_test` from scratch on every run (migrations + seed), so a fresh clone needs no
manual database steps.

## 4. Useful things to do

**Look inside the database** (DBeaver, TablePlus or pgAdmin: PostgreSQL, `localhost:5432`, user/password/db
`certiflow`), or from the terminal:
```bash
docker compose exec postgres psql -U certiflow -d certiflow
```

**Change a rule live** (no redeploy; takes effect within ~15 seconds). Example: make district approval need
3 officers, or make a batch overdue after 1 minute:
```sql
UPDATE "WorkflowStep" SET "requiredApprovals" = 3 WHERE key = 'DISTRICT_REVIEW';
UPDATE "WorkflowStep" SET "slaMinutes" = 1 WHERE key = 'DISTRICT_REVIEW';
```
More examples in the README, section 5. The "Live rules" panel in the app shows the current values.

**Make WhatsApp misbehave** (it is flaky by default, about 30% of calls fail):
```bash
curl -X PUT localhost:4000/mode -H 'content-type: application/json' -d '{"mode":"down"}'      # total outage
curl -X PUT localhost:4000/mode -H 'content-type: application/json' -d '{"mode":"reliable"}'  # never fails
curl -X PUT localhost:4000/mode -H 'content-type: application/json' -d '{"mode":"flaky"}'     # back to default
curl localhost:4000/messages                                                                   # what reached "phones"
```

**Run more workers** (jobs are shared between them; any can be killed at any time):
```bash
docker compose up -d --scale worker=3
```

**Follow one batch through the logs** (every line carries a request id; the same id is stored in the audit
log and follows the batch into the worker):
```bash
docker compose logs -f api worker
```

## 5. Start over

```bash
docker compose down -v        # stops everything and DELETES the database, queue and certificate files
docker compose up --build
```

## 6. Running without Docker (optional, for development)

```bash
docker compose up -d postgres redis
cd backend && npm install
export DATABASE_URL=postgresql://certiflow:certiflow@localhost:5432/certiflow
export REDIS_URL=redis://localhost:6379 JWT_SECRET=dev-only-change-me-please-use-a-long-random-string DEMO_MODE=true
npx prisma migrate deploy && npm run seed
npm run dev            # API on :3000          (second terminal: npm run dev:worker)
cd ../web && npm install && npm run dev        # UI on :5173, proxies /api to :3000
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `docker: unknown command: docker compose` | Install/start Docker Desktop, then reopen the terminal |
| Port 5432, 6379, 3000, 4000 or 8080 already in use | Stop the other program, or change the left side of the port mapping in `docker-compose.yml` |
| Tests fail to connect | Run `docker compose up -d postgres redis` and wait until both are `healthy` |
| A sample CSV is rejected as "already submitted" | That is the one-person-per-course rule working. Use a new course code, or `docker compose down -v` |
| Page shows "Choose a person…" but the list is empty | The API is still starting; wait for `docker compose ps` to show `api` healthy and reload |
