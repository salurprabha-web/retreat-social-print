import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_TEMPLATES, pageDefinitionSchema, newComponent, type PageDefinition } from "@rsp/shared";
import { createPool, migrate, type Pool } from "../src/db";
import { hashPassword } from "../src/auth";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-store-b-"));
const { buildApp } = await import("../src/app");

let pool: Pool; let app: Awaited<ReturnType<typeof buildApp>>;
type S = { cookie: string; csrf: string };
let sup: S, mgrA: S, op: S; let evA: string, evB: string, tokenA: string;
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
const B = (id: string) => `/api/v1/events/${id}/builder`;
async function working(id: string): Promise<PageDefinition> { return (await call(sup, "GET", B(id))).json().definition; }

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!);
  await migrate(pool);
  app = await buildApp(pool);
  sup = await mkUser("sup4@t.test", "super_admin");
  const a = (await call(sup, "POST", "/api/v1/events", { name: "Builder A", hashtag: "BA" })).json().event;
  evA = a.id; tokenA = a.guestToken;
  evB = (await call(sup, "POST", "/api/v1/events", { name: "Builder B" })).json().event.id;
  mgrA = await mkUser("mgr4@t.test", "event_manager", evA, "event_manager");
  op = await mkUser("op4@t.test", "print_operator", evA, "print_operator");
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("templates", () => {
  it("ships 10 built-in templates and every one passes validation", () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(10);
    for (const t of BUILTIN_TEMPLATES) expect(() => pageDefinitionSchema.parse(t.definition), t.key).not.toThrow();
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.key)).size).toBe(10);
  });
  it("lists them and applies one as an editable draft", async () => {
    const l = (await call(sup, "GET", "/api/v1/templates")).json();
    expect(l.builtin).toHaveLength(10);
    const r = await call(sup, "POST", `${B(evA)}/apply-template`, { builtin: "black-gold" });
    expect(r.statusCode).toBe(200);
    expect(r.json().definition.theme.accentColor).toBe("#d4af37");
    expect(r.json().hasUnpublishedChanges).toBe(true);
    expect((await call(sup, "POST", `${B(evA)}/apply-template`, { builtin: "nope" })).statusCode).toBe(404);
  });
});

describe("draft validation", () => {
  it("rejects javascript: links, bad asset names, bad colours and a disabled capture step", async () => {
    const base = await working(evA);
    const put = (d: unknown) => call(sup, "PUT", `${B(evA)}/draft`, { definition: d });
    const withComp = (props: object) => ({ ...base, welcome: { components: [{ ...newComponent("button"), props }] } });
    expect((await put(withComp({ label: "x", action: "link", href: "javascript:alert(1)" }))).statusCode).toBe(400);
    expect((await put(withComp({ src: "../../etc/passwd" }))).statusCode).toBe(400);
    expect((await put(withComp({ color: "red" }))).statusCode).toBe(400);
    const noCapture = { ...base, journey: { ...base.journey, steps: base.journey.steps.map((s) => (s.id === "capture" ? { ...s, enabled: false } : s)) } };
    expect((await put(noCapture)).statusCode).toBe(400);
    expect((await put({ ...base, theme: { ...base.theme, fontFamily: "Comic Sans" } })).statusCode).toBe(400);
  });
  it("saves a valid draft with optional/required guest fields", async () => {
    const d = await working(evA);
    d.theme.textColor = "#123456"; d.fields = [{ id: "f1", type: "email", label: "Email", required: false }, { id: "f2", type: "consent", label: "I agree", required: true }];
    const r = await call(sup, "PUT", `${B(evA)}/draft`, { definition: d });
    expect(r.statusCode).toBe(200);
    expect(r.json().definition.fields[1].required).toBe(true);
  });
});

describe("publish lifecycle", () => {
  it("is not visible to guests until published and the event is active", async () => {
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}`)).statusCode).toBe(404);
    expect((await call(sup, "POST", `${B(evA)}/publish`, {})).statusCode).toBe(200);
    // published, but the event is still a draft -> still hidden
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}`)).statusCode).toBe(404);
    await call(sup, "POST", `/api/v1/events/${evA}/status`, { status: "active" });
    const pub = await call(null, "GET", `/api/v1/public/g/${tokenA}`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().definition.theme.textColor).toBe("#123456");
    expect(pub.json().event.name).toBe("Builder A");
    expect(Object.keys(pub.json())).toEqual(["definition", "event", "logos", "settings"]);   // nothing else leaks
  });
  it("editing the draft does not change the live page until republished", async () => {
    const d = await working(evA); d.theme.textColor = "#abcdef";
    await call(sup, "PUT", `${B(evA)}/draft`, { definition: d });
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}`)).json().definition.theme.textColor).toBe("#123456");
    const st = (await call(sup, "GET", B(evA))).json();
    expect(st.hasUnpublishedChanges).toBe(true); expect(st.published.version).toBeLessThan(st.draftVersion);
    await call(sup, "POST", `${B(evA)}/publish`, { note: "v2" });
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}`)).json().definition.theme.textColor).toBe("#abcdef");
  });
  it("keeps version history and restores an old version into a draft", async () => {
    const st = (await call(sup, "GET", B(evA))).json();
    const states = st.versions.map((v: any) => v.state);
    expect(states.filter((s: string) => s === "published")).toHaveLength(1);
    expect(states).toContain("superseded");
    const oldest = st.versions.filter((v: any) => v.state === "superseded").pop().version;
    const r = await call(sup, "POST", `${B(evA)}/restore`, { version: oldest });
    expect(r.statusCode).toBe(200);
    expect(r.json().hasUnpublishedChanges).toBe(true);
    expect(r.json().definition.theme.textColor).toBe("#123456");
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}`)).json().definition.theme.textColor).toBe("#abcdef"); // live unchanged
    expect((await call(sup, "POST", `${B(evA)}/restore`, { version: 9999 })).statusCode).toBe(404);
  });
  it("unpublish hides the page; publishing with no draft is refused", async () => {
    expect((await call(sup, "POST", `${B(evA)}/unpublish`)).statusCode).toBe(200);
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}`)).statusCode).toBe(404);
    expect((await call(sup, "POST", `${B(evA)}/unpublish`)).statusCode).toBe(409);
  });
  it("rejects malformed tokens", async () => {
    expect((await call(null, "GET", "/api/v1/public/g/not-a-token")).statusCode).toBe(404);
  });
});

describe("saved templates", () => {
  it("strips uploaded files so another client's assets cannot leak", async () => {
    const up = await call(sup, "POST", `${B(evA)}/asset`, PNG, { "content-type": "image/png" });
    expect(up.statusCode).toBe(201);
    const name = up.json().name;
    const d = await working(evA);
    d.theme.background.type = "image"; d.theme.background.image = name;
    d.welcome.components.push(newComponent("image", { src: name }));
    const r = await call(sup, "POST", `${B(evA)}/save-template`, { name: "My look", definition: d });
    expect(r.statusCode).toBe(201);
    const row = (await pool.query("SELECT definition FROM guest_experience_templates WHERE id=$1", [r.json().id])).rows[0].definition;
    expect(JSON.stringify(row)).not.toContain(name);
    const applied = await call(sup, "POST", `${B(evB)}/apply-template`, { templateId: r.json().id });
    expect(applied.statusCode).toBe(200);
    expect((await call(sup, "GET", "/api/v1/templates")).json().saved.map((s: any) => s.name)).toContain("My look");
  });
});

describe("assets", () => {
  it("serves a public asset only when the published page references it", async () => {
    const name = (await call(sup, "POST", `${B(evA)}/asset`, PNG, { "content-type": "image/png" })).json().name;
    const d = await working(evA); d.welcome.components.push(newComponent("image", { src: name }));
    await call(sup, "PUT", `${B(evA)}/draft`, { definition: d });
    await call(sup, "POST", `${B(evA)}/publish`, {});
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}/asset/${name}`)).statusCode).toBe(200);
    const unref = (await call(sup, "POST", `${B(evA)}/asset`, PNG, { "content-type": "image/png" })).json().name;
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}/asset/${unref}`)).statusCode).toBe(404);
    expect((await call(null, "GET", `/api/v1/public/g/${tokenA}/asset/..%2F..%2Fx.png`)).statusCode).toBe(404);
  });
  it("rejects fake images and active SVG", async () => {
    expect((await call(sup, "POST", `${B(evA)}/asset`, Buffer.from("hello"), { "content-type": "image/png" })).statusCode).toBe(415);
    expect((await call(sup, "POST", `${B(evA)}/asset`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), { "content-type": "image/svg+xml" })).statusCode).toBe(422);
  });
});

describe("permissions", () => {
  it("event manager edits own event only; operator cannot edit; anonymous cannot", async () => {
    const d = await working(evA);
    expect((await call(mgrA, "PUT", `${B(evA)}/draft`, { definition: d })).statusCode).toBe(200);
    expect((await call(mgrA, "PUT", `${B(evB)}/draft`, { definition: d })).statusCode).toBe(403);
    expect((await call(mgrA, "GET", B(evB))).statusCode).toBe(403);
    expect((await call(op, "PUT", `${B(evA)}/draft`, { definition: d })).statusCode).toBe(403);
    expect((await call(op, "GET", B(evA))).statusCode).toBe(200);
    expect((await call(null, "GET", B(evA))).statusCode).toBe(401);
  });
});
