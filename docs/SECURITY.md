# Security

This document describes how the platform is protected, how that protection is tested, what the Phase 17 review found and fixed, and what is **not** covered. It is written to be checked against the code and the tests, not to reassure.

## Who can do what
| Actor | Credential | Reaches |
|---|---|---|
| Staff | httpOnly session cookie + per-session CSRF header | admin API, limited by role **per event** |
| Guest | the event's unguessable link (96-bit token) and a guest session id (122-bit) | the published page of an **active** event, their own uploads and pictures |
| Photo link holder | signed, expiring link (HMAC-SHA256, 24 h by default) | one picture |
| Wall / mosaic screen | unguessable revocable link (96-bit) | pictures allowed on the wall, resized |
| Print agent | device credential (`agt_…`, hash stored, revocable) | its own event's approved jobs and their images |
| Local venue server | sync credential (`sync_…`, hash stored, revocable) | delivering one event's data to the cloud |

Roles: `super_admin` (everything), `event_manager`, `print_operator`, `reporting_viewer`. The three event roles apply **per event**; a permission on one event gives nothing on another. Global actions (creating events, users, the API document) are super administrator only.

## Controls
- **Passwords**: argon2id; policy of at least 12 characters, not a common/repetitive password, not containing the account's email or name. Sign-in is rate limited per address; five failures lock the account for 15 minutes; unknown accounts and wrong passwords answer identically (and cost the same time).
- **Sessions**: random 256-bit token, only its SHA-256 is stored; `HttpOnly; SameSite=Strict`, and `Secure` by default in production; new token on every sign-in; 12 h life; ended immediately when the account is deactivated, its password changes or its administrator rights change.
- **CSRF**: every non-GET staff request needs the per-session `x-rsp-csrf` token (constant-time comparison); `SameSite=Strict` is a second layer.
- **Event isolation**: every record carries its event; composite foreign keys make cross-event references impossible in the database; every staff route checks the role on the event in the address; child ids from another event find nothing (404).
- **Input**: every body is validated with zod; malformed ids and time zones are refused before reaching the database; all SQL is parameterised (the few interpolated fragments are constants in the code).
- **Uploads**: type decided by the bytes, never the name or header; decoded fully before acceptance; pixel limit against decompression bombs; size limits enforced from the declared length before the body is read; SVG is refused if it contains script, handlers, external references, entities, `@import` or fetching styles, and is always served with a sandboxing CSP.
- **Files**: random storage names; no public file route; staff files only through authorised routes; names with dots or slashes never reach the disk.
- **Headers**: API sends `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `Cache-Control: no-store` for private data; the web app adds a Content-Security-Policy (production), `Permissions-Policy` (camera for our own pages only), COOP, and the reverse proxy adds HSTS.
- **Secrets**: never stored in plain text (sessions, device and sync credentials are hashed; passwords argon2id); production refuses to start with a missing/short/placeholder secret, a default database password, an http public address or insecure cookies (`prodcheck.ts`).
- **Logging**: structured logs in production with cookies and tokens redacted and credential-bearing addresses (guest/wall/mosaic links, photo links) masked; request bodies are never logged. Security-relevant actions (sign-in, user and role changes, exports, retention, device pairing, sync deliveries) are written to the audit log; no password is ever written to it.
- **Privacy**: consent is recorded; guests can keep their photo off the big screen; a guest's data can be deleted on request; archived events lose their guest data after the retention period (see `docs/REPORTS.md` for what is kept); exports contain no contact details.
- **Print and sync safety**: a delivered print job is read-only on the cloud, so a picture printed at a venue can never print again; deliveries are idempotent, checksummed and scoped to one event.

## How it is tested (`apps/api/test/security.test.ts` and companions)
The tests derive from the **route registry** (every route, with how it is protected), so a new route cannot slip past them.
1. **Inventory**: the set of routes reachable without sign-in must equal a reviewed list (`PUBLIC_ALLOWLIST` in the test); all public write routes must be rate limited. The API has 146 routes in total (`docs/openapi.json`), 95 of them gated by a named staff permission.
2. **Authentication**: every staff route (permission-gated or signed-in-user) answers 401 without a valid cookie, and 403 without or with a wrong CSRF token (four wrong-token shapes).
3. **Authorisation matrix**: for every event-scoped route, a manager of another event gets 403; each role is refused wherever it lacks the route's permission; allowed roles get through on reads; global routes refuse every non-super-administrator.
4. **Object-level access**: ids of another event's frames, pictures, sponsors, jobs, printers, credentials and guests, used through this event's address, find nothing and change nothing.
5. **Hostile input**: injection strings, traversal, NUL bytes, 3000-character values and type confusion against **every public route** (and, as super administrator, every staff route with 1,000+ requests): never a 5xx, never a stack trace, SQL or file path in the answer; the users table is intact afterwards.
6. **Uploads**: HTML/PHP/EXE/GIF/empty/truncated files refused; a 144-megapixel decompression bomb refused without harm; 17 SVG attack strings refused.
7. **Links and tokens**: signed links cannot be edited, replayed on another picture, or used after expiry; sessions are not valid across events; a session cannot finish another guest's picture.
8. **Sessions**: fresh token per sign-in, logout kills only that session, deactivation and expiry are immediate, lockout works, rate limits trigger, cookie flags are right, no secret is stored in the clear.
9. **Accounts**: only the super administrator manages users; password policy; the last-administrator rule, including **two administrators removing each other at the same moment** (exactly one succeeds).
10. **Production configuration**: the startup checks are unit-tested for every refusal and warning.
Run everything: `pnpm test`. The suite runs against the application in-process, not against the deployed containers. The deployed stack was checked by hand (health, HTTPS, security headers, sign-in, upload/download through the proxy, backup/restore); see `docs/ACCEPTANCE.md`.

## What the Phase 17 review found and fixed
| Finding | Fix |
|---|---|
| A staff route answered **500** for a malformed event id (reached the database's uuid parser) | uuid-shaped address parameters are validated once, for every route, and answer 404 |
| A NUL byte in the `tz` parameter caused a **500** on every report route | time zones are validated by shape before any query |
| The photo-adjust route (public) had no rate limit | rate limited like the other guest routes; a test now fails if any public write route is unlimited |
| SVG `@import "https://…"` (no `url(`) and `<link>`/`<meta>`/`<base>` passed the SVG check | rejected |
| CSRF token compared with `!==` | constant-time comparison |
| Two administrators could remove each other concurrently and leave **no** administrator | administrator rows locked for the change; the acting user is re-checked inside the transaction |
| Sessions cookies were `Secure` only when `COOKIE_SECURE=true` | `Secure` is the default in production; turning it off makes the server refuse to start |
| Proxy trust was hard-wired, so a directly reachable API would trust a forged `X-Forwarded-For` | `TRUST_PROXY` setting (default one proxy); the deployment keeps the API off public ports |
| Request logs would have contained guest links and signed photo links | masked, cookies and tokens redacted |
| No production safety net | startup checks, graceful shutdown, security headers, CSP |

## Dependencies
`pnpm audit --prod` was run. Fixed by upgrading: `sharp` to 0.35.5 (libvips, libheif, librsvg advisories; it decodes guest photos) and `postcss` (forced to 8.5.23 or later by a workspace override; it is a build-time dependency of Next.js). After the upgrade the audit reports two moderate findings, both the same advisory on `minimatch` inside `archiver`: only reachable with attacker-supplied glob patterns; the platform passes none (it only appends files it chose to the ZIP). Left as is knowingly. Re-run the audit before every release.

## Hosting on Vercel with object storage
The same checks apply; these controls are specific to the function + bucket setup (`docs/VERCEL.md`).
- **Direct uploads**: a phone may send one file straight to the bucket only after the API has checked the guest session, the event link, the declared size against the event's limit, and the per-session photo cap. The signed address names **one** key (in `incoming/<event>/`), lasts 5 minutes, and signs the exact size and content type, so a guest cannot declare 1 MB and send 100 MB, change the type, or reuse it for another file (verified against a real S3 server, not only the stand-in).
- **Upload ticket**: an HMAC-signed, expiring token binds event, guest session (or staff user), slot, storage key and size. It cannot be edited or used for another event, person or key, and it works once (the unfinished object is deleted at confirm, whatever the outcome).
- **Confirm step**: the server reads the object back and applies exactly the checks of the plain upload route (size equals declared, type decided by the bytes, HEIC refused, full decode, pixel limit against decompression bombs, SVG rules, duplicate check, replaced-photo cleanup). Anything refused is deleted. The lifecycle rule on `incoming/` removes abandoned uploads.
- **Signed downloads**: the routes that used to stream a file (guest picture link, staff picture and original, agent image, mosaic file, ZIP and package export) make the **same authorisation decision as before**, then redirect to a short-lived (5 min) signed address for that one file, with the content type and download name set by the server. The bucket stays private. Viewing an original is still audited. SVG logos are not redirected: they are served by the API with the sandboxing header.
- **Sync files** use the same pattern with the credential's own event, an allow-listed folder and file-name shape, and a SHA-256 the server recomputes by streaming the stored object before the file is put in place.
- **Scheduled jobs** (`/api/v1/cron/*`): bearer secret compared by hash in constant time; switched off (503) unless `CRON_SECRET` has 32+ characters; the server on Vercel refuses to start without it, because automatic data deletion depends on it.
- **Startup refuses unsafe hosting settings**: on Vercel, local-disk storage, in-memory rate limits, a missing cron secret and offline-server mode are errors; an S3 setup needs bucket and keys and an https endpoint.
- **Content-Security-Policy** allows exactly one extra origin (the bucket) for connections and images, validated at build time (no wildcard, no path; plain http only for localhost).
- **Tests added**: ticket tampering/expiry/other-guest/other-event/replay; refused file types, bombs and size mismatches with cleanup; signed-address properties; redirects only after authorisation (other event: 403, anonymous: 401, edited link: 404 with no storage address); multipart ZIP integrity; cron authentication; counters atomic under 60 parallel requests and shared by two app instances; the startup rules; the storage contract on both backends and, against a real S3 server, the refusal of a larger body, other type, other key and expired address.

New residual risks of this setup: a signed address is a bearer link for 5 minutes (anyone who has it can fetch that one file; our pages send no referrer, the bucket's responses do not control that); the R2 access key lives in the Vercel environment (limit the token to the one bucket); the upload confirm holds one upload (up to the event's limit) in function memory; on Vercel the global rate limit is weak (see above).

## Not covered (read this)
- **No external penetration test** and no formal code audit. The tests above are the developers' own.
- **No antivirus scanning** of uploads. Originals are stored untouched (that is the point) and are only ever served to staff as images; they are decoded for composition with pixel limits.
- **No multi-factor authentication or single sign-on.** Staff sign-in is password plus lockout and rate limits.
- **Account lockout can be abused** to lock a known email out for 15 minutes (sign-in rate limiting per address limits the effect). An unlock button is provided.
- **Rate limits**: the strict per-route limits (sign-in, guest actions, compose, print agents, sync) are counted per address and route; with `RATE_LIMIT_STORE=pg` (required on Vercel) they are counted in the database and hold across instances. The coarse global per-address limit stays in memory, so on Vercel it is per function instance and weak: add a rate-limit rule in Vercel's Firewall for `/api/v1/public/*`. Guests at one venue share an address; the per-route limits are sized for that.
- **Public screens poll** (photo wall, mosaic, every few seconds; the live streams were removed). Each poll is a small database read behind the global per-address limit; a very large event should put a limit in front (Vercel Firewall or the reverse proxy).
- **The CSP allows inline scripts and styles** (Next.js writes inline bootstrap data); it still blocks other origins, framing and plugins.
- **Audit logs are database rows**: someone with database access can alter them.
- **Storage encryption and backups are the provider's**: files are on a local volume (Docker) or in an R2 bucket (Vercel). R2 encrypts at rest; it has no backup of its own. Back up the bucket and the database yourself, and expire the backups (they still hold data that retention has deleted).
- **Offline venue servers** run on hardware you control: protect them physically and with disk encryption, and keep their sync credential secret; revoke it if the machine is lost.

## Reporting a problem
Send details to the administrator of your installation. Do not test against a live event.

## Hosted databases (Supabase and similar)
- **Row-level security on every table** (migration 016): some hosts publish the `public` schema through a REST API for the roles `anon` and `authenticated`, using a key that is public by design. All tables have row-level security switched on with no policies, and those roles' privileges are revoked where they exist, so that key reads and changes nothing. A test fails if any table in `public` lacks it (new migrations must switch it on), and another proves a non-owner role sees and changes nothing even with table privileges. The application is the tables' owner, which row-level security does not apply to; **use the same database login for migrations and for the running site**. Keep the host's Data API switched off as well.
- **Certificate authority**: a database with its own authority is connected to with `DATABASE_CA` (chain verified against that authority; the host name is not checked, as with libpq `verify-ca`). Tested against a real TLS server with a private authority: the plain address fails, the right authority connects encrypted, another authority is refused. Without it `sslmode=no-verify` is the (weaker) fallback.
