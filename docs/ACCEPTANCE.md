# Final acceptance

`apps/api/test/acceptance.test.ts` runs the 25-step journey of the product specification through the real HTTP interface, in order, against a real PostgreSQL and real image processing. Run it with `pnpm --filter @rsp/api test acceptance`.

"Proven" below means: the software side of the step is exercised by an automated test that passes. It does **not** mean the step has been seen on real devices.

| # | Step | Software side proven | Not proven here |
|---|---|---|---|
| 1 | Admin signs in | yes (wrong password refused) | |
| 2 | Create event | yes | |
| 3 | Upload client logo | yes | |
| 4-5 | Customise landing page (colours, fonts, background, text) | yes (stored and served to guests) | how it looks on every phone/browser |
| 6 | Create and upload frames | yes | |
| 7 | Configure guest journey | yes | |
| 8 | Publish (nothing visible before) | yes | |
| 9 | Download QR code; it encodes the guest link | yes (code decoded in the test) | scanning with real phone cameras |
| 10 | Guest scans and reaches the event site | yes (HTTP redirect) | real scan |
| 11 | Guest sees the customised site, nothing else leaks | yes | |
| 12 | Guest uploads a photo | yes | upload from real phone cameras (HEIC variants, very large files over mobile networks) |
| 13 | Guest selects a frame (active only) | yes | |
| 14 | Rotate / zoom / move | yes (server side) | touch gestures on real screens |
| 15 | Final image at 300 DPI, one server-made picture | yes | |
| 16 | Download; byte-identical to the stored picture | yes | |
| 17 | Share via the supported workflow; recorded as an **attempt** | yes (attempt recorded, never auto-confirmed) | **Real Instagram.** No Instagram account or app was involved. Share behaviour depends on the guest's phone and app. |
| 18 | Final image in admin dashboard | yes | |
| 19 | Operator approves for print | yes | |
| 20 | Print agent pairs, reports printer, receives job | yes (agent protocol over HTTP) | the .NET agent on a real Windows PC |
| 21 | Agent receives exactly the final image | yes | **A physical printer.** Nothing was printed on paper; colour, size and driver behaviour are untested. |
| 22 | Job recorded: status, printer, history, who | yes | |
| 23 | Photo appears on the wall | yes | the wall on a real display/TV |
| 24 | Analytics view and export | yes | |
| 25 | Archive; retention applied (guest data and files deleted, statistics kept) | yes | |

## Device and printer matrix (not covered by any test here)
Android, iPhone, Windows touchscreen and a real printer have **not** been tested. Before a live event, run this on the actual equipment:

1. Android phone (Chrome) and iPhone (Safari): scan the QR code, upload from the camera and from the gallery, adjust, preview, download, share.
2. Windows touchscreen kiosk (if used): open the guest link, complete a full journey with touch only.
3. Print PC: install the print agent (`docs/PRINT_AGENT.md`), pair it, print one test job from the operator screen, and check size, borders, colour and orientation on paper. Unplug the printer and confirm the failure is reported and a retry works.
4. Photo wall display: open the wall link full screen for at least an hour; confirm new photos appear and nothing leaks that guests opted out of.
5. Network: repeat with the venue's real Wi-Fi/mobile data; if the venue is unreliable, use the offline venue server (`docs/OFFLINE.md`) and confirm delivery to the cloud afterwards.
6. Take a backup and restore it on a spare machine (`docs/DEPLOYMENT.md`).

## Other tests
- Security suite (`security.test.ts`), accounts, retention, reports, offline, print and unit suites: `pnpm test`.
- Browser checks of the production web build (admin screens, guest page, CSP): done manually in the development browser; no console errors from the build itself.

## Deployment verification
Run by hand on a development machine (Docker Desktop, `SITE_ADDRESS=localhost`, test values only):

| Check | Result |
|---|---|
| Docker images build (api, web) | passed |
| `docker compose up`: db, api, web healthy, proxy up | passed, after one real fix: an empty `ACME_EMAIL` made the Caddyfile invalid and the proxy crash-looped; the setting was removed |
| Only the proxy publishes host ports | by configuration (compose file); not scanned from outside |
| `GET /api/v1/health` and `/login` through HTTPS | passed (Caddy's local test certificate) |
| CSP, HSTS, `X-Frame-Options`, `nosniff` on responses | present |
| Seed first administrator, sign in through the proxy | passed |
| Create an event, upload a logo, download it again | passed; downloaded file byte-identical |
| `backup.sh`, then delete all database rows and storage files, then `restore.sh --yes` | passed: data and file back, sign-in works, file byte-identical. Two script defects found and fixed along the way (Git Bash path rewriting on Windows). |
| Images rebuilt after the `sharp` / `postcss` upgrade | see the Phase 17 report for the final result |

Not done: a public-internet deployment, real certificate issuance, load testing, a restore onto a different machine.

## Vercel-mode verification (branch `vercel`)
Run by hand on a development PC: the production build of the site with the API inside it, on real PostgreSQL and a real S3-compatible server (MinIO), over HTTP and in a browser under the production Content-Security-Policy. Passed: sign-in, secure cookie, CSRF refusal, event/frame/publish, QR redirect, direct upload to the bucket (an oversized body, a wrong type and a replayed ticket refused), compose at 300 DPI (about 1 s), signed downloads, ZIP/package/mosaic export from storage, no unfinished upload left behind, cron, database-backed sign-in limit, the full guest journey in the browser including the share button's fetch.
Not done: the real Vercel/Neon/Cloudflare R2 services and real phones; see `docs/VERCEL.md` section 7 for the checklist.
