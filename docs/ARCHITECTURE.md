# RETREAT SOCIAL PRINT: Architecture

Capture. Customize. Share. Print. (Retreat Arcade Solutions)

## Components
- `apps/api` Fastify + PostgreSQL (plain SQL migrations, `pg`), Sharp, SSE. Owns all data and rules.
- `apps/web` Next.js + React + Tailwind: admin, guest site, builder, frame designer, operator, photo wall (Phase 2+).
- `apps/print-agent` .NET 9 Windows service/tray app (Phase 11). Polls the API with a device token, downloads the final image, prints via Windows printer drivers.
- `packages/shared` zod schemas, RBAC matrix, page-definition types, print-state machine.

## Flow
Guest site -> API -> print queue (`print_jobs`) -> Windows Print Agent -> printer driver -> printer.

## Rules
1. **One final image.** `final_compositions` holds the single high-resolution file used for download, share, wall and print. No second render path.
2. **Event isolation.** Every event-owned table has `event_id`; parent links are composite `(id, event_id)` foreign keys, so cross-event references are rejected by the database (tested in `test/schema.test.ts`).
3. **Originals kept.** `photo_uploads` is never overwritten by editing.
4. **Shares are attempts.** `share_events.outcome` can only be `attempted`; we never claim a confirmed Instagram publication.
5. **Duplicate print protection.** `print_jobs` has a unique `(event_id, idempotency_key)`.
6. **Draft/publish.** `guest_experience_pages` keeps versions; at most one `published` and one `draft` per event (partial unique indexes). Edits never touch a live event until published.
7. **No predictable photo URLs.** Storage keys are random; photos are served only via authorised or signed expiring routes (Phase 5+).
8. **Credentials.** Passwords argon2id; session and device tokens stored as hashes only.
9. **Deleting an event** cascades to all its data (tested). Deleting a sponsor or printer only unlinks it.

## Roles
`super_admin` (global), `event_manager`, `print_operator`, `reporting_viewer` (event-scoped via `user_event_roles`).

## Final image (Phase 7)
- `apps/api/src/compose.ts` is the only renderer. Photos are placed with the shared `coverLayout` maths (same function the guest editor uses), layers follow `FrameCanvas` geometry, text uses bundled OFL fonts (Inter, Lora, Playfair Display, Bebas Neue, Nunito, JetBrains Mono, Oswald, Dancing Script, Noto Sans Devanagari fallback). The SAME font files are loaded by the browser (`apps/web/app/fonts.ts`) and registered by the server (`apps/api/src/fonts.ts`); a style a font lacks (e.g. italic Oswald) is disabled, never faked.
- Output is one JPEG (q95, 4:4:4, 300 DPI metadata) in `events/<event>/finals/<random>.jpg`. Guest download, staff view, photo wall and print all read that file.
- Guests get signed, expiring links (`/api/v1/public/c/:id?exp&sig`, HMAC with `SESSION_SECRET`; mandatory in production). Staff use authenticated per-event routes.
- Compose is idempotent per guest session (same frame + photos + adjustments + frame version = same picture); a guest trying another frame replaces their unprinted picture, a composition with print jobs is never deleted.

## Sharing and QR codes (Phase 8)
- **Sharing is honest.** No web page or server can publish to a guest's personal Instagram. The share screen uses the phone's share sheet with the picture attached (the guest chooses Instagram there), or falls back to: save the picture, copy the caption, try to open the Instagram app (mobile only), and show a three-step guide that says what really happened (including when copying failed). Each tap is stored in `share_events` as `attempted`; a CHECK constraint makes any other outcome impossible.
- **QR codes** (`qr_tracking`, many per event): the printed code encodes `<base>/q/<code>` (10 random base-32 chars). Scanning hits the API, which counts the scan (`qr_scan_events`) and redirects to the guest page (or a custom https landing URL). Disabled, expired, replaced or inactive-event codes return a friendly 410 page and are not counted. Downloads (PNG/SVG/A4 poster) are rendered server-side; colours must keep >= 4:1 contrast, dark on light, and a centre logo forces error-correction level H. Tests decode every variant with a real QR reader.
- **Display mode** `/d/<code>` is a public full-screen page sized in vmin for 22-inch and 43-inch screens; it re-checks every minute and shows "not active" if the code is turned off.

## Photo management (Phase 9)
- `routes/photos.ts`: filtered/paged list (status, guest ID prefix with escaped wildcards, frame, date range, wall visibility, sort) with per-status counts, detail view, cached thumbnails (200/400/800 px, stored under `events/<event>/thumbs/`), single and bulk moderation (who/when/why recorded; audit log keeps history), photo-wall visibility, deletion, per-guest data deletion, streamed ZIP export.
- Deleting a picture removes the database rows, the final file, cached thumbnails, and any original that no other picture uses; a picture with print jobs needs an explicit confirmation (print history goes with it). "Delete all data for this guest" (managers only) removes the session, details, originals, pictures, share records and files.
- Guest contact details are returned only to managers (`builder:edit`); operators see the guest ID.

## Print queue and operator dashboard (Phase 10)
- A picture is only printable once the guest finishes (`finalize`, called when the guest reaches the share/final screen): `final_compositions.finalized_at` is set and one `print_jobs` row is created (idempotent key `final:<composition>`). Mode decides the start state: automatic = `approved` (and the picture counts as approved), manual and batch = `pending` until an operator approves. Changing the mode affects only pictures finished afterwards.
- `packages/shared/src/print.ts` is the state machine (received, pending, reprint_requested, approved, printing, printed, failed, cancelled). `printService.transition` is the only place status changes: it locks the row, rejects illegal moves, stamps times and writes `print_job_events` (who, when, from/to, note). Operator actions: approve (also approves the picture), reject (cancels the job and rejects the picture), cancel, hold, retry, copies, reprint. A job already `printing` cannot be cancelled.
- Duplicate protection: unique `(event, idempotency_key)`; finalize is safe to repeat; reprint needs a finished job, refuses while another job for the picture is still in progress, and the screen sends a fresh `requestId` per tap so a repeated request returns the same job. Rejecting or deleting a picture cancels or removes its jobs.
- Printer side (exposed to the Windows agent in Phase 11): `claimNext` takes the oldest approved job with `FOR UPDATE SKIP LOCKED` (two printers never get the same job; nothing while the queue is paused; never a rejected picture), `reportResult`, `requeueStale` (a job stuck in `printing` goes back to the queue).
- Live screen: `/print/<event>` (no admin chrome, big touch targets) listens to a Server-Sent Events stream and re-checks every 10 s as a backup. The event bus is in-process: with more than one API instance it must move to Postgres LISTEN/NOTIFY.

## Printer agent (Phase 11)
- **Device credential**: an admin adds a "print computer" and gets a one-time pairing code (30 minutes, stored only as a hash). The agent exchanges it for a long random credential (`agt_...`), stored only as a hash on the server and DPAPI-encrypted on the PC. Re-pairing, disabling or removing a device kills the credential at once. Pairing is rate-limited.
- **Protocol** (`/api/v1/agent/*`, Bearer credential): `register`, `heartbeat` (reports printers, driver paper sizes and state; the server answers with the printers' settings and queue state), `claim` (oldest approved job that fits the printer's paper, nothing while paused), `jobs/:id/image` (only for the job's own printer; SHA-256 sent in a header), `jobs/:id/progress` (keep-alive), `jobs/:id/result` (idempotent; a late success after a stale requeue is accepted so nothing prints twice). A timer requeues jobs stuck in "printing" for `PRINT_STALE_SECONDS` (300).
- **Printers** start disabled; enabling needs a paper size. Event admins set paper size, orientation and on/off in Event > Printers. The operator dashboard shows a plain banner when no print computer is online or no printer is ready.
- **Agent** (`apps/print-agent`, .NET 9): `RetreatPrintAgent.Core` (platform independent, fully unit-tested: runner, ledger, API client, paper matching, config) and `RetreatPrintAgent` (WinForms tray app, Windows printing, DPAPI, `--headless` and `--selftest`). See `docs/PRINT_AGENT.md`.

## Photo wall (Phase 12)
- **Link**: each event has a private wall link `/w/<wall_token>` (random, unique, revocable with "New link"). It needs no login because it runs on a TV. A wall that is off, an event that is not `active`, an unknown or replaced link all answer the same 404.
- **One eligibility rule** (`ELIGIBLE` in `routes/wall.ts`) is used by the list, the image route, the stats and the shown counter: the picture is finished, not deleted, `show_on_wall`, not rejected, approved when "approved only" is on, and its guest did not opt out. The image route re-checks this on every request, so a hidden or rejected picture stops being served even if a resized copy is cached on disk.
- **Images**: resized JPEG copies (800 / 1600 / 2400 px) of the single final composition, cached under `events/<event>/wall/`, deleted with the picture. Served with `Cache-Control: private, max-age=300`; everything else stays `no-store`.
- **Live updates**: `wallBus` ticks on finish, approve/reject, hide/show, delete and settings changes; the display opens an SSE stream and also checks every 5 seconds, so a dropped stream only delays an update. In-process bus (single API instance), like the print bus.
- **Counting**: the display reports what it showed (`POST /shown`); only pictures that are eligible at that moment are counted in `wall_views`.
- **Guest opt-out**: `guest_sessions.wall_opt_out`, chosen on the details screen when the wall is on.

## Sponsors (Phase 13)
- **Sponsor** = name, https link, hashtag, logo (stored under `events/<event>/sponsors/`, checked by its bytes, SVG with script refused, 2 MB), active flag, and where it shows: guest screens and/or the photo wall. At most 20 per event. Staff with `builder:edit` manage them; everyone with `event:view` can read.
- **Print**: a frame can belong to a sponsor (`frames.sponsor_id`, composite FK so it must be the same event). A frame "Logo" layer set to "Frame's sponsor logo" is drawn into the ONE final image, so it appears in the download, the wall and the print. A switched-off sponsor or one without a logo draws nothing, and the composition cache key includes the sponsor logo, so changing it never returns an older picture.
- **Hashtags**: a sponsor without frames adds its hashtag to every guest caption; a sponsor with frames only for pictures made in those frames (`sponsorTagsFor`, shared and tested). They are added after the event-wide hashtags set on the Sharing tab.
- **Public exposure**: guests get only active sponsors that are shown to guests, add a hashtag, or own an active frame (so the frame preview can draw the logo); the wall gets only active wall sponsors that have a logo. Each logo route re-checks that, so a switched-off sponsor's logo stops being served.
- **Not done**: click or impression counts per sponsor, sponsor placement on the guest landing page beyond the builder's own sponsor element, copying sponsors with "Duplicate event".

## Photo mosaic (Phase 14)
- **Module**: one mosaic per event, switched on by `event_settings.mosaic_enabled` (the same switch as the Settings tab). Off: nothing is placed and the display link answers 404.
- **Grid**: the staff-uploaded master (JPG/PNG/WebP, 25 MB, SVG refused, 200 px minimum) is cut into `cols x rows` cells chosen from its shape and the wanted tile count (`gridFor`); each cell's average colour is stored (`cell_colors`). A new master or a new tile count rebuilds the grid and places every picture again.
- **Placing**: `syncMosaic` runs under a per-event advisory lock. It frees tiles of pictures that are no longer eligible (same rule as the wall: finished, shown on wall, not rejected, approved if moderation is on, guest did not opt out, not deleted, but with its own moderation switch) and gives each new picture, oldest first, the free cell with the closest colour (`assignTiles`, deterministic). A picture keeps its cell until it is removed or the grid is rebuilt. Each picture's 320 px thumbnail is cached once, so rendering never re-reads the big final image.
- **Rendering** (`mosaicService.renderCurrent`): dimmed (or full) master, tiles drawn into exact cell rectangles, a flat colour tint per filled cell so the master stays recognisable, then the event logo (optional backing plate, 6 positions). Output is kept within 50 megapixels. Results are cached per **version** (hash of the master, grid, look settings, logo and the tile list); a new picture is a new version and older renders are deleted; concurrent requests share one render.
- **Display** `/m/<token>`: unguessable revocable link like the wall; shows the latest render, progress bar and join QR, swaps pictures only once the new one has loaded, updates by the wall's SSE bus plus a 5 second check. **Download**: staff-only, at the configured width, audited.
