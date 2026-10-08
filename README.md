# ToolTrace

**A smart tool-tracking and calibration platform for factory floors.**

[![CI](https://github.com/vijayantrao/Tool-Trace/actions/workflows/ci.yml/badge.svg)](https://github.com/vijayantrao/Tool-Trace/actions/workflows/ci.yml)

On a real shop floor, tools go missing, get used past their calibration date, and nobody can say who had a torque wrench last Tuesday. Spreadsheets and paper logs can't enforce rules. ToolTrace makes those rules impossible to break:

- An **out-of-calibration tool cannot be checked out.** The API refuses, and so does the database itself.
- **A tool can never be issued to two people at once**, even if two requests arrive at the same millisecond.
- **Every account signs in with a passkey** (fingerprint, face or device PIN). There are no passwords to steal or phish.

> Status: **Phase 1 of 6 complete** (secure backend). See the [roadmap](#roadmap).

---

## Architecture

```mermaid
flowchart LR
    subgraph Floor["Shop floor"]
        Phone["📱 Technician phone<br/>PWA + QR scanner"]
        Station["🔧 ESP32 + RFID<br/>smart tool station"]
    end

    subgraph Cloud["Free-tier cloud"]
        Web["Next.js web app<br/>(Vercel)"]
        API["TypeScript API<br/>Hono · passkeys · RBAC<br/>(Render)"]
        DB[("PostgreSQL<br/>(Neon)")]
        MQTT["MQTT broker<br/>(HiveMQ)"]
        ML["Python ML job<br/>(GitHub Actions, nightly)"]
    end

    Phone --> Web -->|"/api proxy, same-origin cookies"| API --> DB
    Station -->|"MQTT over TLS, signed events"| MQTT --> API
    ML -->|"risk scores"| DB

    classDef done fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef next fill:#f3f4f6,stroke:#9ca3af,color:#374151,stroke-dasharray: 4 3
    class API,DB done
    class Web,Phone,Station,MQTT,ML next
```

Green parts are built. Dashed parts are on the roadmap.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| API | **TypeScript**, [Hono](https://hono.dev), Node 22 | Small, fast, standards-based (Fetch API). Shares one language and one set of validation schemas with the web app |
| Auth | **Passkeys / WebAuthn** via [SimpleWebAuthn](https://simplewebauthn.dev) | Phishing-resistant sign-in, no passwords stored anywhere |
| Validation | [Zod](https://zod.dev) | Every request body, query and URL parameter is validated before any code touches it |
| Database | **PostgreSQL 16** with [postgres.js](https://github.com/porsager/postgres) | Constraints, triggers and partial unique indexes enforce the business rules |
| Testing | Vitest + a software passkey authenticator | Tests sign real ES256 WebAuthn responses against a real database |
| DevOps | Docker, Docker Compose, GitHub Actions, Dependabot | One-command local stack and automated checks on every push |
| Planned | Next.js, C++ (ESP32 firmware), MQTT, Python (scikit-learn), Redis | See the roadmap |

## Security design

| Threat | Defense |
|---|---|
| Password theft, phishing, credential stuffing | **No passwords.** Passkeys are bound to the site's origin, so a lookalike site can't use them |
| Unknown people signing up | **Invite-only.** Single-use invite links that expire after 72 hours. The token sits in the URL fragment, so it never reaches server logs |
| Stolen database dump | Session and invite tokens are stored **only as SHA-256 hashes** |
| Session hijacking via JavaScript (XSS) | Session cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and uses the `__Host-` prefix |
| Cross-site request forgery (CSRF) | SameSite=Strict cookies **plus** an Origin / `Sec-Fetch-Site` check on every state-changing request |
| Replay of a captured sign-in | WebAuthn challenges are stored server-side, expire in 5 minutes and are **deleted on first use** |
| Privilege misuse | Four roles (Admin, Storekeeper, Technician, Auditor) checked on every route. Technicians only ever see their own data |
| Admin lockout or takeover races | Admins can't change their own role. Admin changes are serialized and re-check the requester's rights inside the transaction |
| Deactivated employee keeps access | Deactivating a user or changing their role **revokes all of their sessions instantly** |
| Brute force | Rate limiting on all `/api/auth` endpoints |
| SQL injection | Every query uses bound parameters (postgres.js tagged templates). No string-built SQL |
| Bugs that bypass the API | Calibration lockout and the one-checkout-per-tool rule are enforced **inside PostgreSQL** (trigger and partial unique index) |
| Information leaks | Strict security headers (CSP `default-src 'none'`, HSTS, nosniff, no-referrer), `Cache-Control: no-store`, 64 KB body limit, generic error messages |

A full STRIDE threat model is planned for Phase 4.

## API

All routes live under `/api` and return JSON. Errors always look like `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Who | What it does |
|---|---|---|---|
| POST | `/auth/register/options` | Invite holder | Start passkey registration |
| POST | `/auth/register/verify` | Invite holder | Finish registration, create the account and sign in |
| POST | `/auth/login/options` | Anyone | Start passkey sign-in (no username needed) |
| POST | `/auth/login/verify` | Anyone | Finish sign-in |
| POST | `/auth/logout` | Signed in | End the session |
| GET | `/auth/me` | Signed in | Current user |
| GET | `/users` | Admin, Auditor | List users |
| PATCH | `/users/:id` | Admin | Change role or deactivate |
| POST / GET / DELETE | `/invites` | Admin | Create, list, revoke invites |
| GET / POST | `/locations` | All / Admin, Storekeeper | Cribs, bays, lines |
| GET | `/tools?status=&calibration=&q=` | Signed in | Search tools. `calibration` is `ok`, `due_soon`, `expired` or `not_required` |
| GET | `/tools/:id`, `/tools/by-tag/:assetTag` | Signed in | Tool detail with current holder and calibration history |
| POST / PATCH | `/tools`, `/tools/:id` | Admin, Storekeeper | Register or update a tool |
| POST | `/tools/:id/calibrations` | Admin, Storekeeper | Record a calibration. This releases a quarantined tool |
| GET | `/checkouts?open=&overdue=&holderId=` | Signed in | Technicians see only their own |
| POST | `/checkouts` | Admin, Storekeeper, Technician | Issue a tool by id or asset tag |
| POST | `/checkouts/:id/return` | Admin, Storekeeper | Receive a tool back. `damaged` or `needs_calibration` sends it to quarantine |

## Run it locally

**With Docker** (Postgres and the API together):

```bash
docker compose up --build
# API on http://localhost:8080. Check: curl localhost:8080/healthz
docker compose exec api node apps/api/dist/scripts/seed-demo.js
docker compose exec api node apps/api/dist/scripts/bootstrap-admin.js you@example.com
```

**Without Docker** (needs Node 22+ and a Postgres database):

```bash
npm install
cp apps/api/.env.example apps/api/.env      # then edit DATABASE_URL
cd apps/api
npx tsx --env-file=.env src/scripts/migrate.ts
npx tsx --env-file=.env src/scripts/seed-demo.ts
npx tsx --env-file=.env src/scripts/bootstrap-admin.ts you@example.com
npx tsx watch --env-file=.env src/index.ts
```

The bootstrap script prints a one-time admin invite link. It refuses to run once an admin exists.

## Tests

```bash
# Needs a Postgres server. Each test file creates and drops its own database.
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

The suite has 45 tests covering the full passkey flow, phishing and replay rejection, role checks, CSRF blocking, cookie hardening, rate limiting, the calibration lockout (including a direct database insert that bypasses the API), concurrent checkouts, and concurrent admin demotions.

## Project structure

```
apps/api/
  src/
    app.ts              middleware chain and route wiring
    routes/             auth, users + invites, tools + locations, checkouts
    middleware/         sessions + roles, CSRF origin guard
    lib/                errors, validation, rate limiting, token hashing
    scripts/            migrate, seed-demo, bootstrap-admin
  test/                 integration tests and a software passkey authenticator
db/migrations/          plain SQL, applied in order under an advisory lock
.github/                CI workflow and Dependabot
```

## Roadmap

- [x] **Phase 1: Secure backend.** Schema, passkey auth, invites, roles, tools, calibration, checkouts, Docker, CI
- [ ] **Phase 2: Web app.** Next.js + Tailwind + shadcn/ui, QR scan-to-checkout, installable PWA
- [ ] **Phase 3: IoT.** ESP32 + RFID smart station (C++), MQTT over TLS, live floor dashboard, Wokwi simulation link
- [ ] **Phase 4: Hardening.** Hash-chained tamper-evident audit log, Redis rate limiting, Postgres row-level security, CodeQL, gitleaks, OWASP ZAP, STRIDE threat model
- [ ] **Phase 5: Intelligence.** Python ML for late-return and loss risk, anomaly detection, offline sync
- [ ] **Phase 6: Launch.** Free-tier deployment, demo accounts, demo video

---

All demo data is fictional. Built by [Vijayant Rao](https://github.com/vijayantrao).
