import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, migrate, type Pool } from "../src/db";

let pool: Pool;
beforeAll(async () => { pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); });
afterAll(async () => { await pool.end(); });

describe("row level security (hosted databases that publish the public schema through an API)", () => {
  it("every table in the public schema has row level security switched on, so a new table cannot be forgotten", async () => {
    const rows = (await pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity ORDER BY 1")).rows.map((r) => r.relname);
    expect(rows, "tables without row level security: add ALTER TABLE … ENABLE ROW LEVEL SECURITY to the migration that creates them").toEqual([]);
  });

  it("a role that is not the owner (like Supabase's public API roles) sees and changes nothing, even with table privileges granted", async () => {
    await pool.query("DROP ROLE IF EXISTS rls_probe"); await pool.query("CREATE ROLE rls_probe NOLOGIN NOBYPASSRLS");
    const ev = (await pool.query("INSERT INTO events(name,slug,guest_token) VALUES ('RLS probe','rls-probe',$1) RETURNING id", ["f".repeat(24)])).rows[0].id;
    await pool.query("GRANT USAGE ON SCHEMA public TO rls_probe; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_probe");
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE rls_probe");
      expect((await c.query("SELECT count(*)::int n FROM events")).rows[0].n).toBe(0);                 // the row exists but is invisible
      expect((await c.query("SELECT count(*)::int n FROM users")).rows[0].n).toBe(0);
      expect((await c.query("UPDATE events SET name='hacked' WHERE id=$1", [ev])).rowCount).toBe(0);
      expect((await c.query("DELETE FROM events WHERE id=$1", [ev])).rowCount).toBe(0);
      await c.query("SAVEPOINT s");
      await expect(c.query("INSERT INTO events(name,slug,guest_token) VALUES ('x','rls-x',$1)", ["e".repeat(24)])).rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK TO SAVEPOINT s"); await c.query("ROLLBACK");
    } finally { c.release(); }
    expect((await pool.query("SELECT name FROM events WHERE id=$1", [ev])).rows[0].name).toBe("RLS probe");   // the owner still sees and keeps it
    await pool.query("DELETE FROM events WHERE id=$1", [ev]); await pool.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rls_probe; REVOKE USAGE ON SCHEMA public FROM rls_probe; DROP ROLE rls_probe");
  });
});
