import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { checkProductionEnv } from "./prodcheck";
import { config } from "./config";
import { createPool } from "./db";

/**
 * Entry for hosts that run the API as functions (Vercel): one Fastify app is built per function instance, on the first request, and every
 * request is handed to it as a plain web `Request`; the answer comes back as a web `Response`.
 * No long-running work happens here: scheduled jobs are the /api/v1/cron/* routes, migrations are run at deploy time (migrate-cli).
 */
let app: Promise<FastifyInstance> | null = null;

function start(): Promise<FastifyInstance> {
  const check = checkProductionEnv(process.env);
  for (const w of check.warnings) console.warn(`[config] warning: ${w}`);
  if (check.errors.length) {
    for (const e of check.errors) console.error(`[config] ERROR: ${e}`);
    throw new Error("Unsafe configuration: " + check.errors.join(" | "));
  }
  // Many instances may run at once, so each keeps few connections (use the pooled database address) and lets idle ones go quickly.
  const pool = createPool(config.databaseUrl, { max: Number(process.env.DB_POOL_MAX ?? 3), idleMs: 10_000, connectMs: 10_000 });
  return buildApp(pool, { logger: true });
}

const DROP_REQUEST_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);
const NO_BODY = new Set([101, 204, 205, 304]);

export async function handleRequest(req: Request): Promise<Response> {
  let fastify: FastifyInstance;
  try { fastify = await (app ??= start()); }
  catch (e) { app = null; console.error("[serverless] start failed:", (e as Error).message); return Response.json({ error: "server_misconfigured" }, { status: 500 }); }

  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { if (!DROP_REQUEST_HEADERS.has(k)) headers[k] = v; });
  const payload = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await req.arrayBuffer());

  const res = await fastify.inject({ method: req.method as any, url: url.pathname + url.search, headers, payload });

  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || k === "content-length" || k === "transfer-encoding" || k === "connection") continue;
    if (Array.isArray(v)) for (const x of v) out.append(k, String(x)); else out.set(k, String(v));      // several Set-Cookie headers stay separate
  }
  return new Response(NO_BODY.has(res.statusCode) || req.method === "HEAD" ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}
