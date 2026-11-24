# Progress

- [x] Phase 1 (schema): workspace scaffold, `001_init.sql` for all Module 19 entities, migration runner, 6 database invariant tests passing (idempotent migrations, cross-event reference rejection, duplicate print-job rejection, single published page, share = attempt only, event delete cascade), typecheck clean. Found and fixed by the tests: event delete was blocked by frame/printer/sponsor foreign keys.
- Phase 1 leftover: no OpenAPI doc yet.
- [x] Phase 2: shared RBAC matrix (4 roles); API auth (argon2id, hashed session tokens, httpOnly cookie, per-session CSRF header, login rate limit, 5-failure 15-min lockout, audit log); event-scoped permission checks; /dashboard/overview with real counts scoped per user; seed-admin CLI; Next.js shell with login and dashboard. 14 API tests pass, typecheck and next build clean, login-to-dashboard checked by eye in the browser pane. Not done: user management UI, charts/filters, role-based UI hiding beyond API enforcement.
- [ ] Phase 3 event management (not started)
- Phases 4-17: not started. Nothing involving real printers, Instagram or Windows printing has been built or verified.
