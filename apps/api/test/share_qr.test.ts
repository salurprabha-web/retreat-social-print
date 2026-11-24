import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import jsQR from "jsqr";
import { presetLayers } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-q-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S, mgrB: S; let evA: string, evB: string, tokA: string, tokB: string;
const PW = "correct horse battery"; const BASE = "https://photos.example.com";

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$1,$2,$3) RETURNING id", [email, await hashPassword(PW), role])).rows[0].id;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S;
}
const adm = (s: S | null, method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf, ...extra } : extra });
async function mkEvent(name: string, hashtag = "Tag") {
  const e = (await adm(sup, "POST", "/api/v1/events", { name, hashtag })).json().event;
  const def = (await adm(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await adm(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await adm(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  return e as { id: string; guestToken: string };
}
async function decode(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}
const qrList = async (ev: string, s = sup) => (await adm(s, "GET", `/api/v1/events/${ev}/qr?base=${BASE}`)).json().qrCodes as any[];
const png = (w: number, h: number, c: string) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup8@t.test", "super_admin");
  const a = await mkEvent("Share QR A", "ShareA"), b = await mkEvent("Share QR B");
  evA = a.id; tokA = a.guestToken; evB = b.id; tokB = b.guestToken;
  mgrA = await mkUser("mgr8@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op8@t.test", "print_operator", evA, "print_operator");
  mgrB = await mkUser("mgrb8@t.test", "event_manager", evB, "event_manager");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("QR codes: management", () => {
  it("every event starts with a default QR; more can be added; codes are unguessable", async () => {
    const l = await qrList(evA);
    expect(l).toHaveLength(1); expect(l[0]).toMatchObject({ label: "Main QR", enabled: true, scans: 0 });
    expect(l[0].code).toMatch(/^[a-z2-7]{10}$/); expect(l[0].url).toBe(`${BASE}/q/${l[0].code}`);
    const c = await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Lobby kiosk", kioskLabel: "Kiosk 2 (22-inch)" });
    expect(c.statusCode).toBe(201);
    expect(c.json().qr).toMatchObject({ label: "Lobby kiosk", kioskLabel: "Kiosk 2 (22-inch)", style: { fg: "#000000", bg: "#ffffff", logo: false } });
    expect(new Set((await qrList(evA)).map((q) => q.code)).size).toBe(2);
  });
  it("validates landing URLs, expiry and colour contrast", async () => {
    const post = (b: object) => adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "x", ...b });
    expect((await post({ landingUrl: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await post({ landingUrl: "http://insecure.example.com" })).statusCode).toBe(400);
    expect((await post({ landingUrl: "https://example.com/promo" })).statusCode).toBe(201);
    expect((await post({ expiresAt: "tomorrow" })).statusCode).toBe(400);
    expect((await post({ style: { fg: "#888888", bg: "#999999" } })).json().error).toBe("low_contrast");
    expect((await post({ style: { fg: "#ffffff", bg: "#000000" } })).json().error).toBe("low_contrast");   // inverted codes scan unreliably
    expect((await post({ style: { fg: "#7a0c1e", bg: "#fff4d6" } })).statusCode).toBe(201);
  });
  it("edits, disables, regenerates and deletes", async () => {
    const q = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Temp" })).json().qr;
    const p = await adm(sup, "PATCH", `/api/v1/events/${evA}/qr/${q.id}`, { label: "Renamed", enabled: false, kioskLabel: "Door" });
    expect(p.json().qr).toMatchObject({ label: "Renamed", enabled: false, kioskLabel: "Door" });
    expect((await adm(sup, "PATCH", `/api/v1/events/${evA}/qr/${q.id}`, {})).statusCode).toBe(400);
    const r = await adm(sup, "POST", `/api/v1/events/${evA}/qr/${q.id}/regenerate`);
    expect(r.json().qr.code).not.toBe(q.code); expect(r.json().qr.id).toBe(q.id);
    expect((await adm(sup, "DELETE", `/api/v1/events/${evA}/qr/${q.id}`)).statusCode).toBe(200);
    expect((await adm(sup, "DELETE", `/api/v1/events/${evA}/qr/${q.id}`)).statusCode).toBe(404);
  });
  it("enforces roles and event isolation", async () => {
    const id = (await qrList(evA))[0].id;
    expect((await adm(op, "GET", `/api/v1/events/${evA}/qr`)).statusCode).toBe(200);
    expect((await adm(op, "POST", `/api/v1/events/${evA}/qr`, { label: "nope" })).statusCode).toBe(403);
    expect((await adm(mgrA, "POST", `/api/v1/events/${evA}/qr`, { label: "ok" })).statusCode).toBe(201);
    expect((await adm(mgrB, "GET", `/api/v1/events/${evA}/qr`)).statusCode).toBe(403);
    expect((await adm(mgrB, "PATCH", `/api/v1/events/${evB}/qr/${id}`, { label: "steal" })).statusCode).toBe(404);   // A's QR through B's event
    expect((await adm(null, "GET", `/api/v1/events/${evA}/qr`)).statusCode).toBe(401);
  });
});

describe("QR codes: scanning and analytics", () => {
  let q: any;
  beforeAll(async () => { q = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Scan test" })).json().qr; });
  const scan = (code: string) => adm(null, "GET", `/api/v1/public/q/${code}`);

  it("redirects to the guest page, counts the scan and keeps a dated record", async () => {
    const r = await scan(q.code);
    expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(`/g/${tokA}`);
    await scan(q.code);
    const row = (await pool.query("SELECT scans FROM qr_tracking WHERE id=$1", [q.id])).rows[0];
    expect(row.scans).toBe(2);
    expect((await pool.query("SELECT count(*)::int c FROM qr_scan_events WHERE qr_id=$1", [q.id])).rows[0].c).toBe(2);
    const listed = (await qrList(evA)).find((x) => x.id === q.id);
    expect(listed.scans).toBe(2); expect(listed.scansByDay.reduce((n: number, d: any) => n + d.count, 0)).toBe(2);
  });
  it("uses a custom landing URL when set", async () => {
    const c = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Promo", landingUrl: "https://example.com/promo" })).json().qr;
    expect((await scan(c.code)).headers.location).toBe("https://example.com/promo");
  });
  it("shows a friendly page and does NOT count scans for disabled, expired, replaced, unknown or inactive-event codes", async () => {
    const before = (await pool.query("SELECT count(*)::int c FROM qr_scan_events")).rows[0].c;
    const d = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Off", enabled: false })).json().qr;
    const x = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Exp", expiresAt: new Date(Date.now() - 3600_000).toISOString() })).json().qr;
    const g = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Regen" })).json().qr;
    await adm(sup, "POST", `/api/v1/events/${evA}/qr/${g.id}/regenerate`);
    for (const code of [d.code, x.code, g.code, "aaaaaaaaaa", "not-a-code"]) {
      const r = await scan(code); expect(r.statusCode, code).toBe(410); expect(r.headers["content-type"]).toContain("text/html"); expect(r.payload).toContain("not active");
    }
    const e = await mkEvent("Inactive scan"); const code = (await qrList(e.id))[0].code;
    expect((await scan(code)).statusCode).toBe(302);
    await adm(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "inactive" });
    expect((await scan(code)).statusCode).toBe(410);
    expect((await pool.query("SELECT count(*)::int c FROM qr_scan_events")).rows[0].c).toBe(before + 1);   // only the one good scan above
  });
  it("the old code stops working the moment a QR is regenerated", async () => {
    const n = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Rotate" })).json().qr;
    expect((await scan(n.code)).statusCode).toBe(302);
    const r = (await adm(sup, "POST", `/api/v1/events/${evA}/qr/${n.id}/regenerate`)).json().qr;
    expect((await scan(n.code)).statusCode).toBe(410); expect((await scan(r.code)).statusCode).toBe(302);
    expect((await pool.query("SELECT scans FROM qr_tracking WHERE id=$1", [n.id])).rows[0].scans).toBe(2);   // history is kept
  });
  it("kiosk display data exposes only what a screen needs", async () => {
    const r = await adm(null, "GET", `/api/v1/public/q/${q.code}/display`);
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(["eventName", "hasLogo", "hashtag", "path", "style", "theme"]);
    expect(r.json().path).toBe(`/q/${q.code}`); expect(JSON.stringify(r.json())).not.toContain(tokA);
    expect((await adm(null, "GET", `/api/v1/public/q/aaaaaaaaaa/display`)).statusCode).toBe(404);
  });
});

describe("QR codes: downloads (decoded with a real QR reader)", () => {
  let q: any;
  beforeAll(async () => { q = (await qrList(evA))[0]; });
  const img = (id: string, qs: string) => adm(sup, "GET", `/api/v1/events/${evA}/qr/${id}/image?base=${BASE}&${qs}`);

  it("PNG decodes to the tracking URL at several sizes", async () => {
    for (const size of [256, 1024, 2048]) {
      const r = await img(q.id, `format=png&size=${size}`);
      expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toBe("image/png");
      expect((await sharp(r.rawPayload).metadata()).width).toBe(size);
      expect(await decode(r.rawPayload)).toBe(`${BASE}/q/${q.code}`);
    }
  });
  it("SVG decodes too and downloads with a file name", async () => {
    const r = await img(q.id, "format=svg&size=800&download=1");
    expect(r.headers["content-type"]).toContain("image/svg+xml"); expect(r.headers["content-disposition"]).toContain(`qr-${q.code}.svg`);
    const rendered = await sharp(Buffer.from(r.payload), { density: 144 }).resize(800).png().toBuffer();
    expect(await decode(rendered)).toBe(`${BASE}/q/${q.code}`);
  });
  it("custom colours stay scannable", async () => {
    const c = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "Gold", style: { fg: "#5a0a16", bg: "#fff4d6", margin: 3 } })).json().qr;
    expect(await decode((await img(c.id, "size=1024")).rawPayload)).toBe(`${BASE}/q/${c.code}`);
  });
  it("a logo in the centre does not break scanning (PNG and SVG)", async () => {
    const up = await adm(sup, "POST", `/api/v1/events/${evA}/logo/event`, await png(600, 300, "#c0392b"), { "content-type": "image/png" });
    expect(up.statusCode).toBe(201);
    const c = (await adm(sup, "POST", `/api/v1/events/${evA}/qr`, { label: "With logo", style: { logo: true } })).json().qr;
    const p = await img(c.id, "size=1200");
    expect(await decode(p.rawPayload)).toBe(`${BASE}/q/${c.code}`);
    const centre = await sharp(await sharp(p.rawPayload).extract({ left: 560, top: 560, width: 80, height: 80 }).png().toBuffer()).stats();
    expect(centre.channels[0].mean).toBeGreaterThan(centre.channels[2].mean + 40);   // reddish logo really is in the middle
    const s = await img(c.id, "format=svg&size=1200");
    expect(s.payload).toContain("<image");
    expect(await decode(await sharp(Buffer.from(s.payload), { density: 144 }).resize(1200).png().toBuffer())).toBe(`${BASE}/q/${c.code}`);
  });
  it("needs a base address and ignores a malformed one", async () => {
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/qr/${q.id}/image`)).json().error).toBe("base_required");
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/qr/${q.id}/image?base=javascript:alert(1)`)).statusCode).toBe(400);
    expect((await adm(sup, "GET", `/api/v1/events/${evA}/qr/${q.id}/image?base=${BASE}&size=99999`)).statusCode).toBe(400);
  });
  it("poster is an A4 300-DPI PNG whose QR still decodes", async () => {
    const r = await adm(sup, "GET", `/api/v1/events/${evA}/qr/${q.id}/poster?base=${BASE}`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toContain("qr-poster-");
    const m = await sharp(r.rawPayload).metadata();
    expect([m.width, m.height, m.density]).toEqual([2480, 3508, 300]);
    expect(await decode(r.rawPayload)).toBe(`${BASE}/q/${q.code}`);
  });
  it("downloads respect event isolation", async () => {
    expect((await adm(mgrB, "GET", `/api/v1/events/${evB}/qr/${q.id}/image?base=${BASE}`)).statusCode).toBe(404);
    expect((await adm(mgrB, "GET", `/api/v1/events/${evA}/qr/${q.id}/image?base=${BASE}`)).statusCode).toBe(403);
    expect((await adm(op, "GET", `/api/v1/events/${evA}/qr/${q.id}/image?base=${BASE}`)).statusCode).toBe(200);
  });
});

describe("share settings and share attempts", () => {
  let sid: string, cid: string, otherSid: string;
  const G = (t: string) => `/api/v1/public/g/${t}`;
  const share = (sessionId: string | null, composition: string, channel: unknown, token = tokA) =>
    app.inject({ method: "POST", url: `${G(token)}/composition/${composition}/share`, payload: { channel } as any, headers: sessionId ? { "x-guest-session": sessionId } : {} });
  beforeAll(async () => {
    await adm(sup, "POST", `/api/v1/events/${evA}/frames`, { name: "Single", format: "4x6", layers: presetLayers("single", 1200, 1800) });
    const frame = (await adm(sup, "GET", `/api/v1/events/${evA}/frames`)).json().frames.find((f: any) => f.name === "Single").id;
    const mk = async () => (await app.inject({ method: "POST", url: `${G(tokA)}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
    sid = await mk(); otherSid = await mk();
    const up = (await app.inject({ method: "POST", url: `${G(tokA)}/photo`, payload: await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#336699" } }).jpeg().toBuffer(), headers: { "content-type": "application/octet-stream", "x-guest-session": sid } })).json().uploadId;
    cid = (await app.inject({ method: "POST", url: `${G(tokA)}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 } }] } as any, headers: { "x-guest-session": sid } })).json().compositionId;
  });

  it("saves share settings and hands the guest page resolved defaults", async () => {
    const p = await adm(sup, "PATCH", `/api/v1/events/${evA}`, { settings: {
      instagramHandle: "retreat.arcade", suggestedCaption: "Wow {{event.name}} {{event.instagram}}",
      share: { instructions: "Tag us!", sponsorHashtags: ["Acme"], labels: { instagram: "Post to Insta" }, channels: { whatsapp: false } },
    } });
    expect(p.statusCode).toBe(200); expect(p.json().event.settings.share.sponsorHashtags).toEqual(["Acme"]);
    const pub = (await adm(null, "GET", G(tokA))).json().settings;
    expect(pub.instagramHandle).toBe("retreat.arcade"); expect(pub.suggestedCaption).toContain("{{event.name}}");
    expect(pub.share.labels.instagram).toBe("Post to Insta"); expect(pub.share.labels.download).toBe("Download photo");
    expect(pub.share.channels).toMatchObject({ whatsapp: false, instagram: true });
  });
  it("rejects invalid share settings", async () => {
    const bad = (share: object) => adm(sup, "PATCH", `/api/v1/events/${evA}`, { settings: { share } });
    expect((await bad({ sponsorHashtags: ["no spaces allowed"] })).statusCode).toBe(400);
    expect((await bad({ instructions: "x".repeat(700) })).statusCode).toBe(400);
    expect((await adm(op, "PATCH", `/api/v1/events/${evA}`, { settings: { share: { instructions: "hi" } } })).statusCode).toBe(403);
  });
  it("records each tap as an attempt, never as a publication", async () => {
    for (const ch of ["instagram", "native", "download", "copy_caption", "copy_hashtag"]) {
      const r = await share(sid, cid, ch); expect(r.statusCode, ch).toBe(201); expect(r.json()).toMatchObject({ ok: true, outcome: "attempted" });
    }
    const rows = (await pool.query("SELECT channel,outcome,session_id FROM share_events WHERE composition_id=$1", [cid])).rows;
    expect(rows.map((r) => r.channel).sort()).toEqual(["copy_caption", "copy_hashtag", "download", "instagram", "native"]);
    expect(rows.every((r) => r.outcome === "attempted" && r.session_id === sid)).toBe(true);
  });
  it("refuses unknown or disabled channels and other people's pictures", async () => {
    expect((await share(sid, cid, "facebook")).statusCode).toBe(400);
    const off = await share(sid, cid, "whatsapp"); expect(off.statusCode).toBe(400); expect(off.json().error).toBe("channel_disabled");
    expect((await share(otherSid, cid, "instagram")).statusCode).toBe(404);
    expect((await share(null, cid, "instagram")).statusCode).toBe(401);
    expect((await share(sid, "00000000-0000-4000-8000-000000000000", "instagram")).statusCode).toBe(404);
    const sB = (await app.inject({ method: "POST", url: `${G(tokB)}/session`, payload: { consent: true, fields: {} } })).json().sessionId;
    expect((await share(sB, cid, "instagram", tokB)).statusCode).toBe(404);          // another event's guest
    expect((await share(sid, cid, "instagram", tokB)).statusCode).toBe(401);         // session of A on B's link
  });
  it("counts downloads and share attempts on the dashboard", async () => {
    const d = (await adm(sup, "GET", "/api/v1/dashboard/overview")).json();
    expect(d.totalDownloads).toBeGreaterThanOrEqual(1); expect(d.shareAttempts).toBeGreaterThanOrEqual(4);
  });
  it("caps attempts per picture", async () => {
    await pool.query("INSERT INTO share_events(event_id,composition_id,channel) SELECT $1,$2,'download' FROM generate_series(1,100)", [evA, cid]);
    expect((await share(sid, cid, "instagram")).statusCode).toBe(429);
  });
});
