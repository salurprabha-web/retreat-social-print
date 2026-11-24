# Progress

- [x] Phase 1 (schema): workspace scaffold, `001_init.sql` for all Module 19 entities, migration runner, 6 database invariant tests passing (idempotent migrations, cross-event reference rejection, duplicate print-job rejection, single published page, share = attempt only, event delete cascade), typecheck clean. Found and fixed by the tests: event delete was blocked by frame/printer/sponsor foreign keys.
- [ ] Phase 1 leftovers: `packages/shared` source (RBAC matrix, schemas) not written yet; no OpenAPI doc yet.
- [ ] Phase 2 admin auth + dashboard (not started)
- [ ] Phase 3 event management (not started)
- Phases 4-17: not started. Nothing involving real printers, Instagram or Windows printing has been built or verified.
