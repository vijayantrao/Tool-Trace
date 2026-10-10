# ToolTrace

**A smart tool-tracking and calibration platform for factory floors.**

[![CI](https://github.com/vijayantrao/Tool-Trace/actions/workflows/ci.yml/badge.svg)](https://github.com/vijayantrao/Tool-Trace/actions/workflows/ci.yml)

On a real shop floor, tools go missing, get used past their calibration date, and nobody can say who had a torque wrench last Tuesday. Spreadsheets and paper logs can't enforce rules. ToolTrace makes those rules impossible to break:

- An **out-of-calibration tool cannot be checked out.** The API refuses, and so does the database itself.
- **A tool can never be issued to two people at once**, even if two requests arrive at the same millisecond.
- **Every account signs in with a passkey** (fingerprint, face or device PIN). There are no passwords to steal or phish.

> Status: **Phase 2 of 6 complete** (secure backend + web app). See the [roadmap](#roadmap).

## The tool board

Real tool cribs use **shadow boards**: each tool's outline is painted on a pegboard, so a missing tool is obvious at a glance. ToolTrace's home screen works the same way. A tool in the crib hangs in its slot. A checked-out tool leaves only a dashed outline with who has it and when it's due back. A red marker means its calibration has expired and it is locked.

![Tool board](docs/screenshots/board.png)

| Phone: scan, then check out | Phone: your tools and the board | Tool detail and calibration history |
|---|---|---|
| ![Mobile checkout](docs/screenshots/mobile-checkout.png) | ![Mobile board](docs/screenshots/mobile-board.png) | ![Tool detail](docs/screenshots/tool-detail.png) |

| Tools with calibration stickers | Invites with a scannable link | Passkey sign-in |
|---|---|---|
| ![Tools](docs/screenshots/tools.png) | ![People](docs/screenshots/people.png) | ![Sign in](docs/screenshots/login.png) |

Screenshots are taken automatically by the browser test suite, so they always match the real app.

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
    class API,DB,Web,Phone done
    class Station,MQTT,ML next
```

Green parts are built. Dashed parts are on the roadmap.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| API | **TypeScript**, [Hono](https://hono.dev), Node 22 | Small, fast, standards-based (Fetch API). Shares one language and one set of validation schemas with the web app |
| Auth | **Passkeys / WebAuthn** via [SimpleWebAuthn](https://simplewebauthn.dev) | Phishing-resistant sign-in, no passwords stored anywhere |
| Validation | [Zod](https://zod.dev) | Every request body, query and URL parameter is validated before any code touches it |
| Database | **PostgreSQL 16** with [postgres.js](https://github.com/porsager/postgres) | Constraints, triggers and partial unique indexes enforce the business rules |
| Web app | **Next.js 16** (App Router), React 19, **Tailwind CSS 4**, TanStack Query | Installable PWA, mobile-first, works one-handed on the shop floor |
| QR | Camera scanning with the native BarcodeDetector, falling back to jsQR; printable labels | A label opens the tool's page, even from a phone's own camera app |
| API testing | Vitest + a software passkey authenticator | Tests sign real ES256 WebAuthn responses against a real database |
| Browser testing | **Playwright** + Chromium's virtual authenticator + **axe-core** | Full user journeys with real passkeys, plus automated accessibility checks |
| DevOps | Docker, Docker Compose, GitHub Actions, Dependabot | One-command local stack and automated checks on every push |
| Planned | C++ (ESP32 firmware), MQTT, Python (scikit-learn), Redis | See the roadmap |

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
| Cross-site cookie problems | The web app proxies `/api` itself, so the browser only ever talks to one origin and the session cookie stays first-party. The proxy forwards an explicit allow-list of headers and rejects path tricks like `..%2f` |
| Clickjacking, injected scripts, rogue device access | Web app CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and a Permissions-Policy that allows the camera (for QR scanning) and nothing else |
| Open redirects after sign-in | The `?next=` target is only followed if it is a same-site path |
| Stale data on a shared tablet | The service worker never caches `/api` responses. Only static assets and an offline page are cached |

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
| GET | `/holders` | Admin, Storekeeper | People who can be issued tools (no emails) |
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
| GET | `/dashboard` | Signed in | Floor-wide counts plus your own open checkouts |

## Run it locally

**One click on Windows:** double-click `scripts/windows/run-app.cmd` (needs Git, Node.js 22+ and Docker Desktop). It starts the database, loads demo tools, starts the API and web app, and opens your first admin invite. Create your passkey with Windows Hello, and you're in.

**With Docker** (everything in containers):

```bash
docker compose up --build                     # web on http://localhost:3000, API on :8080
docker compose exec api node apps/api/dist/scripts/seed-demo.js
docker compose exec api node apps/api/dist/scripts/bootstrap-admin.js you@example.com
# Open the printed invite link and create your passkey.
```

**By hand** (Node 22+ and a Postgres database):

```bash
npm install
cp apps/api/.env.example apps/api/.env        # then edit DATABASE_URL
cd apps/api
npx tsx --env-file=.env src/scripts/migrate.ts
npx tsx --env-file=.env src/scripts/seed-demo.ts
npx tsx --env-file=.env src/scripts/bootstrap-admin.ts you@example.com
npx tsx watch --env-file=.env src/index.ts    # API on :8080
# In a second terminal:
npm run dev:web                                # web on http://localhost:3000
```

The bootstrap script prints a one-time admin invite link. It refuses to run once an admin exists. Passkeys work on `http://localhost`; anywhere else they need https.

## Tests

```bash
# API: 49 tests. Needs a Postgres server; each test file creates and drops its own database.
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm test

# Browser: 16 end-to-end tests with real passkeys (first time: npx playwright install chromium)
npm run build -w apps/web
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tooltrace_e2e npm run test:e2e
```

The **API suite** covers the full passkey flow, phishing and replay rejection, role checks, CSRF blocking, cookie hardening, rate limiting, the calibration lockout (including a direct database insert that bypasses the API), concurrent checkouts, and concurrent admin demotions.

The **browser suite** plays out a whole shift in Chromium with a virtual passkey authenticator: an admin bootstraps the system and invites a storekeeper and a technician, the technician checks out a tool on a phone-sized screen, an expired tool is shown as locked, the storekeeper receives a tool back damaged, quarantines it, recalibrates it, adds a new tool and prints its QR label, and a deactivated user is signed out everywhere. Every main screen is also scanned with **axe** for WCAG 2.1 AA accessibility problems.

## Project structure

```
apps/api/
  src/routes/           auth, users + invites, tools + locations, checkouts, dashboard
  src/middleware/       sessions + roles, CSRF origin guard
  test/                 integration tests and a software passkey authenticator
apps/web/
  src/app/(app)/        board, tools, tool detail, scan, checkouts, QR labels, people
  src/app/(auth)/       passkey sign-in and invite acceptance
  src/app/api/          same-origin proxy to the API
  src/components/       shadow-board slot, calibration sticker, hang tag, QR scanner
  e2e/                  Playwright journeys with virtual passkeys and axe checks
db/migrations/          plain SQL, applied in order under an advisory lock
scripts/windows/        one-click launch and test scripts
.github/                CI workflow and Dependabot
```

## Roadmap

- [x] **Phase 1: Secure backend.** Schema, passkey auth, invites, roles, tools, calibration, checkouts, Docker, CI
- [x] **Phase 2: Web app.** Shadow-board dashboard, QR scan-to-checkout, printable QR labels, invites, installable PWA, browser tests with real passkeys
- [ ] **Phase 3: IoT.** ESP32 + RFID smart station (C++), MQTT over TLS, live floor dashboard, Wokwi simulation link
- [ ] **Phase 4: Hardening.** Hash-chained tamper-evident audit log, Redis rate limiting, Postgres row-level security, CodeQL, gitleaks, OWASP ZAP, STRIDE threat model
- [ ] **Phase 5: Intelligence.** Python ML for late-return and loss risk, anomaly detection, offline sync
- [ ] **Phase 6: Launch.** Free-tier deployment, demo accounts, demo video

---

All demo data is fictional. Built by [Vijayant Rao](https://github.com/vijayantrao).
