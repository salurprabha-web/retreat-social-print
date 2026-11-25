import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createPool } from "../src/db";

/**
 * The database connection against a REAL server whose certificate is signed by a private authority (the situation with Supabase).
 * Runs only when TEST_TLS_DATABASE_URL (…?sslmode=require) and TEST_TLS_CA_FILE are set. See docs/VERCEL.md.
 */
const url = process.env.TEST_TLS_DATABASE_URL, caFile = process.env.TEST_TLS_CA_FILE, otherFile = process.env.TEST_TLS_OTHER_CA_FILE;
const withCa = (ca: string, fn: () => Promise<void>) => { process.env.DATABASE_CA = ca; return fn().finally(() => { delete process.env.DATABASE_CA; }); };
const encrypted = async (u: string) => {
  const pool = createPool(u, { max: 1, connectMs: 5000 });
  try { return (await pool.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")).rows[0].ssl as boolean; } finally { await pool.end(); }
};

describe.runIf(!!url && !!caFile)("database over TLS with a private certificate authority", () => {
  it("fails with the plain address: this is the 'self-signed certificate in certificate chain' error a hosted database with its own CA causes", async () => {
    await expect(encrypted(url!)).rejects.toThrow(/self-signed|self signed|unable to verify|certificate/i);
  });

  it("works, encrypted, when DATABASE_CA holds that authority's certificate (host name need not match, as with shared pooler names)", async () => {
    await withCa(fs.readFileSync(caFile!, "utf8"), async () => { expect(await encrypted(url!)).toBe(true); });
  });

  it("also works when the certificate is given on one line with \n", async () => {
    await withCa(fs.readFileSync(caFile!, "utf8").trim().replace(/\n/g, "\n"), async () => { expect(await encrypted(url!)).toBe(true); });
  });

  it("refuses a server whose certificate is NOT signed by the configured authority", async () => {
    await withCa(fs.readFileSync(otherFile ?? caFile!, "utf8"), async () => { await expect(encrypted(url!)).rejects.toThrow(/self-signed|self signed|unable to verify|certificate/i); });
  });

  it("the documented fallback sslmode=no-verify encrypts without checking the certificate", async () => {
    expect(await encrypted(url!.replace("sslmode=require", "sslmode=no-verify"))).toBe(true);
  });
});
