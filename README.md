# CertiFlow

Certificate issuance for the (fictional) Pragati Skills Mission. Training centres upload passed batches, officers
approve them in stages, every candidate gets a certificate on WhatsApp, and anyone can check a certificate is
genuine without logging in.

**Run it:** `docker compose up --build`, then open http://localhost:8080. Full steps in [SETUP.md](SETUP.md).
**Production plan:** [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 1. Requirements note

**The brief in one line:** centres upload batches; district officers (more than one must agree) review them; big
batches get extra scrutiny; the state office has the final say; then every candidate gets a WhatsApp certificate;
mistakes can be fixed; anyone can verify; nothing may sit with an officer for days.

| Who | Does | Demo user |
|---|---|---|
| Training centre | creates a batch, uploads the CSV, submits, fixes and resubmits | Anika |
| District officer | reviews batches **of their own district** | Dev, Meera, Kabir |
| Quality team | reviews big batches | Neha |
| State office | final approval, sees stuck batches, cancels certificates | Farah |
| Candidates, employers | no account: a download link on WhatsApp / the public verify page | |

(I added **Isha**, an officer of a *different* district, to demonstrate district isolation.)

### Where the brief was unclear, and what I decided
Marked **(data)** = stored in the database, so it can be changed with no redeploy.

| Unclear | Decision |
|---|---|
| "More than one officer" | **2 different officers** of the batch's own district; nobody approves twice **(data)** |
| "Big batches" | **50 or more** candidates also go to the quality team **(data)** |
| Send back vs reject | **Send back**: the centre fixes and resubmits. **Reject**: closed for good, candidates freed |
| **Approvals after a send-back (Moment 6)** | **Discarded; review restarts from step one.** The data changed, so old approvals no longer describe it, and keeping them would let a centre get approval and then edit. A setting can switch this off **(data)** |
| "Officers can fix mistakes" | An officer can **withdraw their own approval** at their step; the state office can **cancel** a certificate after issue |
| "Too long with an officer" | Each step has a time limit (**48 h**). A late batch is flagged once, audited, announced live, and listed in the state office's **Stuck** tab **(data)** |
| Same person in two batches | The same **phone + course** can be certified once (database rule) |
| What the public sees | Valid/cancelled, certificate number, **masked** name, course, centre, date. Never phone or marks |
| How a stranger looks one up | By a **random verification code** on the PDF/QR. The certificate number alone does not work (it is sequential and guessable) |
| Login | **Email + password** for everyone. A no-password "switch person" shortcut (`DEMO_MODE=true`) exists because the brief's demo asks for it; turn it off for real use |

---

## 2. How it works

```
Browser ─▶ web (nginx) ─▶ api (Express) ──▶ PostgreSQL   source of truth
                              │  event "batch.approved"
                              ▼
                           Redis (BullMQ queues, live updates, rate limits)
                              ▼
                  worker (same image, scales on its own) ─▶ fake WhatsApp   (fails on purpose)
```
`DRAFT → IN_REVIEW → APPROVED → ISSUING → COMPLETED`, with side exits `CHANGES_REQUESTED` and `REJECTED`.
When the state office approves: the API saves the decision and its audit row in one transaction and answers at
once; a worker then makes one certificate per candidate (PDF + WhatsApp, with retries). Everyone watching sees each
change live.

---

## 3. How every requirement is met

| Requirement | How | Proof |
|---|---|---|
| **1. Bad spreadsheet rows** | Every row is checked and **every** problem reported by row; saved only if there are none, in **one transaction** | `intake.test.ts` |
| **2. Two officers at once** | The batch row is **locked** (`FOR UPDATE`), so the second request sees the first one's result | `workflow.test.ts` (12 batches raced at once) |
| **3. 60 candidates, flaky WhatsApp** | Queue + retries, and every step is **safe to repeat**: one certificate per candidate, one message per certificate | `issuance.test.ts` |
| **4. Cancelled certificate** | Verify reads the database every time (**no cache**), so the next lookup says cancelled; cancelled ones are never sent or downloadable | `verify.test.ts` |
| **5. Batch sits too long** | Scheduled scan against each step's time limit, flagged once, audited, shown in **Stuck** | `overdue.test.ts` |
| **6. Sent back and resubmitted** | The decision in section 1, as a setting, tested both ways | `workflow.test.ts` |
| *Acting at a step not yours / as someone else* | Role, district and step checked **on the server** in the decision chain; the token holds only the user id and the role is re-read from the database every request | `workflow.test.ts`, `auth.test.ts` |
| *Two certificates, or a shared number* | `UNIQUE(candidate)`, numbers from a **database sequence**, repeat-safe jobs | `issuance.test.ts` |
| *Cancelled shown as genuine* | See 4 | `verify.test.ts` |
| *A stranger gets someone's certificate or details* | Random verify code, signed download links, rate-limited public lookup, masked names and phones, "not found" (not "forbidden") across districts and centres; centres see an officer's **role**, never their name | `verify.test.ts`, `workflow.test.ts` |
| *An untraceable decision* | Every action writes an audit row (who, what, when, why) **in the same transaction**; the database **refuses to edit, delete or truncate** it; a request id follows a batch from the API into the worker | `workflow.test.ts` |

---

## 4. The brief's mandatory expectations, and why each tool is here

| Expectation | How we meet it |
|---|---|
| **Event-driven** | Approving emits a `batch.approved` event; a worker turns it into one job per candidate. PDFs and WhatsApp never run inside a user's request, so a slow or failing provider cannot hold anyone up. Live screen updates are a second event stream (Redis pub/sub) |
| **Scalable** | The API keeps no state in memory and the worker is the same image with a different command: `docker compose up -d --scale worker=3`. Each job goes to exactly one worker, and a dead worker's job is picked up by another. Every step is repeat-safe, so any instance can restart at any moment (**tested**: a worker is stopped mid-batch and a new one finishes it with no duplicates) |
| **Containerised** | Six containers, one command: `docker compose up --build`. Health checks and start order are set, and migrations and demo data are applied on start. A fresh clone runs with no manual steps |
| **Tested** | 137 tests on the real database and queue prove each moment and each "never" (section 3 and section 7) |
| **Secure** | Authorisation is checked **on the server** for role, district and step; every input is validated; signed links and random codes; salted password hashes with brute-force limits; rate-limited public endpoints; no CORS; request size limits; internals never leaked |
| **Observable** | JSON logs where every line carries a request id; the same id is stored in the audit log and follows a batch from the API into the worker; each WhatsApp attempt is recorded; each batch has a **History** panel; `/health` checks the database and Redis |

**Why each piece of the stack is there**

| Piece | Why |
|---|---|
| **PostgreSQL** | The source of truth. It gives us row locks, unique and partial indexes, CHECK rules and triggers: the guarantees behind "never two certificates" and "a decision is always traceable" |
| **Prisma** (with real migrations) | Typed queries and versioned migrations. Constraints Prisma cannot express are written as SQL inside the migration and marked "Hand-written" |
| **Redis** | One service, four jobs: queue storage for BullMQ, live-update pub/sub, rate-limit counters, and a short cache of the rules. Nothing important depends on it surviving: the database can rebuild the queue |
| **BullMQ** | Retries with backoff, per-job ids (so adding a job twice is harmless), a rate cap towards the provider, and repeating jobs. It runs on the Redis we already need, so no Kafka or RabbitMQ to operate |
| **Express + TypeScript** | Small and explicit; the types catch mistakes in the handler contexts |
| **React + Vite, served by nginx** | nginx also forwards `/api`, so the browser only talks to one origin (no CORS) and the real client address is known for rate limiting |

---

## 5. What we did beyond the basics

- **The database enforces the rules, not only the code.** Unique keys, a sequence for certificate numbers, CHECK
  rules, and an append-only audit table (a trigger refuses changes). Bugs in our code cannot create a duplicate.
- **Proven, not assumed.** I deliberately broke the row lock, the WhatsApp idempotency key, the soft-delete filter and
  the login limits to confirm the tests fail. That showed my first race test passed by luck, so I strengthened it.
- **Exactly-once even when WhatsApp lies.** The provider can deliver and then lose its reply. Every send carries the
  certificate id as an idempotency key, so the retry cannot send a second message. The fake provider reproduces this.
- **Postgres is the truth; Redis is a to-do list.** If Redis loses everything, a sweep every 30 s re-offers approved
  batches from the database. Tested.
- **Every flow is a chain of small handlers** (section 6), so adding a feature is adding a handler.
- **Rules are data.** Approvals needed, thresholds, time limits and **the approval path itself** live in database
  rows. A new approval step is one inserted row (tested end to end).
- **Privacy by design.** Random lookup code instead of the guessable number, no cache on verify, signed links,
  hidden officer names, masked phones, 404 instead of 403.
- **Real sign-in.** Salted scrypt hashes, the same answer and cost for "wrong password" and "unknown email", and brute-force
  limits that parallel guessing cannot get around (tested).
- **Soft delete in one place** (`isActive`, applied centrally) and standard columns on every table.
- **Found by measuring.** Six open tabs froze page loads because each held a live connection and browsers allow about
  six per site. I counted them on the server, then made all tabs share one stream.
- **Honest deployment plan.** I measured PDF generation (about 6 ms each) to show the real bottleneck at peak is the
  WhatsApp provider's limits, not our code.

**Modular by design**
- One tiny base class (`chain.ts`); every flow is a list of single-purpose handlers. A new feature is a new handler.
- WhatsApp sits behind an interface, so the fake can be swapped for a real provider in one place.
- API and worker are separate processes joined only by events, so each scales and fails on its own.
- Rules, thresholds and the approval path are data. Soft delete and the audit writer each live in one place.
- Each handler is testable on its own (the chain base and the step chain have unit tests).

**Safe checks built in**
- Every request body, id and query is validated; bad input gets a clean `400`, never a crash. Config is validated at start-up and refuses to run with a weak secret.
- Changes use **conditional updates and transactions**, so "cancel twice" or "approve twice" are refused rather than repeated.
- Calls to the provider have a timeout, and failures are retried instead of hanging a request.
- Secrets are compared in constant time; unknown emails cost the same time as wrong passwords.
- `404` instead of `403` across districts and centres; public lookups are rate limited; uploaded files are size and row limited.
- Files are written atomically (temp file, then rename), so nobody reads half a PDF.
- Shutdown is graceful, and a repeating sweep recovers work if the queue is ever lost.

---

## 6. Code organisation: a chain of small handlers

A request travels down a line of handlers (`backend/src/chain.ts`, about 20 lines). Each does **one job**, then
*carries on* (`return false`), *finishes* (`return true`), or *refuses* (`throw`). Data travels in a context object,
so handlers hold no state.

| Flow | The chain |
|---|---|
| Approval path (built from database rows) | district → quality (50+) → state |
| A decision (`workflow.ts`) | load → can you see it? → in review? → its step → your turn? → approve / send back / reject |
| Making a certificate (`issuance.ts`) | load → create → stop if cancelled → stop if sent → PDF → WhatsApp → mark delivered → complete batch |
| Sign-in (`routes/auth.ts`) | rate limit → find user → check password → token |
| Spreadsheet upload (`routes/batches.ts`, `csv.ts`) | own batch → editable → check each row → other batches → save all |
| Verify / download (`routes/certificates.ts`) | shared handlers for the public link and the staff download |

**To add a feature, write a handler and add it to the list. Nothing else changes.**
```ts
class CheckNotSuspended extends Handler<LoginContext> {
  protected process(c: LoginContext) {
    if (c.user?.suspended) throw forbidden("this account is suspended");
    return false; // carry on
  }
}
const loginChain = chainOf<LoginContext>(new RateLimit(), new FindUser(), new CheckNotSuspended(), new CheckPassword(), new IssueToken());
```
Tools that are not flows (database client, config, PDF drawing, WhatsApp client) are plain modules the handlers use.

---

## 7. Tests

**137 automated tests** on the **real** Postgres and Redis (not mocks), in their own throwaway database and queue
namespace so they never touch demo data. They run the real queue with an in-process worker and a WhatsApp stand-in
that fails, times out, and "delivers but loses the reply".
```bash
docker compose up -d postgres redis && cd backend && npm install && npm test
```
`node scripts/smoke.mjs` plays the whole journey against the running containers. Not automated: the React UI
(checked by hand) and load testing.

---

## 8. AI usage

Built with an AI coding assistant (Claude Code) working from the problem statement; I directed it and made the
product decisions above. Its output was checked, not trusted: everything was run (typechecks, tests repeatedly to expose
flakiness, the full Docker stack, the smoke script, the UI in a browser), and the tests themselves were tested by
introducing deliberate bugs. Real bugs found this way and fixed: tests made flaky by a seed script that closed the shared
database engine, two PDF writers choosing the same temp file, Express hiding files under a `.data` folder, my own
test that failed 1 time in 16, and a race test that passed without the lock it was meant to prove.

---

## 9. Known limitations (honest list)

- **Sign-in is basic:** no password reset, no multi-factor, no single sign-on; tokens last 8 h; someone can lock a
  colleague out for 10 minutes by guessing wrongly. The seeded accounts share one demo password until `SEED_PASSWORD` is set.
- **Rules are edited in SQL** (no admin screen), so those edits are not in the audit log.
- **Escalation is in-app only** (Stuck tab, live banner, audit); no email or SMS yet.
- **Identity is phone + course.** No national id: two people sharing a phone, or one person with two phones, are not caught.
- **A new kind of role** needs a migration and a few edits; steps, counts and limits do not. Steps run in a line (no parallel steps).
- **CSV only**, Indian mobile numbers only, 2,000 rows per upload.
- **PDFs live on a shared Docker volume** (one host). Production uses object storage; the code touches files in one place (`pdf.ts`).
- **Delivery retries last minutes** (8 tries), to keep the demo quick. A real outage can last hours.
- **Not load tested.** The deployment sizing is reasoned from one measurement and the provider's limits.
- **Demo mode** (on by default in Docker Compose, because the brief's demo needs it) lists the seeded users publicly and lets anyone act as them. Set `DEMO_MODE=false` for real use.
