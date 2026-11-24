import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS, newLayer, type FrameLayer } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-f-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S; let evA: string, evB: string, tokA: string;
const PW = "correct horse battery";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id", [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const call = (s: S | null, method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf, ...extra } : extra });
const F = (ev: string) => `/api/v1/events/${ev}/frames`;
const upImg = async (ev: string, buf = PNG) => (await call(sup, "POST", `/api/v1/events/${ev}/frame-assets`, buf, { "content-type": "image/png" })).json().name as string;

async function mkEvent(name: string, publish: boolean) {
  const e = (await call(sup, "POST", "/api/v1/events", { name })).json().event;
  if (publish) {
    await call(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: (await call(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition });
    await call(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
    await call(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  }
  return e as { id: string; guestToken: string };
}

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup6@t.test", "super_admin");
  const a = await mkEvent("Frames A", true); const b = await mkEvent("Frames B", false);
  evA = a.id; tokA = a.guestToken; evB = b.id;
  mgrA = await mkUser("mgr6@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op6@t.test", "print_operator", evA, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("create from presets and formats", () => {
  it("creates every preset with the right slots and 300-DPI size", async () => {
    const want = { single: 1, collage2: 2, trio: 3, quad: 4, strip: 3, polaroid: 1 } as const;
    for (const p of PRESETS) {
      const r = await call(sup, "POST", F(evA), { name: p, format: p === "strip" ? "2x6" : "4x6", preset: p });
      expect(r.statusCode, p).toBe(201);
      const f = r.json().frame;
      expect(f.layers.filter((l: FrameLayer) => l.type === "photo")).toHaveLength(want[p]);
      expect(f.dpi).toBe(300);
    }
  });
  it("computes pixel sizes for each paper format and orientation", async () => {
    const mk = async (b: object) => (await call(sup, "POST", F(evA), { name: "fmt", ...b })).json().frame;
    expect(await mk({ format: "5x7" })).toMatchObject({ widthPx: 1500, heightPx: 2100 });
    expect(await mk({ format: "6x8" })).toMatchObject({ widthPx: 1800, heightPx: 2400 });
    expect(await mk({ format: "2x6" })).toMatchObject({ widthPx: 600, heightPx: 1800 });
    expect(await mk({ format: "A5" })).toMatchObject({ widthPx: 1748, heightPx: 2480 });
    expect(await mk({ format: "4x6", orientation: "landscape" })).toMatchObject({ widthPx: 1800, heightPx: 1200 });
    expect(await mk({ format: "custom", customWidthIn: 3.5, customHeightIn: 5 })).toMatchObject({ widthPx: 1050, heightPx: 1500 });
    expect((await call(sup, "POST", F(evA), { name: "bad", format: "custom" })).statusCode).toBe(400);
  });
});

describe("saving", () => {
  let frame: any;
  beforeAll(async () => { frame = (await call(sup, "POST", F(evA), { name: "Editable", format: "4x6", preset: "single" })).json().frame; });

  it("replaces layers, keeps their order, and mirrors photo slots", async () => {
    const layers = [...frame.layers, newLayer("text", {}, { text: "Hello {{event.name}}" })];
    const r = await call(sup, "PUT", `${F(evA)}/${frame.id}`, { name: "Renamed", format: "5x7", layers, expectedUpdatedAt: frame.updatedAt });
    expect(r.statusCode).toBe(200);
    const f = r.json().frame;
    expect(f).toMatchObject({ name: "Renamed", widthPx: 1500, heightPx: 2100 });
    expect(f.layers.map((l: any) => l.id)).toEqual(layers.map((l) => l.id));
    const ph = (await pool.query("SELECT placeholders FROM frames WHERE id=$1", [frame.id])).rows[0].placeholders;
    expect(ph).toHaveLength(1); expect(ph[0].slot).toBe(1);
    frame = f;
  });
  it("refuses invalid frames without touching the saved one", async () => {
    const put = (b: object) => call(sup, "PUT", `${F(evA)}/${frame.id}`, { name: "x", format: "4x6", ...b });
    expect((await put({ layers: [newLayer("text")] })).statusCode).toBe(400);                         // no photo slot
    expect((await put({ layers: [newLayer("photo", { x: 9 })] })).statusCode).toBe(400);             // out of range
    expect((await put({ layers: [newLayer("photo"), newLayer("image", {}, { src: "../../etc/x.png" })] })).statusCode).toBe(400);
    expect((await call(sup, "GET", `${F(evA)}/${frame.id}`)).json().frame.layers).toHaveLength(frame.layers.length);
  });
  it("detects two admins saving over each other", async () => {
    const stale = frame.updatedAt;
    const ok = await call(sup, "PUT", `${F(evA)}/${frame.id}`, { name: "Second", format: "5x7", layers: frame.layers, expectedUpdatedAt: stale });
    expect(ok.statusCode).toBe(200);
    const clash = await call(sup, "PUT", `${F(evA)}/${frame.id}`, { name: "Third", format: "5x7", layers: frame.layers, expectedUpdatedAt: stale });
    expect(clash.statusCode).toBe(409); expect(clash.json().error).toBe("modified_elsewhere");
  });
  it("duplicates with new layer ids, inactive by default", async () => {
    const d = (await call(sup, "POST", `${F(evA)}/${frame.id}/duplicate`)).json().frame;
    expect(d.name).toContain("(copy)"); expect(d.active).toBe(false);
    expect(d.layers.map((l: any) => l.id).some((id: string) => frame.layers.some((x: any) => x.id === id))).toBe(false);
    expect(d.layers).toHaveLength(frame.layers.length);
  });
});

describe("images, copying between events", () => {
  it("uploads a transparent PNG overlay, rejects fakes and active SVG", async () => {
    const name = await upImg(evA);
    expect(name).toMatch(/^[a-f0-9]{32}\.png$/);
    expect((await call(sup, "POST", `/api/v1/events/${evA}/frame-assets`, Buffer.from("nope"), { "content-type": "image/png" })).statusCode).toBe(415);
    expect((await call(sup, "POST", `/api/v1/events/${evA}/frame-assets`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>'), { "content-type": "image/svg+xml" })).statusCode).toBe(422);
    expect((await call(op, "GET", `/api/v1/events/${evA}/frame-assets/${name}`)).statusCode).toBe(200);
    expect((await call(mgrA, "GET", `/api/v1/events/${evB}/frame-assets/${name}`)).statusCode).toBe(403);
  });
  it("copies a frame to another event together with its images; the copy is independent", async () => {
    const name = await upImg(evA);
    const f = (await call(sup, "POST", F(evA), { name: "With overlay", format: "4x6", layers: [newLayer("photo"), newLayer("image", {}, { src: name })] })).json().frame;
    const c = await call(sup, "POST", `${F(evA)}/${f.id}/copy-to/${evB}`);
    expect(c.statusCode).toBe(201);
    const copy = c.json().frame;
    const img = copy.layers.find((l: any) => l.type === "image");
    expect(img.src).not.toBe(name); expect(img.src).toMatch(/^[a-f0-9]{32}\.png$/);
    expect((await call(sup, "GET", `/api/v1/events/${evB}/frame-assets/${img.src}`)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, "events", evB, "frames", img.src))).toBe(true);
    const evBFrames = (await call(sup, "GET", F(evB))).json().frames;
    expect(evBFrames.some((x: any) => x.id === copy.id)).toBe(true);
    expect((await pool.query("SELECT event_id FROM frames WHERE id=$1", [copy.id])).rows[0].event_id).toBe(evB);
  });
  it("copying needs edit rights on BOTH events", async () => {
    const f = (await call(sup, "POST", F(evA), { name: "Secret", format: "4x6", preset: "single" })).json().frame;
    expect((await call(mgrA, "POST", `${F(evA)}/${f.id}/copy-to/${evB}`)).statusCode).toBe(403);
    expect((await call(mgrA, "POST", `${F(evB)}/${f.id}/duplicate`)).statusCode).toBe(403);
  });
});

describe("deleting and permissions", () => {
  it("cannot delete a frame that photos were made with; unused frames delete cleanly", async () => {
    const f = (await call(sup, "POST", F(evA), { name: "Used", format: "4x6", preset: "single" })).json().frame;
    const s = (await pool.query("INSERT INTO guest_sessions(event_id,guest_code) VALUES ($1,'GUSED1') RETURNING id", [evA])).rows[0].id;
    const u = (await pool.query("INSERT INTO photo_uploads(event_id,session_id,storage_key,mime,bytes) VALUES ($1,$2,'k-used','image/jpeg',1) RETURNING id", [evA, s])).rows[0].id;
    await pool.query("INSERT INTO final_compositions(event_id,upload_id,frame_id,storage_key,width_px,height_px,sha256) VALUES ($1,$2,$3,'c-used',1200,1800,'x')", [evA, u, f.id]);
    const r = await call(sup, "DELETE", `${F(evA)}/${f.id}`);
    expect(r.statusCode).toBe(409); expect(r.json()).toMatchObject({ error: "frame_in_use", uses: 1 });
    const g = (await call(sup, "POST", F(evA), { name: "Unused", format: "4x6", preset: "single" })).json().frame;
    expect((await call(sup, "DELETE", `${F(evA)}/${g.id}`)).statusCode).toBe(200);
    expect((await pool.query("SELECT count(*)::int c FROM frame_layers WHERE frame_id=$1", [g.id])).rows[0].c).toBe(0);
  });
  it("enforces roles and event isolation", async () => {
    const f = (await call(sup, "POST", F(evA), { name: "Perm", format: "4x6", preset: "single" })).json().frame;
    expect((await call(op, "GET", `${F(evA)}/${f.id}`)).statusCode).toBe(200);
    expect((await call(op, "POST", F(evA), { name: "x", preset: "single" })).statusCode).toBe(403);
    expect((await call(mgrA, "POST", F(evA), { name: "mgr ok", preset: "single" })).statusCode).toBe(201);
    expect((await call(mgrA, "GET", F(evB))).statusCode).toBe(403);
    expect((await call(mgrA, "GET", `${F(evB)}/${f.id}`)).statusCode).toBe(403);
    expect((await call(mgrA, "GET", `${F(evA)}/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    expect((await call(null, "GET", F(evA))).statusCode).toBe(401);
  });
});

describe("guest access", () => {
  it("lists only active frames of an active, published event, and only their images", async () => {
    const used = await upImg(evA); const unused = await upImg(evA);
    const act = (await call(sup, "POST", F(evA), { name: "Live frame", format: "4x6", layers: [newLayer("photo"), newLayer("image", {}, { src: used })] })).json().frame;
    const off = (await call(sup, "POST", F(evA), { name: "Hidden frame", format: "4x6", active: false, layers: [newLayer("photo"), newLayer("image", {}, { src: unused })] })).json().frame;
    const list = await call(null, "GET", `/api/v1/public/g/${tokA}/frames`);
    expect(list.statusCode).toBe(200);
    const ids = list.json().frames.map((f: any) => f.id);
    expect(ids).toContain(act.id); expect(ids).not.toContain(off.id);
    expect(Object.keys(list.json().frames[0]).sort()).toEqual(["format", "heightPx", "id", "layers", "name", "widthPx"]);
    expect((await call(null, "GET", `/api/v1/public/g/${tokA}/frame-assets/${used}`)).statusCode).toBe(200);
    expect((await call(null, "GET", `/api/v1/public/g/${tokA}/frame-assets/${unused}`)).statusCode).toBe(404);
  });
  it("is hidden when the event is not active or not published", async () => {
    const e = await mkEvent("Frames Off", true);
    await call(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "inactive" });
    expect((await call(null, "GET", `/api/v1/public/g/${e.guestToken}/frames`)).statusCode).toBe(404);
    const draft = await mkEvent("Frames Draft", false);
    expect((await call(null, "GET", `/api/v1/public/g/${draft.guestToken}/frames`)).statusCode).toBe(404);
    expect((await call(null, "GET", `/api/v1/public/g/bad/frames`)).statusCode).toBe(404);
  });
});
