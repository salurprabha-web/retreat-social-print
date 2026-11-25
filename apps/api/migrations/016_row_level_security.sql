-- Row level security on every table, with no policies: nobody but the table's owner (the role this application connects as) can read or write them.
-- Why: some hosted databases (Supabase) publish the "public" schema through a REST API for roles named "anon" and "authenticated", using a key that
-- is public by design. Without this, anyone holding that key could read or change guest data. The application itself is unaffected: the owner of a
-- table is not subject to row level security. Every future table must do the same (a test fails otherwise).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  -- Belt and braces where those API roles exist: take away their rights on everything here.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  END IF;
END $$;
