# CertiFlow

Certificate issuance platform for the (fictional) Pragati Skills Mission. Training centres upload
passed batches, officers approve them in stages, every candidate gets a certificate on WhatsApp,
and anyone can check a certificate is genuine without logging in.

- **Run it:** [SETUP.md](SETUP.md) (one command: `docker compose up --build`)
- **Production plan:** [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 1. Requirements note (my reading of the brief)

### What the programme office asked for
Centres upload passed batches and send them for approval. District officers check them (more than
one must agree), big batches get extra scrutiny, and the state office has the final say. After
approval every candidate gets a certificate on WhatsApp straight away. Officers can fix mistakes.
Anyone can verify a certificate. Files must not sit with an officer for days.

### Who uses it
| Person | Role in the system | Demo user |
|---|---|---|
| Training centre | Creates batches, uploads the spreadsheet, submits, fixes and resubmits | Anika |
| District officer | Reviews batches **from their own district** | Dev, Meera, Kabir |
| Quality team | Reviews big batches | Neha |
| State office | Final approval, sees stuck batches, cancels certificates | Farah |
| Candidate | Receives the certificate on WhatsApp and can download it | (no login) |
| Employer / public | Verifies a certificate | (no login) |

I added one extra demo person, **Isha**, an officer in a *different* district, so district
isolation can be demonstrated and tested. She is not in the brief.

### Where the brief was unclear, and what I decided
These are my decisions. Most are **data in the database**, not code, so they can be changed
without a redeploy (see section 5).

| Unclear point | My decision | Where it lives |
|---|---|---|
| "More than one officer" in a district | **2 different officers** of the batch's own district; one officer cannot approve twice | `WorkflowStep.requiredApprovals` |
| What is a "big batch"? | **50 or more candidates** goes through the quality team (49 skips it) | `WorkflowStep.condition` `{"minCandidates": 50}` |
| What can quality / state do? | Same as district officers: approve, send back (reason), reject (reason) | `WorkflowStep.role` |
| Send back vs reject | **Send back** = centre fixes and resubmits. **Reject** = closed for good; its candidates are freed to be submitted again | code (`workflow.ts`) |
| **What happens to approvals when a sent-back batch is resubmitted** (Moment 6) | **They are discarded and review restarts from the first step.** The data changed, so earlier approvals no longer describe what is being approved; keeping them would let a centre get approval and then edit. Old approvals stay in the database and audit log as history. A setting switches this off (resume at the same step, keep approvals) | `Setting` `resubmit.resetApprovals` |
| "Officers sometimes make mistakes, so they should be able to fix them" | An officer can **withdraw their own approval** while the batch is still at their step, and approve again. A wrong certificate can be **cancelled** by the state office after issue | `workflow.ts`, `certificates.ts` |
| "Files sitting with an officer for days" | Each step has an **SLA (default 48 h)**. A batch past it is flagged once, recorded in the audit log, announced live, and listed in the state office's **Stuck** tab. Nobody has to chase | `WorkflowStep.slaMinutes` |
| Same person in two batches | The same **phone + course** can exist once among active batches (database rule) | partial unique index |
| What does the public verify page show? | Status (valid / cancelled), certificate number, **masked** holder name, course, centre, issue date. **Never** phone or marks | `routes/certificates.ts` |
| How does a stranger look up a certificate? | By a random **verification code** printed on the PDF / in its QR code. The certificate number alone does **not** work, because numbers are sequential and guessable | |
| How does a candidate download? | A signed, unguessable link in the WhatsApp message. No login | `pdf.ts` |
| What is "the spreadsheet"? | A **CSV** with `name, phone, courseCode, marks (optional)` | `csv.ts` |
| Phone numbers | Indian mobile numbers, stored as `+91XXXXXXXXXX`; common spellings accepted | `csv.ts` |
| Certificate number | `PSM-<year>-<6 digits>` from a database sequence | |
| What do officers see of candidates? | Phone numbers **masked** (last 4 digits); only the owning centre sees them in full | `view.ts` |
| What do centres see of officers? | **Only the role** ("District officer"), never the individual's name, in approvals and history. Centres see their own name on their own actions. Staff see names (accountability) | `view.ts` |
| Do candidates / employers have accounts? | **No.** They can only open the signed download link and the public verify page; neither shows any officer or internal data | |
| Login | **Email + password** for every person (scrypt-hashed, rate limited). A **demo shortcut** (`DEMO_MODE=true`) additionally lets a reviewer switch person with no password, as the brief's demo setup asks; set it to `false` for the real thing | `routes/auth.ts`, `password.ts` |

### The six moments that must work, and where each is proven
| # | Moment | How it is handled | Proof (test file) |
|---|---|---|---|
| 1 | Spreadsheet with a few bad rows | Every row is checked and **every** problem reported by row; saved only if there are none, in one transaction | `intake.test.ts` |
| 2 | Two officers approve at the same moment | The batch row is locked (`SELECT … FOR UPDATE`), so the second request sees what the first did; it moves on exactly once | `workflow.test.ts` (incl. 12 batches raced at once) |
| 3 | 60 candidates, unreliable WhatsApp | A queue with retries, plus idempotency at every step: exactly one certificate and one message each | `issuance.test.ts` |
| 4 | Cancelled certificate | Verify reads the database every time (no cache), so the very next lookup says cancelled | `verify.test.ts` |
| 5 | Batch sits too long | Overdue scan flags it once, audits it, announces it, lists it for the state office | `overdue.test.ts` |
| 6 | Sent back and resubmitted | Documented decision above, as a setting, tested both ways | `workflow.test.ts` |

### The things that must never happen, and what stops them
| Must never happen | What stops it |
|---|---|
| Acting at a step that is not yours, or as someone else | Role + district checked **on the server** on every action; the token holds only the user id and role is re-read from the database; signature, algorithm, issuer and expiry are verified |
| Two certificates for a candidate, or a shared number | `UNIQUE(candidateId)` and `UNIQUE(number)`; numbers come from a database sequence; jobs are idempotent |
| A cancelled certificate showing as genuine | Verify never caches; cancelled certificates are never sent and their download link returns 410 |
| A stranger getting someone's certificate or details | Unguessable verification code and signed download link, rate-limited public lookup, masked phones, centres and districts cannot see each other's batches (404, not 403, so existence is not revealed) |
| An untraceable decision | Every action writes an audit row (who, what, when, why) **in the same transaction** as the change; the database refuses to update, delete or truncate the audit table |

---

## 2. Quick start

```bash
docker compose up --build         # everything, with demo data
```
Open **http://localhost:8080**, pick a person in the dropdown. Sample spreadsheets are linked in
the centre's upload screen (`small-5`, `big-60`, `bad-rows`). To watch the whole journey run by
itself: `node scripts/smoke.mjs`. Full details, including running the tests: [SETUP.md](SETUP.md).

---

## 3. How the system is put together

```
                      ┌────────────────────────────────────────────────────────┐
  Browser ──────────▶ │ web (nginx)  serves the React app, forwards /api/* ───┐│
  (React + Vite)      └───────────────────────────────────────────────────────┼┘
        ▲  live updates (SSE)                                                  ▼
        │                                              ┌──────────────────────────┐
        └───────────────────────────────────────────── │ api  (Express, stateless)│
                                                       └──┬───────────┬───────────┘
                          decisions + audit in ONE        │           │ enqueue event "batch.approved"
                          transaction                     ▼           ▼
                                              ┌──────────────┐   ┌────────────────────┐
                                              │ PostgreSQL   │   │ Redis              │
                                              │ source of    │   │ BullMQ queues,     │
                                              │ truth        │   │ pub/sub, config    │
                                              └──────▲───────┘   │ cache, rate limit  │
                                                     │           └─────────┬──────────┘
                                                     │                     │ jobs
                                              ┌──────┴─────────────────────▼──┐   HTTP    ┌───────────────┐
                                              │ worker (same image as api,    │ ────────▶ │ fake-whatsapp │
                                              │ scale it out independently)   │           │ (fails on     │
                                              │ events · issue jobs · sweeps  │           │  purpose)     │
                                              └───────────────────────────────┘           └───────────────┘
                                                        │ writes PDFs
                                                        ▼
                                               certs volume (S3 in production)
```

**Batch lifecycle:** `DRAFT → IN_REVIEW → APPROVED → ISSUING → COMPLETED`, with side exits
`CHANGES_REQUESTED` (back to the centre, then resubmit) and `REJECTED`. While `IN_REVIEW` it sits at
a step taken from the `WorkflowStep` rows (district → quality for 50+ → state).

**What happens when the state office approves (the event-driven part):**
1. The API commits the approval and the audit row in one transaction, then answers immediately.
2. It queues a `batch.approved` event (BullMQ). The approve click never waits for PDFs or WhatsApp.
3. A worker turns that event into one `issue` job per candidate.
4. Each `issue` job: create the certificate (unique per candidate) → make the PDF → send the WhatsApp
   message → record the attempt → mark delivered. On failure it is retried with exponential backoff;
   after all attempts it is marked `FAILED` and the state office can retry it.
5. When every candidate is done, the batch becomes `COMPLETED`. Everyone watching sees each change live.

---

## 4. Key technical decisions, with reasons

| Decision | Why |
|---|---|
| **BullMQ on Redis** as the queue | Redis is already needed (cache, pub/sub, rate limits), so no second system to run. It gives durable jobs, retries with backoff, job ids for de-duplication, rate limiting and repeatable jobs. Kafka/RabbitMQ would be more to operate for no benefit at this scale |
| **Postgres is the source of truth; the queue is only a to-do list** | If Redis loses everything, a 30-second **sweep** re-offers every approved batch from the database. Nothing is lost, and every job is idempotent so re-offering is harmless |
| **Row lock on the batch** (`FOR UPDATE`) for every decision | Simple and correct for "two officers at once". The second request waits, then sees the new state. Cheaper and safer than inventing optimistic-retry logic |
| **Idempotency everywhere in issuing** | Retries, duplicate events, two workers, a restart mid-job: none can make a second certificate or message. The WhatsApp call carries the certificate id as an *idempotency key*; the provider de-duplicates, which covers the nasty case where a message was delivered but the reply was lost |
| **Redis pub/sub + SSE** for live updates | Pub/sub fans an event out to every API instance; each pushes to its own browsers. Events carry only ids; the browser re-fetches through permission-checked endpoints, so the stream cannot leak data. Pub/sub is fire-and-forget, which is fine for a UI hint (anything important goes through the durable queue) |
| **Verify reads the database every time** | The brief says a cancelled certificate must never look genuine. A cache could show "valid" for a few seconds after cancellation. One indexed lookup is cheap, and the endpoint is rate limited. (If load ever demands it: a read replica, not a cache.) |
| **Rules are database rows** (`Setting`, `WorkflowStep`), cached in Redis for 15 s | The brief leaves thresholds open; they will change. A database edit takes effect within seconds with no redeploy. The database rejects nonsense (e.g. 0 approvals). If Redis is down, it reads the database directly |
| **Standard columns on every table + soft delete** (`isActive`) | `id`, `createdAt`, `updatedAt`, `isActive`, `createdById`, `updatedById`, `meta` (JSON) everywhere, so adding things is routine. Soft delete is applied in one place (`db.ts`): reads hide inactive rows and `delete()` becomes "set inactive". Uniqueness only counts active rows (partial indexes). `AuditLog` is the exception: append-only, enforced by a database trigger |
| **API and worker share one image** | One build, two commands. They scale independently (`docker compose up -d --scale worker=3`) and neither keeps state in memory, so any instance can restart at any moment |
| **Signed download links (HMAC)** | Nothing to store, unguessable, and a retried job rebuilds the same link |
| **No CORS** | The browser only talks to its own origin (nginx), which forwards `/api`. Cross-origin calls are refused |
| **CSV, validated all-or-nothing in one transaction** | Centres see every problem at once and can never end up with half a batch |

---

## 5. Changing the rules without a redeploy

Everything below is a database edit; the running API picks it up within ~15 seconds.

```sql
-- How many district officers must agree?            (default 2)
UPDATE "WorkflowStep" SET "requiredApprovals" = 3 WHERE key = 'DISTRICT_REVIEW';

-- What is a "big batch"?                              (default 50)
UPDATE "WorkflowStep" SET condition = '{"minCandidates": 30}' WHERE key = 'QUALITY_REVIEW';

-- How long may a batch wait at a step? (minutes)      (default 2880 = 48 h). For the demo:
UPDATE "WorkflowStep" SET "slaMinutes" = 1 WHERE key = 'DISTRICT_REVIEW';

-- Keep approvals when a sent-back batch is resubmitted? (default true = discard them)
UPDATE "Setting" SET value = 'false' WHERE key = 'resubmit.resetApprovals';
```
Run them with: `docker compose exec postgres psql -U certiflow -d certiflow`. The "Live rules"
panel in the web app shows the current values. Adding a **new step** is inserting a `WorkflowStep` row.

Two honest notes: editing a step changes batches **already in review** immediately (publish a new
`workflowVersion` and point `workflow.activeVersion` at it if you only want it for new batches), and
the scan interval setting (`escalation.scanIntervalSeconds`) is read when a worker starts.

---

## 6. Tests

121 automated tests against the **real** Postgres and Redis (not mocks), because the rules being
proven (unique constraints, row locks, queues) live there. They use their own database
(`certiflow_test`, recreated every run) and their own Redis db and queue prefix, so they never
touch demo data or get picked up by the running worker. They run the real queue with an in-process
worker and a WhatsApp stand-in that fails, times out and "delivers but loses the reply".

```bash
docker compose up -d postgres redis
cd backend && npm install && npm test
```
| File | What it proves |
|---|---|
| `intake.test.ts` | Moment 1; replace-not-append; one person per course; centres cannot touch each other's batches |
| `workflow.test.ts` | Moments 2 and 6; officer names hidden from centres; step order and the 49/50 boundary; rules-as-data edits; wrong role/district/step refused; withdraw; reject; audit trail; trace ids; live events |
| `issuance.test.ts` | Moment 3; worker restart mid-batch; lost-event recovery; concurrent duplicate jobs; DB unique constraints; WhatsApp outage then retry |
| `verify.test.ts` | Moment 4; public verify privacy; rate limit; download link security; cancelled = never sent |
| `overdue.test.ts` | Moment 5; flagged once; SLA is a database value |
| `login.test.ts` | Email + password sign-in; no hint which emails exist; brute-force limits; hashes only, never shown; removed people locked out |
| `auth.test.ts`, `platform.test.ts`, `database.test.ts`, `config.test.ts` | Tampered/forged/expired tokens; role checks; headers; soft delete; DB constraints; config caching |

**I checked the tests can fail:** I deliberately removed the row lock and made the WhatsApp
idempotency key random; the matching tests failed both times (and only after I strengthened the
two-officer race test to run on 12 batches at once, because the original passed by timing luck).
`node scripts/smoke.mjs` plays the full journey against the running containers.

**Not automated:** the React UI (checked by hand in a browser); load testing.

---

## 7. Where to look (code tour)

```
backend/src/
  app.ts, server.ts, worker.ts     Express app / API entry / worker entry
  config.ts                        validated environment settings
  db.ts                            Prisma client with central soft delete
  config-store.ts                  reads Setting / WorkflowStep (Redis-cached)
  auth.ts, middleware/authenticate.ts   tokens, who-are-you, role checks
  workflow.ts                      THE approval engine (submit, decide, withdraw)
  csv.ts                           spreadsheet validation (all errors at once)
  issuance.ts                      certificate creation, PDF, WhatsApp, retries
  maintenance.ts                   sweep + overdue scan
  workers.ts, queues.ts            BullMQ consumers / queues
  pdf.ts, whatsapp.ts              PDF + QR, provider client
  live.ts, rate-limit.ts, audit.ts, view.ts, errors.ts
  routes/                          batches, certificates (verify/download/cancel), auth, config, live, health
backend/prisma/                    schema.prisma + migrations (hand-written SQL marked "Hand-written")
backend/test/                      the tests
fake-whatsapp/                     provider stand-in with failures and idempotency
web/src/                           React: App, Dashboard, BatchDetail, Verify, Rules
scripts/smoke.mjs                  end-to-end run against the live system
```

---

## 8. AI usage

This project was built with an AI coding assistant (Claude Code) working from the problem statement.
It wrote the code; I directed it, reviewed the decisions above, and made the product choices.
How the output was checked, not just trusted:
- **Everything was run:** typechecks, 121 tests (repeatedly, to expose flakiness), the full stack in
  Docker, `scripts/smoke.mjs`, and the UI in a real browser.
- **Tests were tested:** deliberate bugs (no row lock, random idempotency key, disabled soft-delete
  filter) were introduced to confirm the right tests fail.
- **Real bugs found this way** (all fixed): flaky tests caused by a seed script disconnecting the shared
  database engine when imported; two PDF writers in one process picking the same temp-file name;
  Express refusing to serve files from a `.data` folder (it hides dot-folders); my own test that
  failed 1 time in 16 because it "altered" a signature that already ended in the character it used;
  a two-officer race test that passed without the lock it was meant to prove.
- **Claims I could not verify were not made:** see the next section.

---

## 9. Known limitations and next steps (honest list)

- **Sign-in is basic.** Email + password with hashing and brute-force limits, but **no** password reset or
  change screen, no multi-factor, no single sign-on, and tokens last 8 hours and cannot be revoked
  individually (removing a person does stop their token, since the person is re-read on every request).
  For production I would put an OIDC identity provider in front. Also, the per-email attempt limit
  means someone can deliberately lock a colleague out for 10 minutes by guessing wrongly.
- **The seeded accounts share one default demo password** until you set `SEED_PASSWORD`; the seed warns
  about this. Never run a real deployment on it.
- **The demo user list is public** (`GET /auth/demo-users` feeds the shortcut dropdown), so in demo mode anyone can see
  the seven names and roles, and can act as any of them. With `DEMO_MODE=false` those routes do not exist.
- **No admin screen for rules.** They are edited in SQL, so those edits are not in the audit log
  (the standard `updatedById` columns exist but are not filled for SQL edits). Next step: a state-office
  screen that writes through the API and the audit log.
- **Escalation is in-app only** (Stuck tab, live banner, audit entry). There is no email/SMS/Slack yet.
- **CSV only** (no .xlsx); Indian mobile numbers only; max 2,000 rows per upload.
- **Roles are a database enum:** a brand-new *kind* of person needs one migration. Changing which role
  handles a step, how many approvals, SLAs and thresholds does not.
- **`createdById` / `updatedById`** are filled on most writes made by a signed-in user, but not on
  system writes or SQL edits, and they are plain columns, not foreign keys.
- **Soft delete is a flag**, so the moment of deletion is not stored (only `updatedAt`).
- **PDFs live on a shared Docker volume**, which works on one host only. Production uses object storage
  (see DEPLOYMENT.md); the code touches files in one place (`pdf.ts`).
- **Delivery retry window is short** (8 attempts, minutes) to keep the demo snappy. A real WhatsApp outage
  can last hours; production should lengthen the backoff (one environment variable) and pause the queue.
- **Live updates are best-effort** (the browser reconnects and re-fetches, so nothing is permanently missed).
- **The rate limiter fails open** if Redis is down (availability over strictness for a public page).
- **The worker container has no health check**; it relies on `restart: unless-stopped`.
- **Lists are capped at 200 batches** and not paginated; a batch page loads all its candidates.
- **No metrics endpoint yet** (DEPLOYMENT.md describes what to export and alert on).
- **Not load tested.** The sizing in DEPLOYMENT.md is reasoned from one measurement (PDF generation
  ≈ 6 ms on an Apple M1 core) and the provider's limits, not from a load test.

---

## 10. A 2-minute demo script

1. **(0:00)** `docker compose up --build`, open http://localhost:8080. As **Anika**, create a batch, upload
   `bad-rows.csv`: show the row-by-row errors and that nothing was saved. Upload `big-60.csv`, **Submit**.
2. **(0:30)** Switch to **Dev**: Approve. **Meera**: Approve. Show "2 of 2" and the batch moving to quality
   (60 ≥ 50). Switch to **Isha** (other district): she sees nothing.
3. **(0:55)** **Neha**: Approve. **Farah**: Approve. Watch the batch go *Issuing → Completed* **live** and
   certificates flip to *Sent* (some show "2 tries"; the fake WhatsApp fails ~30% of the time).
4. **(1:20)** Open a certificate's verification link in a private window (no login): **Valid**.
   As Farah, enter a reason and **Cancel** it; refresh the link: **No longer valid**.
5. **(1:40)** Show the **History** panel (who, when, why) and the **Live rules** panel; mention rules are
   database rows. Optional: `UPDATE "WorkflowStep" SET "slaMinutes" = 1 …` then show it appear in **Stuck**.
