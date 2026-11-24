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
