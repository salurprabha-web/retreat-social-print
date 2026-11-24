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
