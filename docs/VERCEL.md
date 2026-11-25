# Hosting on Vercel + Neon + Cloudflare R2

No server to manage. The website and the API run on **Vercel** (the API is one function inside the same project, so the address, cookies and security headers are the same as on a server), the database is **Neon Postgres**, photos are in a **Cloudflare R2** bucket, and **Cloudflare** holds the DNS.
(The Docker setup in `docs/DEPLOYMENT.md` still works; the code supports both.)

```
phone / staff browser ──▶ photos.yourdomain.com (Vercel)
                              ├─ pages (Next.js)
                              └─ /api/*  one function: the whole API ──▶ Neon Postgres
photo bytes (up to 100 MB)  ──▶ straight to R2 with a one-file signed address, then the API checks them
big downloads (pictures, ZIP) ◀── from R2 with a short-lived signed address
Vercel Cron ──▶ /api/v1/cron/*  (print requeue every minute, data deletion hourly, housekeeping)
```

## What you need
A Vercel Pro account (the free Hobby plan is non-commercial), a Cloudflare account with your domain, a Neon account (Vercel's Marketplace offers it), a GitHub account. The repository's `vercel` branch holds this version.

## 1. Neon database
1. Create a project; choose a region near most of your guests and near the Vercel function region (step 4).
2. Create a database `rsp` and a role with a strong password (not `postgres`).
3. Copy **two** addresses from the *Connect* dialog:
   - **Pooled** (host contains `-pooler`): this is `DATABASE_URL`, used by the API.
   - **Direct** (no `-pooler`): this is `DATABASE_URL_DIRECT`, used only to run migrations during deployment.
   Both must end with `?sslmode=require`.

## 2. Cloudflare R2 bucket
1. R2 → *Create bucket* `rsp-photos` (keep it **private**; do not enable public access or a public domain).
2. R2 → *Manage API tokens* → create a token with **Object Read & Write** limited to that bucket. Note the Access Key ID and Secret.
3. Your S3 endpoint is `https://<account id>.r2.cloudflarestorage.com` (shown on the R2 page).
4. Bucket → *Settings → CORS policy*:
   ```json
   [{ "AllowedOrigins": ["https://photos.yourdomain.com"], "AllowedMethods": ["GET", "PUT", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```
   (PUT: phones upload photos straight to the bucket. GET: the "share" button fetches the picture before handing it to the phone's share sheet.)
5. Bucket → *Settings → Object lifecycle rules*: add two rules, **delete objects after 1 day** for the prefixes `incoming/` (unfinished uploads) and `exports/` (ZIP and event-package downloads; they contain guest photos and are replaced on the next export anyway).

## 3. Get the code to GitHub
Push the `vercel` branch to your private repository (`git push -u origin vercel`).

## 4. Vercel project
1. *Add New → Project* → import the repository. Set:
   - **Root Directory**: `apps/web`, and tick **Include source files outside of the Root Directory**.
   - **Framework**: Next.js. Node.js version **22.x**.
   - **Production Branch**: `vercel` (Settings → Git).
   - **Function Region**: close to Neon (Settings → Functions).
   - Build and install commands come from `apps/web/vercel.json`; leave the fields empty.
2. *Settings → Environment Variables*. Add for **Production** (a Preview environment should use a *different* database and bucket):

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon pooled address |
| `DATABASE_URL_DIRECT` | Neon direct address (build runs migrations with it; the app never uses it) |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -hex 32`). Changing it invalidates photo links already given out |
| `PUBLIC_BASE_URL` | `https://photos.yourdomain.com` (QR codes are built from it) |
| `STORAGE_BACKEND` | `s3` |
| `S3_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | `rsp-photos` |
| `S3_REGION` | `auto` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from the R2 token |
| `STORAGE_CONNECT_ORIGIN` | `https://<bucket>.<account id>.r2.cloudflarestorage.com` — **build-time**: it lets the page talk to and show images from the bucket (Content-Security-Policy). Use the host name your signed addresses have (shown in the browser's network tab on the first upload) |
| `RATE_LIMIT_STORE` | `pg` |
| `CRON_SECRET` | 32+ random characters. Vercel sends it to the scheduled jobs automatically |
| `TRUST_PROXY` | `1` |

   The API **refuses to start** (`server_misconfigured` in the logs) if storage is not `s3`, `RATE_LIMIT_STORE` is not `pg`, or `CRON_SECRET` is missing, because each of those would otherwise fail silently (for example data deletion would never run).
3. *Settings → Functions*: keep the default memory (the picture engine peaks below 450 MB; see "Measured" below). Duration is set in the code (300 s).

## 5. Domain (Cloudflare DNS)
1. Vercel → project → *Domains* → add `photos.yourdomain.com`; it shows the DNS record to create.
2. Cloudflare → DNS → add that record (normally `CNAME photos → cname.vercel-dns.com`) with proxy status **DNS only (grey cloud)**. Keep it grey: the API reads each visitor's address from the forwarded header, and a second proxy in front would make every guest look like one of Cloudflare's addresses.

## 6. First deploy
1. Deploy (push to `vercel`, or *Redeploy*). The build compiles the API, applies the database migrations (using `DATABASE_URL_DIRECT`), then builds the site.
2. Create the first administrator from your own computer (there is no default account):
   ```
   pnpm install && pnpm --filter @rsp/api build
   DATABASE_URL="<direct address>" ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='a long passphrase' node apps/api/dist/seed-admin.js
   ```
3. Check `https://photos.yourdomain.com/api/v1/health` → `{"ok":true}`, then sign in at `/login`.

## 7. Check it on the real deployment (do all of these)
These need the real R2 bucket and real phones, which the automated tests could not use. Until they pass, treat the deployment as untested.
1. Create an event, add a logo and a frame, publish, download the QR code.
2. Scan it with a phone on **mobile data**; upload a 10+ MB photo from the gallery and from the camera. (Tests the signed upload and the bucket CORS.)
3. Choose a frame, preview, **download** and **share** (Android and iPhone). (Tests the signed download and the CORS for the share button.)
4. Approve it; open the photo wall on a second screen and watch it appear within a few seconds.
5. Pair the print agent and print one picture. (The agent follows a redirect to the bucket; not tested with the real agent.)
6. Export the ZIP and the offline package; download the mosaic.
7. Vercel → *Logs / Cron Jobs*: the three jobs run, return 200.
8. Neon → check connections stay low during a burst of uploads.
9. Time a compose at your biggest frame size; compare with "Measured" below.

## Measured (on a development PC, not on Vercel)
- Function size when traced: about 64 MB unzipped (limit 250 MB).
- Picture engine, one fresh process per job: 4×6 with one 12 MP photo 0.6 s / 210 MB; 4×6 with three photos 0.9 s / 290 MB; A5 with three 24 MP photos 1.5 s / 400 MB; a 12×12 in frame from a 48 MP photo 1.9 s / 430 MB. A small serverless CPU will be slower; check step 9.
- Finished pictures are 1.9–4.6 MB (A5) and up to 11 MB (12×12), more than a function can return (about 4.5 MB), which is why downloads come from the bucket.

## Things to know
- **No live push.** The photo wall, mosaic and operator screens ask the server every 4 seconds. Each open screen is about 900 requests an hour; watch Vercel's usage page.
- **Offline venue servers** work against this cloud: their files go to the bucket with signed addresses.
- **Backups.** Neon keeps point-in-time history (check your plan's window). R2 has no backup of its own: copy the bucket regularly (for example with `rclone`) if the photos matter beyond the retention period.
- **Retention** runs hourly from Vercel Cron; archived events lose their guest data after their retention period. Backups taken before that still hold the data.
- **Local development** is unchanged (`pnpm dev`, local disk storage, `docker compose` in `deploy/`).
- **Limits of this setup.** One function serves the whole API; an export of more than 5,000 pictures is cut at 5,000; a single request must finish within 300 s.

## If something does not work
| Symptom | Look at |
|---|---|
| Every API call answers `server_misconfigured` | Vercel function logs: the line `[config] ERROR:` names the missing setting |
| Upload hangs or fails after choosing a photo | bucket CORS (step 2.4) and `STORAGE_CONNECT_ORIGIN` (browser console shows a CSP or CORS message) |
| Pictures do not show / share does nothing | same two; also check the signed address host matches `STORAGE_CONNECT_ORIGIN` |
| Migrations did not run | `DATABASE_URL_DIRECT` set for the **Production** scope? Build log shows `Applied:` or `Database is up to date` |
| Sign-in answers 429 for everyone | all guests share one address: another proxy (orange cloud) is in front; use grey cloud |
| Data deletion or print requeue never happens | Vercel → Cron Jobs; `CRON_SECRET` set? |
