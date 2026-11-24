import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, migrate, type Pool } from "../src/db";

let pool: Pool;
beforeAll(async () => { pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool); });
afterAll(async () => { await pool.end(); });

async function ev(name: string) {
  return (await pool.query("INSERT INTO events(name,slug) VALUES ($1,$2) RETURNING id", [name, name + Math.random()])).rows[0].id as string;
}
async function chain(eventId: string) {
  const f = (await pool.query("INSERT INTO frames(event_id,name,width_px,height_px) VALUES ($1,'f',1200,1800) RETURNING id", [eventId])).rows[0].id;
  const s = (await pool.query("INSERT INTO guest_sessions(event_id,guest_code) VALUES ($1,$2) RETURNING id", [eventId, "G" + Math.random()])).rows[0].id;
  const u = (await pool.query("INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes) VALUES ($1,$2,$3,'image/jpeg',1) RETURNING id", [eventId, s, "k" + Math.random()])).rows[0].id;
  const c = (await pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256) VALUES ($1,$2,$3,$4,1200,1800,'x') RETURNING id", [eventId, u, f, "c" + Math.random()])).rows[0].id;
  return { f, s, u, c };
}

describe("schema invariants", () => {
  it("migrations are idempotent", async () => { expect(await migrate(pool)).toEqual([]); });
  it("rejects cross-event references", async () => {
    const a = await ev("a"), b = await ev("b");
    const A = await chain(a), B = await chain(b);
    await expect(pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256) VALUES ($1,$2,$3,'z1',1,1,'x')", [a, B.u, A.f])).rejects.toThrow();
    await expect(pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256) VALUES ($1,$2,$3,'z2',1,1,'x')", [a, A.u, B.f])).rejects.toThrow();
    await expect(pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key) VALUES ($1,$2,'k')", [a, B.c])).rejects.toThrow();
  });
  it("blocks duplicate print jobs with the same idempotency key", async () => {
    const a = await ev("dup"); const A = await chain(a);
    await pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key) VALUES ($1,$2,'first')", [a, A.c]);
    await expect(pool.query("INSERT INTO print_jobs(event_id,composition_id,idempotency_key) VALUES ($1,$2,'first')", [a, A.c])).rejects.toThrow();
  });
  it("allows only one published page per event", async () => {
    const a = await ev("pg");
    await pool.query("INSERT INTO guest_experience_pages(event_id,version,state,definition) VALUES ($1,1,'published','{}')", [a]);
    await expect(pool.query("INSERT INTO guest_experience_pages(event_id,version,state,definition) VALUES ($1,2,'published','{}')", [a])).rejects.toThrow();
  });
  it("share events can only record attempts", async () => {
    const a = await ev("sh"); const A = await chain(a);
    await expect(pool.query("INSERT INTO share_events(event_id,composition_id,channel,outcome) VALUES ($1,$2,'instagram','published')", [a, A.c])).rejects.toThrow();
  });
  it("deleting an event removes all its data", async () => {
    const a = await ev("del"); await chain(a);
    await pool.query("DELETE FROM events WHERE id=$1", [a]);
    expect((await pool.query("SELECT 1 FROM final_compositions WHERE event_id=$1", [a])).rowCount).toBe(0);
  });
});
