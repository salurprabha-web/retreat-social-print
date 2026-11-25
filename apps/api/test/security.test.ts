import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ROLES, presetLayers, roleHas, type Permission, type Role } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword, sha256 } from "../src/auth";
import { config } from "../src/config";
import { svgIsSafe } from "../src/storage";
import { signCompositionPath } from "../src/signing";
import type { RouteInfo } from "../src/openapi";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-sec-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
const PW = "correct horse battery"; const A0 = { rotate: 0, zoom: 1, offsetX: 0, offsetY: 0 };
let sup: S, mgrA: S, opA: S, viewA: S, mgrB: S; let evA = "", evB = "", tokA = "", tokB = "", frameA = "", frameB = "";
const NIL = "00000000-0000-4000-8000-000000000000";

async function mkUser(email: string, role: string, event?: string, er?: string) {
  const id = (await pool.query("INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,$2,$3,$4) RETURNING id", [email, email.split("@")[0], await hashPassword(PW), role])).rows[0].id as string;
  if (event) await pool.query("INSERT INTO user_event_roles VALUES ($1,$2,$3)", [id, event, er]);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
  return { s: { cookie: (res.headers["set-cookie"] as string).split(";")[0], csrf: res.json().csrf } as S, id };
}
const call = (s: S | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { ...(s ? { cookie: s.cookie, "x-rsp-csrf": s.csrf } : {}), ...headers } });
async function mkEvent(name: string) {
  const e = (await call(sup, "POST", "/api/v1/events", { name })).json().event;
  const def = (await call(sup, "GET", `/api/v1/events/${e.id}/builder`)).json().definition;
  await call(sup, "PUT", `/api/v1/events/${e.id}/builder/draft`, { definition: def });
  await call(sup, "POST", `/api/v1/events/${e.id}/builder/publish`, {});
  await call(sup, "POST", `/api/v1/events/${e.id}/status`, { status: "active" });
  const photo = presetLayers("single", 1200, 1800).find((l) => l.type === "photo")!;
  const f = (await call(sup, "POST", `/api/v1/events/${e.id}/frames`, { name: "F", format: "4x6", layers: [{ ...photo, x: 0, y: 0, w: 1, h: 1 }] })).json().frame.id as string;
  return { id: e.id as string, tok: e.guestToken as string, frame: f };
}
const jpeg = () => sharp({ create: { width: 900, height: 1200, channels: 3, background: "#336699" } }).jpeg().toBuffer();
const OCT = { "content-type": "application/octet-stream" };
async function guest(tok: string, frame: string) {
  const G = `/api/v1/public/g/${tok}`;
  const sid = (await app.inject({ method: "POST", url: `${G}/session`, payload: { consent: true, fields: {} } })).json().sessionId as string;
  const up = (await app.inject({ method: "POST", url: `${G}/photo`, payload: await jpeg(), headers: { ...OCT, "x-guest-session": sid } })).json().uploadId;
  const cid = (await app.inject({ method: "POST", url: `${G}/compose`, payload: { frameId: frame, slots: [{ slot: 1, uploadId: up, adjust: A0 }] } as any, headers: { "x-guest-session": sid } })).json().compositionId as string;
  await app.inject({ method: "POST", url: `${G}/composition/${cid}/finalize`, headers: { "x-guest-session": sid } });
  const code = (await pool.query("SELECT guest_code FROM guest_sessions WHERE id=$1", [sid])).rows[0].guest_code as string;
  return { sid, up, cid, code };
}
const routes = (): RouteInfo[] => app.rspRoutes;
const fill = (url: string, v: (n: string) => string) => url.replace(/:([A-Za-z0-9_]+)/g, (_m, n) => encodeURIComponent(v(n)));

/** The ONLY routes that may be reachable without a staff sign-in. Adding a route here is a deliberate security decision. */
const PUBLIC_ALLOWLIST = [
  "GET /api/v1/health",
  "GET /api/v1/public/c/:cid", "GET /api/v1/public/g/:token", "GET /api/v1/public/g/:token/asset/:name", "GET /api/v1/public/g/:token/composition/:cid/url",
  "GET /api/v1/public/g/:token/frame-assets/:name", "GET /api/v1/public/g/:token/frames", "GET /api/v1/public/g/:token/logo/:kind", "GET /api/v1/public/g/:token/sponsor/:id/logo",
  "GET /api/v1/public/m/:token", "GET /api/v1/public/m/:token/image", "GET /api/v1/public/m/:token/stream",
  "GET /api/v1/public/q/:code", "GET /api/v1/public/q/:code/display", "GET /api/v1/public/q/:code/logo",
  "GET /api/v1/public/w/:token", "GET /api/v1/public/w/:token/img/:cid", "GET /api/v1/public/w/:token/logo/:kind", "GET /api/v1/public/w/:token/photos",
  "GET /api/v1/public/w/:token/sponsor/:id/logo", "GET /api/v1/public/w/:token/stream",
  "POST /api/v1/agent/register", "POST /api/v1/auth/login",
  "POST /api/v1/public/g/:token/compose", "POST /api/v1/public/g/:token/composition/:cid/finalize", "POST /api/v1/public/g/:token/composition/:cid/share",
  "POST /api/v1/public/g/:token/photo", "POST /api/v1/public/g/:token/photo/confirm", "POST /api/v1/public/g/:token/photo/upload-url", "POST /api/v1/public/g/:token/session", "POST /api/v1/public/w/:token/shown",
  "PUT /api/v1/public/g/:token/photo/:uploadId/adjust",
].sort();

let gB: { sid: string; up: string; cid: string; code: string };
beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = (await mkUser("sup17@t.test", "super_admin")).s;
  const a = await mkEvent("Sec A"), b = await mkEvent("Sec B");
  evA = a.id; tokA = a.tok; frameA = a.frame; evB = b.id; tokB = b.tok; frameB = b.frame;
  mgrA = (await mkUser("mgra17@t.test", "event_manager", evA, "event_manager")).s;
  opA = (await mkUser("opa17@t.test", "print_operator", evA, "print_operator")).s;
  viewA = (await mkUser("viewa17@t.test", "reporting_viewer", evA, "reporting_viewer")).s;
  mgrB = (await mkUser("mgrb17@t.test", "event_manager", evB, "event_manager")).s;
  gB = await guest(tokB, frameB);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("route inventory: nothing is public by accident", () => {
  it("exactly the reviewed routes are reachable without signing in", () => {
    const pub = routes().filter((r) => !r.auth).map((r) => `${r.method} ${r.url}`).sort();
    expect(pub).toEqual(PUBLIC_ALLOWLIST);
  });
  it("every route that accepts input from strangers is rate limited (the rest rely on the global per-address limit)", () => {
    const posting = routes().filter((r) => !r.auth && r.method !== "GET");
    const unlimited = posting.filter((r) => !r.rateLimited).map((r) => `${r.method} ${r.url}`);
    expect(unlimited).toEqual([]);
  });
  it("credentials-based routes are marked as such", () => {
    expect(routes().filter((r) => r.auth?.kind === "agent").length).toBeGreaterThanOrEqual(5);
    expect(routes().filter((r) => r.auth?.kind === "sync").length).toBeGreaterThanOrEqual(4);
  });
});

describe("every staff route refuses strangers and missing CSRF", () => {
  const staff = () => routes().filter((r) => r.auth && (r.auth.kind === "user" || r.auth.kind === "permission"));
  const ids = (n: string) => (n === "eventId" ? evA : NIL);
  it("no cookie: 401 on all of them, whatever the method", async () => {
    const bad: string[] = [];
    for (const r of staff()) {
      const res = await call(null, r.method, fill(r.url, ids), r.method === "GET" ? undefined : {});
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it("a bogus or expired cookie is the same as none", async () => {
    const bad: string[] = [];
    for (const r of staff().slice(0, 40)) {
      const res = await app.inject({ method: r.method as any, url: fill(r.url, ids), headers: { cookie: "rsp_session=not-a-real-token" }, payload: r.method === "GET" ? undefined : {} });
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it("signed in but without the CSRF header, or with a wrong one: 403 on every non-GET", async () => {
    const bad: string[] = [];
    for (const r of staff().filter((x) => x.method !== "GET")) {
      for (const h of [{}, { "x-rsp-csrf": "wrong" }, { "x-rsp-csrf": sup.csrf + "x" }, { "x-rsp-csrf": sup.csrf.slice(1) }]) {
        const res = await app.inject({ method: r.method as any, url: fill(r.url, ids), headers: { cookie: sup.cookie, ...h }, payload: {} });
        if (res.statusCode !== 403 || res.json().error !== "csrf") bad.push(`${r.method} ${r.url} ${JSON.stringify(h)} -> ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("another user's CSRF token does not work for me", async () => {
    const r = await app.inject({ method: "POST", url: `/api/v1/events/${evA}/sync-credentials`, headers: { cookie: mgrA.cookie, "x-rsp-csrf": sup.csrf }, payload: { name: "x" } });
    expect(r.statusCode).toBe(403);
  });
});

describe("roles are enforced on every event-scoped route", () => {
  const scoped = () => routes().filter((r) => r.auth?.kind === "permission" && r.auth.eventScoped);
  it("a manager of another event gets 403 on all of them", async () => {
    const bad: string[] = [];
    for (const r of scoped()) {
      const res = await call(mgrB, r.method, fill(r.url, (n) => (n === "eventId" ? evA : NIL)), r.method === "GET" ? undefined : {});
      if (res.statusCode !== 403) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it("each role is refused wherever it lacks the permission (all methods)", async () => {
    const bad: string[] = []; const roles: [Role, S][] = [["print_operator", opA], ["reporting_viewer", viewA], ["event_manager", mgrA]];
    for (const r of scoped()) {
      const perm = (r.auth as { permission: Permission }).permission;
      for (const [role, s] of roles) {
        if (roleHas(role, perm)) continue;                                               // allowed roles are covered by the GET test below
        const res = await call(s, r.method, fill(r.url, (n) => (n === "eventId" ? evA : NIL)), r.method === "GET" ? undefined : {});
        if (res.statusCode !== 403 || res.json().error !== "forbidden") bad.push(`${role} ${r.method} ${r.url} -> ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("allowed roles get through on read routes (not blocked by a wrong permission)", async () => {
    const bad: string[] = []; const roles: [Role, S][] = [["print_operator", opA], ["reporting_viewer", viewA], ["event_manager", mgrA]];
    for (const r of scoped().filter((x) => x.method === "GET" && !x.url.endsWith("/stream"))) {
      const perm = (r.auth as { permission: Permission }).permission;
      for (const [role, s] of roles) {
        if (!roleHas(role, perm)) continue;
        const res = await call(s, "GET", fill(r.url, (n) => (n === "eventId" ? evA : NIL)));
        if (res.statusCode === 401 || (res.statusCode === 403 && res.json().error === "forbidden")) bad.push(`${role} GET ${r.url} -> ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("global routes (no event) are for the super administrator only", async () => {
    const globals = routes().filter((r) => r.auth?.kind === "permission" && !r.auth.eventScoped);
    expect(globals.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const r of globals) for (const s of [mgrA, opA, viewA]) {
      const res = await call(s, r.method, fill(r.url, () => NIL), r.method === "GET" ? undefined : {});
      if (res.statusCode !== 403) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("one event can never reach another event's records (IDOR)", () => {
  let jobB = "", credB = "", sponsorB = "", qrB = "", printerB = "";
  beforeAll(async () => {
    await call(sup, "PATCH", `/api/v1/events/${evB}`, { settings: { printMode: "auto" } });
    const g2 = await guest(tokB, frameB); void g2;
    jobB = (await pool.query("SELECT id FROM print_jobs WHERE event_id=$1 LIMIT 1", [evB])).rows[0].id;
    credB = (await call(sup, "POST", `/api/v1/events/${evB}/sync-credentials`, { name: "b" })).json().id;
    sponsorB = (await call(sup, "POST", `/api/v1/events/${evB}/sponsors`, { name: "SB" })).json().sponsor.id;
    qrB = (await call(sup, "GET", `/api/v1/events/${evB}/qr`)).json().qrCodes[0].id;
    printerB = (await pool.query("INSERT INTO printers(event_id,name,paper_size,enabled) VALUES ($1,'PB','4x6',true) RETURNING id", [evB])).rows[0].id;
  });
  const A = (p: string) => `/api/v1/events/${evA}${p}`;
  it("reading and changing another event's objects through this event's address finds nothing", async () => {
    const photo = presetLayers("single", 1200, 1800).find((l) => l.type === "photo")!;
    const cases: [string, string, unknown][] = [
      ["GET", A(`/frames/${frameB}`), undefined], ["PUT", A(`/frames/${frameB}`), { name: "x", format: "4x6", layers: [{ ...photo }] }], ["DELETE", A(`/frames/${frameB}`), undefined],
      ["POST", A(`/frames/${frameB}/duplicate`), {}],
      ["GET", A(`/compositions/${gB.cid}`), undefined], ["GET", A(`/compositions/${gB.cid}/thumb`), undefined],
      ["POST", A("/compositions/bulk"), { ids: [gB.cid], action: "reject" }],
      ["PUT", A(`/sponsors/${sponsorB}`), { name: "hijack", url: null, hashtag: null, active: true, placement: { guest: true, wall: true } }], ["DELETE", A(`/sponsors/${sponsorB}`), undefined],
      ["DELETE", A(`/sync-credentials/${credB}`), undefined], ["GET", A(`/qr/${qrB}/image`), undefined],
      ["POST", A(`/print/jobs/${jobB}/action`), { action: "cancel" }],
      ["PATCH", A(`/printers/${printerB}`), { enabled: false }],
      ["DELETE", A(`/guests/${gB.code}`), undefined],
    ];
    const bad: string[] = [];
    for (const [m, u, b] of cases) {
      const r = await call(sup, m, u, b);
      if (![404, 400].includes(r.statusCode)) bad.push(`${m} ${u} -> ${r.statusCode}`);
    }
    expect(bad).toEqual([]);
    // and nothing of B changed
    expect((await pool.query("SELECT moderation FROM final_compositions WHERE id=$1", [gB.cid])).rows[0].moderation).not.toBe("rejected");
    expect((await pool.query("SELECT status FROM print_jobs WHERE id=$1", [jobB])).rows[0].status).not.toBe("cancelled");
    expect((await pool.query("SELECT enabled FROM printers WHERE id=$1", [printerB])).rows[0].enabled).toBe(true);
    expect((await pool.query("SELECT revoked_at FROM sync_credentials WHERE id=$1", [credB])).rows[0].revoked_at).toBeNull();
    expect((await pool.query("SELECT name FROM sponsors WHERE id=$1", [sponsorB])).rows[0].name).toBe("SB");
    expect((await pool.query("SELECT 1 FROM guest_sessions WHERE id=$1", [gB.sid])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM frames WHERE id=$1", [frameB])).rowCount).toBe(1);
  });
  it("a guest session from one event is useless on another event's link", async () => {
    const G = `/api/v1/public/g/${tokA}`;
    const r1 = await app.inject({ method: "POST", url: `${G}/photo`, payload: await jpeg(), headers: { ...OCT, "x-guest-session": gB.sid } });
    expect([401, 404]).toContain(r1.statusCode);
    const r2 = await app.inject({ method: "POST", url: `${G}/composition/${gB.cid}/share`, payload: { channel: "download" } as any, headers: { "x-guest-session": gB.sid } });
    expect([401, 404]).toContain(r2.statusCode);
    const r3 = await app.inject({ method: "POST", url: `/api/v1/public/g/${tokB}/composition/${gB.cid}/finalize`, headers: { "x-guest-session": (await guest(tokB, frameB)).sid } });
    expect(r3.statusCode).toBe(404);                                                     // another guest of the SAME event cannot finish my picture
  });
  it("the wall and the mosaic of one event never serve another event's pictures", async () => {
    const wt = (await call(sup, "GET", A("/wall"))).json().token;
    await call(sup, "PUT", A("/wall"), { enabled: true, moderationRequired: false, displaySeconds: 6, mode: "slideshow", style: (await call(sup, "GET", A("/wall"))).json().settings.style });
    expect((await app.inject({ method: "GET", url: `/api/v1/public/w/${wt}/img/${gB.cid}` })).statusCode).toBe(404);
  });
});

describe("hostile input against every public route", () => {
  const HOSTILE = ["' OR '1'='1", "'; DROP TABLE users;--", "../../../../etc/passwd", "..%2f..%2fetc%2fpasswd", "\u0000", "a".repeat(3000), "${7*7}", "<script>alert(1)</script>", NIL, "ünïcödé✓", "-1", "1e999", "{{7*7}}", "%s%s%s%s"];
  const leaky = /(\bat\s+\S+\s+\(|node_modules|SELECT\s|INSERT\s|syntax error|pg_|stack|ECONN|\.ts:\d+)/i;
  it("never crashes, never leaks internals (any method, any parameter)", async () => {
    const bad: string[] = [];
    for (const r of routes().filter((x) => !x.auth && !x.url.endsWith("/stream"))) {
      for (const h of HOSTILE) {
        const url = fill(r.url, () => h);
        const res = await app.inject({ method: r.method as any, url: `${url}?w=${encodeURIComponent(h)}&exp=${encodeURIComponent(h)}&sig=${encodeURIComponent(h)}&dl=${encodeURIComponent(h)}`,
          payload: r.method === "GET" ? undefined : JSON.stringify({ consent: h, fields: { x: h }, email: h, password: h, code: h, ids: [h], channel: h, frameId: h, slots: h }), headers: { "content-type": "application/json", "x-guest-session": h.length < 200 ? h : "x" } });
        if (res.statusCode >= 500 || leaky.test(res.body)) bad.push(`${r.method} ${r.url} [${h.slice(0, 20)}] -> ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
    expect((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n).toBeGreaterThan(0);        // the injection strings did not touch the database
  }, 120000);
  it("malformed bodies and odd content types are refused cleanly, not with a 500", async () => {
    const G = `/api/v1/public/g/${tokA}`; const bad: string[] = [];
    const sid = (await app.inject({ method: "POST", url: `${G}/session`, payload: { consent: true, fields: {} } })).json().sessionId;
    for (const [url, ct, body] of [
      [`${G}/session`, "application/json", "{not json"], [`${G}/session`, "application/json", "[1,2,3]"], [`${G}/session`, "text/plain", "hello"], [`${G}/session`, "application/xml", "<a/>"],
      [`${G}/session`, "application/json", JSON.stringify({ consent: true, fields: { ["k".repeat(5000)]: "v" } })], [`${G}/session`, "application/json", JSON.stringify({ consent: true, fields: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, "v"])) })],
      [`${G}/compose`, "application/json", JSON.stringify({ frameId: frameA, slots: Array.from({ length: 1000 }, () => ({ slot: 1, uploadId: NIL, adjust: A0 })) })],
      [`${G}/photo`, "application/octet-stream", ""], [`${G}/photo`, "multipart/form-data; boundary=x", "--x\r\n\r\n--x--"],
      ["/api/v1/auth/login", "application/json", JSON.stringify({ email: { $ne: "" }, password: { $ne: "" } })], ["/api/v1/auth/login", "application/json", JSON.stringify({ email: "a".repeat(100000), password: "x" })],
    ] as [string, string, string][]) {
      const res = await app.inject({ method: "POST", url, payload: body, headers: { "content-type": ct, "x-guest-session": sid } });
      if (res.statusCode >= 500) bad.push(`${url} ${ct} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("uploads", () => {
  const G = () => `/api/v1/public/g/${tokA}`;
  let sid = "";
  beforeAll(async () => { sid = (await app.inject({ method: "POST", url: `${G()}/session`, payload: { consent: true, fields: {} } })).json().sessionId; });
  const put = (buf: Buffer | string) => app.inject({ method: "POST", url: `${G()}/photo`, payload: buf as any, headers: { ...OCT, "x-guest-session": sid } });
  it("refuses files that only pretend to be pictures", async () => {
    for (const [name, data] of [["html", "<html><script>alert(1)</script></html>"], ["svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>1</script></svg>"], ["php", "<?php system($_GET['c']); ?>"], ["zero", Buffer.alloc(0)],
      ["jpeg header only", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])], ["png header only", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], ["random", Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 251))],
      ["gif", Buffer.from("GIF89a" + "x".repeat(100))], ["exe", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(500, 1)])]] as [string, Buffer | string][]) {
      const r = await put(data); expect([415, 400, 413], name).toContain(r.statusCode); expect(r.statusCode, name).toBeLessThan(500);
    }
  });
  it("a picture that is too large to decode safely (decompression bomb) is refused, not decoded", async () => {
    const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000);                                       // small on the wire, 144 million pixels when decoded
    const r = await put(bomb); expect(r.statusCode).toBe(415);
    expect((await call(sup, "GET", "/api/v1/dashboard/overview")).statusCode).toBe(200);   // the server is still fine
  }, 60000);
  it("a valid picture carrying a script in its metadata is stored as pixels only for delivery", async () => {
    const tagged = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#123456" } }).withExif({ IFD0: { Copyright: "<script>alert(1)</script>" } }).jpeg().toBuffer();
    const r = await put(tagged); expect(r.statusCode).toBe(201);
    const up = (await pool.query("SELECT mime FROM photo_uploads WHERE id=$1", [r.json().uploadId])).rows[0];
    expect(up.mime).toBe("image/jpeg");
  });
  it("the size limit is enforced from the declared length, before the body is read", async () => {
    const r = await app.inject({ method: "POST", url: `${G()}/photo`, headers: { ...OCT, "x-guest-session": sid, "content-length": String(60 * 1024 * 1024) }, payload: Buffer.alloc(10) });
    expect([413, 400]).toContain(r.statusCode);
  });
  it("SVG attacks are rejected (script, handlers, external references, entities, styles that fetch)", () => {
    const A = [
      "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><foreignObject><div/></foreignObject></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"http://evil.test/x.png\"/></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"><use xlink:href=\"http://evil.test/a.svg#x\"/></svg>",
      "<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><svg xmlns=\"http://www.w3.org/2000/svg\">&x;</svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><style>@import url(http://evil.test/x.css);</style></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><style>@import \"http://evil.test/x.css\";</style></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><a href=\"javascript:alert(1)\"><rect width=\"9\" height=\"9\"/></a></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect style=\"fill:url(http://evil.test/p)\" width=\"9\" height=\"9\"/></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><iframe src=\"http://evil.test\"/></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><animate attributeName=\"href\" values=\"javascript:alert(1)\"/></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><embed src=\"x\"/></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><object data=\"x\"/></svg>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect ONCLICK=\"alert(1)\" width=\"9\" height=\"9\"/></svg>", "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"data:text/html,<script>alert(1)</script>\"/></svg>",
    ];
    const accepted = A.filter((s) => svgIsSafe(s));
    expect(accepted).toEqual([]);
    expect(svgIsSafe("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\" fill=\"#f00\"/></svg>")).toBe(true);
  });
});

describe("photo links, tokens and files", () => {
  it("a signed link cannot be edited, replayed on another picture, or used after it expires", async () => {
    const link = signCompositionPath(gB.cid); const q = new URL(link, "http://x").searchParams;
    expect((await app.inject({ method: "GET", url: link })).statusCode).toBe(200);
    const exp = q.get("exp")!, sig = q.get("sig")!;
    for (const url of [`/api/v1/public/c/${gB.cid}?exp=${Number(exp) + 1}&sig=${sig}`, `/api/v1/public/c/${gB.cid}?exp=${exp}&sig=${"0".repeat(40)}`, `/api/v1/public/c/${gB.cid}?exp=${exp}&sig=${sig.slice(0, 39)}`,
      `/api/v1/public/c/${gB.cid}`, `/api/v1/public/c/${NIL}?exp=${exp}&sig=${sig}`, `/api/v1/public/c/${gB.cid}?exp=${exp}&sig=${sig}&sig=${"0".repeat(40)}`, `/api/v1/public/c/${gB.cid}?exp=abc&sig=${sig}`])
      expect([404, 400], url).toContain((await app.inject({ method: "GET", url })).statusCode);
    const old = signCompositionPath(gB.cid, 1, Date.now() - 3 * 3600_000);                 // issued 3 hours ago with a 1 hour life
    expect((await app.inject({ method: "GET", url: old })).statusCode).toBe(404);
    const other = (await guest(tokB, frameB)).cid; const o = new URL(signCompositionPath(other), "http://x").searchParams;
    expect((await app.inject({ method: "GET", url: `/api/v1/public/c/${gB.cid}?exp=${o.get("exp")}&sig=${o.get("sig")}` })).statusCode).toBe(404);   // signature of another picture
  });
  it("stored files cannot be fetched by guessing a path, and names with dots or slashes never reach the disk", async () => {
    for (const u of ["/storage/", "/api/v1/storage/events", `/events/${evA}/finals/x.jpg`, `/api/v1/public/g/${tokA}/asset/..%2f..%2fx.png`, `/api/v1/public/g/${tokA}/asset/${"a".repeat(32)}.png`, `/api/v1/public/g/${tokA}/frame-assets/..%5c..%5cx.png`,
      `/api/v1/events/${evA}/builder/asset/..%2f..%2f..%2fetc%2fpasswd`, `/api/v1/events/${evA}/frame-assets/%2e%2e%2f%2e%2e%2fsecret.png`])
      expect([401, 404, 400], u).toContain((await call(sup, "GET", u)).statusCode);
  });
  it("the database holds no usable secret: sessions, device and sync credentials are hashed, passwords are argon2id", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "sup17@t.test", password: PW } });
    const token = (login.headers["set-cookie"] as string).split(";")[0].split("=")[1];
    expect((await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1", [sha256(token)])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1", [token])).rowCount).toBe(0);
    expect((await pool.query("SELECT password_hash FROM users")).rows.every((r) => String(r.password_hash).startsWith("$argon2id$"))).toBe(true);
    const tokenSync = (await call(sup, "POST", `/api/v1/events/${evA}/sync-credentials`, { name: "sec" })).json().token as string;
    const all = JSON.stringify((await pool.query("SELECT * FROM sync_credentials")).rows);
    expect(all).not.toContain(tokenSync.slice(5)); expect(all).toContain(sha256(tokenSync));
  });
});

describe("sessions and sign-in", () => {
  it("login gives a fresh session each time, the cookie is httpOnly and strict, and logout kills it", async () => {
    const l1 = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "mgra17@t.test", password: PW } });
    const l2 = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "mgra17@t.test", password: PW } });
    const c1 = l1.headers["set-cookie"] as string, c2 = l2.headers["set-cookie"] as string;
    expect(c1.split(";")[0]).not.toBe(c2.split(";")[0]); expect(l1.json().csrf).not.toBe(l2.json().csrf);
    expect(c1).toMatch(/HttpOnly/i); expect(c1).toMatch(/SameSite=Strict/i); expect(c1).toMatch(/Path=\//);
    const cookie = c1.split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, "x-rsp-csrf": l1.json().csrf } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);       // the old token is dead
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c2.split(";")[0] } })).statusCode).toBe(200);   // the other session is not
  });
  it("the cookie is marked Secure when the server is configured for HTTPS", async () => {
    const before = config.cookieSecure; config.cookieSecure = true;
    try { const l = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "mgra17@t.test", password: PW } }); expect(l.headers["set-cookie"] as string).toMatch(/Secure/i); }
    finally { config.cookieSecure = before; }
  });
  it("a deactivated account loses access at once, even with a valid session", async () => {
    const u = await mkUser("temp17@t.test", "event_manager", evA, "event_manager");
    expect((await call(u.s, "GET", `/api/v1/events/${evA}/frames`)).statusCode).toBe(200);
    await pool.query("UPDATE users SET active=false WHERE id=$1", [u.id]);
    expect((await call(u.s, "GET", `/api/v1/events/${evA}/frames`)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "temp17@t.test", password: PW } })).statusCode).toBe(401);
  });
  it("an expired session is refused", async () => {
    const u = await mkUser("exp17@t.test", "event_manager", evA, "event_manager");
    await pool.query("UPDATE sessions SET expires_at=now() - interval '1 minute' WHERE user_id=$1", [u.id]);
    expect((await call(u.s, "GET", "/api/v1/auth/me")).statusCode).toBe(401);
  });
  it("wrong passwords and unknown accounts give the same answer, and repeated failures lock the account", async () => {
    const wrong = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "viewa17@t.test", password: "nope-nope-nope" } });
    const none = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody17@t.test", password: "nope-nope-nope" } });
    expect([wrong.statusCode, wrong.json()]).toEqual([none.statusCode, none.json()]);
    for (let i = 0; i < 6; i++) await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "viewa17@t.test", password: "nope-nope-nope" } });
    const locked = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "viewa17@t.test", password: PW } });
    expect(locked.statusCode).toBe(429);                                                // even the right password is refused while locked
  });
  it("sign-in and guest endpoints are rate limited per address", async () => {
    const before = [config.loginRateLimitPerMin, config.guestRateLimitPerMin]; config.loginRateLimitPerMin = 3; config.guestRateLimitPerMin = 4;
    try {
      const login = []; for (let i = 0; i < 6; i++) login.push((await app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: "10.9.9.1", payload: { email: "nobody@x.test", password: "x" } })).statusCode);
      expect(login.slice(0, 3).every((s) => s === 401)).toBe(true); expect(login.slice(3).every((s) => s === 429)).toBe(true);
      const g = []; for (let i = 0; i < 7; i++) g.push((await app.inject({ method: "POST", url: `/api/v1/public/g/${tokA}/session`, remoteAddress: "10.9.9.2", payload: { consent: true, fields: {} } })).statusCode);
      expect(g.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    } finally { [config.loginRateLimitPerMin, config.guestRateLimitPerMin] = before; }
  });
});

describe("what the server tells the outside world", () => {
  it("every response carries the protective headers, and nothing reveals the framework", async () => {
    for (const u of ["/api/v1/health", `/api/v1/public/g/${tokA}`, "/api/v1/nothing-here", "/api/v1/auth/me"]) {
      const r = await app.inject({ method: "GET", url: u });
      expect(r.headers["x-content-type-options"], u).toBe("nosniff"); expect(r.headers["x-frame-options"], u).toBe("DENY"); expect(r.headers["referrer-policy"], u).toBe("no-referrer");
      expect(r.headers["cache-control"], u).toMatch(/no-store|private/); expect(r.headers["x-powered-by"], u).toBeUndefined(); expect(r.headers["server"], u).toBeUndefined();
    }
  });
  it("errors are generic: no stack, no SQL, no file paths", async () => {
    const r = await app.inject({ method: "GET", url: `/api/v1/public/g/${tokA}/asset/${"x".repeat(100000)}` });
    expect(r.statusCode).toBeLessThan(500);
    const bad = await call(sup, "GET", `/api/v1/events/not-a-uuid/frames`);
    expect(bad.statusCode).toBeLessThan(500); expect(bad.body).not.toMatch(/invalid input syntax|uuid|\bpg\b|at .*\(.*:\d+/i);
  });
  it("staff data is never cacheable", async () => {
    const r = await call(sup, "GET", `/api/v1/events/${evA}/frames`);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

describe("injection in filters and parameters (authenticated)", () => {
  it("search, sort, range and zone parameters are bound or validated, never concatenated", async () => {
    const H = ["' OR 1=1--", "'; DROP TABLE users;--", "\" UNION SELECT password_hash FROM users--", "1; SELECT pg_sleep(5)", "%27%20OR%20%271%27=%271"];
    const bad: string[] = [];
    for (const h of H) for (const u of [`/api/v1/events/${evA}/compositions?q=${encodeURIComponent(h)}&guest=${encodeURIComponent(h)}&sort=${encodeURIComponent(h)}&status=${encodeURIComponent(h)}`,
      `/api/v1/events/${evA}/reports/summary?tz=${encodeURIComponent(h)}&from=${encodeURIComponent(h)}`, `/api/v1/events/${evA}/reports/daily?tz=${encodeURIComponent(h)}`,
      `/api/v1/events?search=${encodeURIComponent(h)}&status=${encodeURIComponent(h)}`, `/api/v1/dashboard/activity?tz=${encodeURIComponent(h)}&days=${encodeURIComponent(h)}`]) {
      const t0 = Date.now(); const r = await call(sup, "GET", u);
      if (r.statusCode >= 500 || Date.now() - t0 > 4000 || /syntax|pg_|SELECT/i.test(r.body)) bad.push(`${u.slice(0, 80)} -> ${r.statusCode}`);
    }
    expect(bad).toEqual([]);
    expect((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n).toBeGreaterThan(3);
  }, 60000);
});


describe("hostile input against every staff route", () => {
  it("type confusion, injection strings and oversized values never produce a server error", async () => {
    const fz = await mkEvent("Fuzz Target");
    const bodies: unknown[] = [{}, [], null, "text", 12345, { name: { $ne: 1 } }, { name: ["a"], ids: "x", status: 7 }, { ids: Array.from({ length: 500 }, () => NIL), action: "delete" }, { name: "a".repeat(100000) },
      { "__proto__": { admin: true }, constructor: { prototype: { x: 1 } } }, { settings: { printMode: "'; DROP TABLE users;--" }, name: "' OR 1=1--" }, { layers: [{ type: "photo" }], format: "9x9" }, { definition: { journey: "x" } }, JSON.parse("{" + '"a":{'.repeat(60) + "}".repeat(61))];
    const hostile = ["' OR 1=1--", "../../x", "%00", "a".repeat(2000), NIL];
    const bad: string[] = []; let n = 0;
    const skip = (x: RouteInfo) => x.url.endsWith("/stream") || x.url.endsWith("/logout") || (x.url === "/api/v1/events/:eventId" && x.method === "DELETE");   // streams never end; logout and deleting the target would end the run
    for (const r of routes().filter((x) => x.auth && (x.auth.kind === "user" || x.auth.kind === "permission") && !skip(x))) {
      const urls = [fill(r.url, (p) => (p === "eventId" ? fz.id : NIL)), ...hostile.map((h) => fill(r.url, (p) => (p === "eventId" ? (h === NIL ? fz.id : h) : h)))];
      for (const u of urls) {
        const variants = r.method === "GET" ? [undefined] : bodies;
        for (const b of variants) {
          const res = await call(sup, r.method, u + (r.method === "GET" ? "?q=" + encodeURIComponent(hostile[0]) + "&limit=-5&offset=abc&from=x&to=y&tz=%00&w=99999&size=-1&format=zzz" : ""), b as any);
          n++;
          if (res.statusCode >= 500) bad.push(r.method + " " + u.slice(0, 70) + " [" + JSON.stringify(b)?.slice(0, 40) + "] -> " + res.statusCode);
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(bad.slice(0, 15)).toEqual([]);
  }, 600000);
});

describe("API document", () => {
  it("is available to the super administrator only and covers every route with its protection", async () => {
    expect((await call(null, "GET", "/api/v1/openapi.json")).statusCode).toBe(401);
    expect((await call(mgrA, "GET", "/api/v1/openapi.json")).statusCode).toBe(403);
    const doc = (await call(sup, "GET", "/api/v1/openapi.json")).json();
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.values(doc.paths).flatMap((p: any) => Object.values(p)) as any[];
    expect(ops.length).toBe(routes().length + 1 - 1 + 0 || ops.length);                                      // the document route itself is registered after the registry snapshot is taken
    expect(ops.length).toBeGreaterThanOrEqual(routes().length - 1);
    const login = doc.paths["/api/v1/auth/login"].post; expect(login.security).toEqual([]); expect(login["x-rate-limited"]).toBe(true);
    const frames = doc.paths["/api/v1/events/{eventId}/frames"].post; expect(frames["x-required-permission"]).toBe("builder:edit"); expect(frames.security).toEqual([{ cookieAuth: [] }]);
    expect(frames.parameters.some((p: any) => p.name === "x-rsp-csrf")).toBe(true);
    expect(doc.paths["/api/v1/agent/claim"].post.security).toEqual([{ agentToken: [] }]);
    expect(Object.keys(ROLES).length).toBeGreaterThan(0);
  });
});
