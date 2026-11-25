import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPool, migrate, type Pool } from "../src/db";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-c-"));
const { buildApp } = await import("../src/app");
const { config } = await import("../src/config");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
const SECRET = "c".repeat(40);
const JOBS = ["print-requeue", "retention", "maintenance"];
const call = (job: string, authorization?: string) => app.inject({ method: "GET", url: `/api/v1/cron/${job}`, headers: authorization ? { authorization } : {} });

beforeAll(async () => { pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); app = await buildApp(pool); });
afterAll(async () => { (config as any).cronSecret = ""; await app.close(); await pool.end(); });

describe("scheduled jobs", () => {
  it("are switched off while no secret is configured (a server with its own timers), whatever is sent", async () => {
    (config as any).cronSecret = "";
    for (const j of JOBS) { expect((await call(j)).statusCode, j).toBe(503); expect((await call(j, "Bearer ")).statusCode, j).toBe(503); expect((await call(j, "Bearer " + SECRET)).statusCode, j).toBe(503); }
  });

  it("a secret shorter than 32 characters does not switch them on", async () => {
    (config as any).cronSecret = "short";
    expect((await call("maintenance", "Bearer short")).statusCode).toBe(503);
  });

  it("refuse a missing or wrong credential in every shape", async () => {
    (config as any).cronSecret = SECRET;
    for (const j of JOBS) {
      for (const h of [undefined, "", "Bearer", "Bearer ", "Bearer wrong", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET, `Bearer ${SECRET} extra`]) {
        const r = await call(j, h); expect(r.statusCode, `${j} / ${h}`).toBe(401); expect(r.json().error).toBe("invalid_credential");
      }
    }
  });

  it("refuse a staff session instead of the secret, and non-GET methods", async () => {
    (config as any).cronSecret = SECRET;
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/maintenance", headers: { authorization: `Bearer ${SECRET}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/cron/maintenance", headers: { cookie: "rsp_session=abc" } })).statusCode).toBe(401);
  });

  it("run with the right secret: counters older than a day are removed, recent ones kept", async () => {
    (config as any).cronSecret = SECRET;
    await pool.query("INSERT INTO rate_limits(key,count,window_start) VALUES ('cron-old',1, now() - interval '2 days'), ('cron-new',1, now())");
    const r = await call("maintenance", `Bearer ${SECRET}`);
    expect(r.statusCode).toBe(200); expect(r.json().ok).toBe(true); expect(r.json().rateLimitsRemoved).toBeGreaterThanOrEqual(1);
    expect((await pool.query("SELECT key FROM rate_limits WHERE key LIKE 'cron-%'")).rows.map((x) => x.key)).toEqual(["cron-new"]);
  });

  it("print-requeue puts a job stuck in 'printing' back in the queue, and leaves a recent one alone", async () => {
    (config as any).cronSecret = SECRET;
    const ev = (await pool.query("INSERT INTO events(name,slug,guest_token) VALUES ('Cron','cron-ev','" + "a".repeat(24) + "') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO event_settings(event_id) VALUES ($1) ON CONFLICT DO NOTHING", [ev]);
    const frame = (await pool.query("INSERT INTO frames(event_id,name,width_px,height_px) VALUES ($1,'f',1200,1800) RETURNING id", [ev])).rows[0].id;
    const sess = (await pool.query("INSERT INTO guest_sessions(event_id,guest_code) VALUES ($1,'GCRON1') RETURNING id", [ev])).rows[0].id;
    const mk = async (code: string) => {
      const up = (await pool.query("INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes,width,height,sha256,slot) VALUES ($1,$2,$3,'image/jpeg',1,10,10,$4,1) RETURNING id", [ev, sess, `events/${ev}/originals/${code}.jpg`, code])).rows[0].id;
      const c = (await pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256) VALUES ($1,$2,$3,$4,1,1,$5) RETURNING id", [ev, up, frame, `events/${ev}/finals/${code}.jpg`, code])).rows[0].id;
      return c as string;
    };
    const stale = (await pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key,status,started_at) VALUES ($1,$2,'s','printing', now() - interval '1 hour') RETURNING id", [ev, await mk("stale")])).rows[0].id;
    const fresh = (await pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key,status,started_at) VALUES ($1,$2,'f','printing', now()) RETURNING id", [ev, await mk("fresh")])).rows[0].id;
    const r = await call("print-requeue", `Bearer ${SECRET}`);
    expect(r.statusCode).toBe(200); expect(r.json().requeued).toBeGreaterThanOrEqual(1);
    const st = async (id: string) => (await pool.query("SELECT status FROM print_jobs WHERE id=$1", [id])).rows[0].status;
    expect(await st(stale)).toBe("approved"); expect(await st(fresh)).toBe("printing");
    expect((await call("print-requeue", `Bearer ${SECRET}`)).json().requeued).toBe(0);                   // running it again changes nothing
  });

  it("retention runs and reports counts (nothing to purge here)", async () => {
    (config as any).cronSecret = SECRET;
    const r = await call("retention", `Bearer ${SECRET}`);
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ ok: true, purged: 0 });
  });

  it("two runs at the same moment do no harm", async () => {
    (config as any).cronSecret = SECRET;
    const rs = await Promise.all([call("maintenance", `Bearer ${SECRET}`), call("maintenance", `Bearer ${SECRET}`), call("retention", `Bearer ${SECRET}`), call("retention", `Bearer ${SECRET}`)]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
  });
});
