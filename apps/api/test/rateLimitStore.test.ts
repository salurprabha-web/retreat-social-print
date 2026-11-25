import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";
import { PgRateLimitStore, HybridRateLimitStore, purgeRateLimits } from "../src/rateLimitStore";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-r-"));
const { buildApp } = await import("../src/app");

let pool: Pool;
const incr = (s: { incr: (...a: any[]) => void }, key: string, window = 60_000) =>
  new Promise<{ current: number; ttl: number }>((res, rej) => s.incr(key, (e: Error | null, r: any) => (e ? rej(e) : res(r)), window, 0));

beforeAll(async () => { pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); });
afterAll(async () => { await pool.end(); });

describe("database rate-limit counters", () => {
  it("counts one request at a time and reports the time left in the window", async () => {
    const s = new PgRateLimitStore(pool);
    const a = await incr(s, "k1|POST|/x"); const b = await incr(s, "k1|POST|/x");
    expect([a.current, b.current]).toEqual([1, 2]);
    expect(b.ttl).toBeGreaterThan(55_000); expect(b.ttl).toBeLessThanOrEqual(60_000);
  });

  it("is atomic: 60 simultaneous requests get the numbers 1..60 exactly once each (no lost updates, so no way to slip past a limit)", async () => {
    const s = new PgRateLimitStore(pool);
    const got = (await Promise.all(Array.from({ length: 60 }, () => incr(s, "k2|POST|/y")))).map((r) => r.current).sort((x, y) => x - y);
    expect(got).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("starts a new window when the old one has ended", async () => {
    const s = new PgRateLimitStore(pool);
    expect((await incr(s, "k3|GET|/z", 1000)).current).toBe(1); expect((await incr(s, "k3|GET|/z", 1000)).current).toBe(2);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await incr(s, "k3|GET|/z", 1000)).current).toBe(1);
  });

  it("keeps different keys (address or route) apart", async () => {
    const s = new PgRateLimitStore(pool);
    await incr(s, "1.1.1.1|POST|/login"); await incr(s, "1.1.1.1|POST|/login");
    expect((await incr(s, "2.2.2.2|POST|/login")).current).toBe(1);
    expect((await incr(s, "1.1.1.1|POST|/session")).current).toBe(1);
  });

  it("hostile keys are stored as plain data, and very long keys are cut", async () => {
    const s = new PgRateLimitStore(pool);
    expect((await incr(s, "'; DROP TABLE rate_limits;--|x")).current).toBe(1);
    expect((await incr(s, "a".repeat(5000))).current).toBe(1); expect((await incr(s, "a".repeat(5000))).current).toBe(2);
    expect((await pool.query("SELECT count(*)::int c FROM rate_limits")).rows[0].c).toBeGreaterThan(0);
  });

  it("a database error is reported, never swallowed", async () => {
    const bad = new PgRateLimitStore({ query: () => Promise.reject(new Error("db down")) } as any);
    await expect(incr(bad, "k")).rejects.toThrow("db down");
  });

  it("the in-memory global store hands strict routes to the database store", async () => {
    const db = new PgRateLimitStore(pool); const h = new HybridRateLimitStore(db);
    expect(h.child()).toBe(db);
    expect((await incr(h, "g|1")).current).toBe(1); expect((await incr(h, "g|1")).current).toBe(2);
  });

  it("old counters are removed by the maintenance job; recent ones stay", async () => {
    await pool.query("INSERT INTO rate_limits(key,count,window_start) VALUES ('old|x',5, now() - interval '3 days')");
    await pool.query("INSERT INTO rate_limits(key,count,window_start) VALUES ('new|x',5, now())");
    expect(await purgeRateLimits(pool)).toBeGreaterThanOrEqual(1);
    expect((await pool.query("SELECT 1 FROM rate_limits WHERE key='old|x'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM rate_limits WHERE key='new|x'")).rowCount).toBe(1);
  });
});

describe("the limits in the running app, counted in the database", () => {
  it("sign-in is limited per address and per route; another address and other routes are unaffected; the limit is shared by separate app instances", async () => {
    const lim = process.env.LOGIN_RATE_LIMIT_PER_MIN; process.env.LOGIN_RATE_LIMIT_PER_MIN = "3";
    // config is read once at import, so use the config object the app already holds
    const { config } = await import("../src/config");
    const before = config.loginRateLimitPerMin; (config as any).loginRateLimitPerMin = 3;
    try {
      await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ('rl@t.test','rl',$1,'super_admin')", [await hashPassword("correct horse battery")]);
      const one = await buildApp(pool, { rateLimitStore: "pg" }); const two = await buildApp(pool, { rateLimitStore: "pg" });     // two "serverless instances"
      const login = (app: typeof one, ip: string, pw = "wrong password!!") => app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: ip, payload: { email: "rl@t.test", password: pw } });
      const statuses: number[] = [];
      for (const app of [one, two, one, two, one]) statuses.push((await login(app, "10.9.0.1")).statusCode);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);                                  // the 4th and 5th attempts are refused although they came through different instances
      expect((await login(two, "10.9.0.2")).statusCode).toBe(401);                          // another address still gets its own allowance
      expect((await one.inject({ method: "GET", url: "/api/v1/health", remoteAddress: "10.9.0.1" })).statusCode).toBe(200);    // other routes are not affected
      const blocked = await login(one, "10.9.0.1"); expect(blocked.headers["retry-after"]).toBeTruthy();
      await one.close(); await two.close();
    } finally { (config as any).loginRateLimitPerMin = before; if (lim === undefined) delete process.env.LOGIN_RATE_LIMIT_PER_MIN; else process.env.LOGIN_RATE_LIMIT_PER_MIN = lim; }
  });
});
