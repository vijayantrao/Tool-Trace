# Deploy ToolTrace for free

The public demo runs entirely on free tiers, with no credit card for the core pieces. Total time: about 20 minutes, most of it waiting for builds.

| Piece | Host (free tier) | Notes |
|---|---|---|
| Web app (Next.js) | **Vercel** Hobby | Also proxies `/api` to the API, so cookies stay first-party |
| API (TypeScript, Docker) | **Render** free web service | Sleeps after 15 minutes idle and takes about a minute to wake. The sign-in page says so. |
| Database | **Neon** Postgres free | 1 GB, sleeps after 5 minutes idle |
| Rate-limit counters (optional) | **Upstash** Redis free | Only needed with more than one API instance |
| Nightly model and demo reset | **GitHub Actions** | Free for public repositories |
| Smart stations (optional) | **EMQX Serverless** free MQTT | Only if you want to connect an ESP32 or the terminal simulator |

Free tiers change. These were checked in October 2026.

**Pick your web address first.** Everything below uses `https://YOUR-NAME.vercel.app`. Choose a Vercel project name now (for example `tooltrace-vijayant`) and use it everywhere `YOUR-NAME` appears. Passkeys are tied to this exact address.

---

## 1. Database: Neon

1. Sign up at [neon.com](https://neon.com) (GitHub sign-in is fine).
2. Create a project named `tooltrace`. Choose region **AWS Asia Pacific (Singapore)** and Postgres 16 or newer.
3. On the project dashboard, click **Connect**. **Turn connection pooling off**: ToolTrace uses `LISTEN/NOTIFY` for live updates, which needs a direct connection.
4. Copy the connection string. It looks like `postgresql://neondb_owner:...@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` (no `-pooler` in the host). Call it **DATABASE_URL**.

## 2. Load the demo data (GitHub Actions)

1. On GitHub, open the repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Name `DEMO_DATABASE_URL`, value: the Neon **DATABASE_URL**. Save.
3. **Actions** tab → **Demo reset** → **Run workflow**. In about two minutes the database has the tables, the demo tools, the four demo personas, a year of synthetic history and a first model run.

From now on it runs every night at 02:01 India time. It refuses to touch a database that holds real accounts.

## 3. API: Render

1. Sign up at [render.com](https://render.com) with GitHub, and allow access to this repository.
2. **New** → **Blueprint** → choose this repository. Render reads [`render.yaml`](../render.yaml) and proposes one free web service, `tooltrace-api`, in Singapore.
3. Fill in the values it asks for:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 1 |
   | `APP_URL` | `https://YOUR-NAME.vercel.app` |
   | `RP_ID` | `YOUR-NAME.vercel.app` (no `https://`) |
   | `RP_ORIGINS` | `https://YOUR-NAME.vercel.app` |

   `PROXY_SECRET` and `STATION_MASTER_KEY` are generated for you.
4. **Apply**. The first build takes about five minutes. When it says **Live**, note the service URL, for example `https://tooltrace-api.onrender.com`. Call it **API_URL**.
5. Open the service → **Environment**, reveal **PROXY_SECRET** and copy it. You need it in the next step.

Check: opening `API_URL/healthz` shows `{"status":"ok"}`, and `API_URL/api/meta` answers **403 direct_access_forbidden**. That 403 is correct: the API only talks to your web app.

## 4. Web app: Vercel

1. Sign up at [vercel.com](https://vercel.com) with GitHub.
2. **Add New** → **Project** → import this repository.
3. **Project Name**: exactly `YOUR-NAME`. **Root Directory**: `apps/web` (Vercel detects Next.js).
4. **Environment Variables**:

   | Key | Value |
   |---|---|
   | `API_URL` | the Render URL from step 3 |
   | `API_PROXY_SECRET` | the `PROXY_SECRET` value from step 3 |

5. **Deploy**. When it finishes, open `https://YOUR-NAME.vercel.app`.

## 5. Try it

1. The first visit after a quiet spell shows **Waking up the server** for about a minute. That's the free API starting.
2. Under **Try the demo**, pick a role: Admin, Storekeeper, Technician or Auditor.
3. To try passkeys as well, sign in as the demo Admin → **People** → invite your own email → open the link on your phone → create a passkey. That account is wiped with the rest of the demo at night.

**If something is off**

| Symptom | Fix |
|---|---|
| Sign-in page keeps saying "Waking up" for several minutes | Render dashboard → the service → **Logs**. Usually a mistyped `DATABASE_URL`. |
| "The ToolTrace server is not reachable" | `API_URL` in Vercel is wrong. Fix it, then Vercel → Deployments → **Redeploy**. |
| Every request answers "Use the ToolTrace web app" | `API_PROXY_SECRET` (Vercel) and `PROXY_SECRET` (Render) differ. |
| Passkey errors | `RP_ID` / `RP_ORIGINS` must exactly match the Vercel address. Fix them on Render; it redeploys. |
| "Request blocked" on actions | The page's address isn't in `RP_ORIGINS`. Use the main `YOUR-NAME.vercel.app` address, not a preview URL. |
| Demo personas missing | Run **Demo reset** again (step 2). |

## 6. Optional: shared rate limits (Upstash Redis)

1. Sign up at [upstash.com](https://upstash.com).
2. **Create Database** → Redis, name `tooltrace`, region **ap-southeast-1 (Singapore)**, TLS on.
3. On the database page, copy the Redis URL that starts with `rediss://`. Call it **REDIS_URL**.

On Render, add `REDIS_URL` with that value. Worth it once you run more than one API instance.

## 7. Optional: smart stations over MQTT (EMQX Serverless)

1. Sign up at [emqx.com](https://www.emqx.com/en/cloud/serverless-mqtt) and create a free **Serverless** deployment.
2. Under **Access Control → Authentication**, add a username and password for the API, and another for each station.
3. On Render, add `MQTT_URL` = `mqtts://<your-deployment-address>:8883`, `MQTT_USERNAME`, `MQTT_PASSWORD` and `MQTT_CLIENT_ID` = `tooltrace-api` (a persistent session, so taps made while the API sleeps are delivered when it wakes).
4. As the demo Admin, open **Stations** → add a station. Paste its settings into the firmware's `config.h`, or run the terminal simulator command it shows, adding `--mqtt mqtts://<your-deployment-address>:8883` and setting `MQTT_USERNAME` / `MQTT_PASSWORD` in the environment (a station's own login, not the API's). For the ESP32, put the broker's CA certificate (from the EMQX console) in `include/root_ca.h`.

A station tap while the API is asleep is delivered when it wakes. The station shows "No reply" until then.

### The plant's time zone

Calibration dates expire at midnight **on the shop floor**, not on the database server (Neon runs in UTC). The API and the ML job both read `TOOLTRACE_SITE_TZ` (an IANA name, default `Asia/Kolkata`). Set it on Render and in the ML workflow only if the plant is elsewhere, for example `Europe/Berlin`.

## 8. Optional: data sources (Excel, CSV, databases)

Excel and CSV imports work everywhere, including the demo. Connections to MySQL, PostgreSQL and SQL Server need two settings on Render (`render.yaml` already generates the first):

| Key | Value |
|---|---|
| `DATA_SOURCE_KEY` | 32 random bytes, hex or base64. Encrypts saved database passwords. Changing it means re-entering them. |
| `DATA_SOURCES_ALLOW_PRIVATE` | `true` only for an on-premises install whose databases are on the factory network (10.x, 192.168.x...). Leave unset in the cloud. |

Database connections stay off in demo mode. For each connection, use a database account with only what it needs: read access to one table for imports, or the right to create and write one table for a copy.

## 9. Optional: email and reminders

Every alert appears in the app's bell without any setup. To also send it by email (overdue tools, calibration due in 30 days, the lab's results link, "please confirm you received this", request decisions, the Monday summary and the monthly report), give the API an SMTP server. [Brevo](https://www.brevo.com)'s free plan sends 300 emails a day:

1. Sign up at Brevo → **Senders, Domains & Dedicated IPs** → **Senders** → add and verify the address emails should come from.
2. **SMTP & API** → **SMTP** tab → **Generate a new SMTP key**. Note the **Login** shown there (it looks like `8a1b2c001@smtp-brevo.com`).
3. On Render → the service → **Environment**, add:

   | Key | Value |
   |---|---|
   | `SMTP_URL` | `smtp://LOGIN:SMTP_KEY@smtp-relay.brevo.com:587`, with the `@` in the login written as `%40` |
   | `MAIL_FROM` | `ToolTrace <the address you verified>` |
   | `CURRENCY` | optional, a three-letter code such as `INR` (the default) or `EUR` |

   Treat `SMTP_URL` as a password: paste it only into Render.

The API log then says `email: on`. Each person can turn email off for themselves on the **Notifications** page; admins see the delivery queue there.

**The public demo never sends email**, even with these set: `DEMO_MODE` turns it off so nobody can email strangers from the demo. Email needs the real deployment described in step 10.

**Reminders while the API sleeps.** Render's free plan sleeps after 15 quiet minutes, and the reminder jobs only run while it is awake. [`wake.yml`](../.github/workflows/wake.yml) pings it every hour: on GitHub → **Settings** → **Secrets and variables** → **Actions** → **Variables** → add `API_HEALTH_URL` = `https://<your-service>.onrender.com/healthz`. Without it, reminders are sent the next time someone opens the app.

## 10. A real (non-demo) deployment

Use a **separate** Neon database, and on Render:

- delete `DEMO_MODE` (the API also refuses demo mode on any database that holds real accounts);
- create the first admin from your computer, and open the link it prints:

  ```bash
  DATABASE_URL='<that database>' APP_URL=https://YOUR-NAME.vercel.app RP_ID=YOUR-NAME.vercel.app \
    RP_ORIGINS=https://YOUR-NAME.vercel.app npm run bootstrap-admin -w apps/api -- you@company.com
  ```

- add the GitHub secret `ML_DATABASE_URL` for the nightly model run ([`ml-nightly.yml`](../.github/workflows/ml-nightly.yml)). Ideally it points to a login role that is a member of `tooltrace_ml` only (see the [threat model](THREAT_MODEL.md), residual risk 12).
