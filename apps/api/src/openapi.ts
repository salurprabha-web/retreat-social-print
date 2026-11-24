import type { AuthMeta } from "./auth";

export interface RouteInfo { method: string; url: string; auth: AuthMeta | null; rateLimited: boolean }

/**
 * API document generated from the registered routes, so it cannot go stale: every path, method, path parameter, how the route is
 * protected and (for staff routes) which permission it needs come straight from the code. Request and response bodies are validated
 * inside the handlers and are intentionally not described here.
 */
export function buildOpenApi(routes: readonly RouteInfo[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagOf = (url: string) => {
    const seg = url.split("/").filter((s) => s && !s.startsWith(":") && s !== "api" && s !== "v1");
    return seg[0] === "events" && seg[1] ? `events/${seg[1]}` : seg[0] === "public" && seg[1] ? `public/${seg[1]}` : seg[0] ?? "root";
  };
  const verb: Record<string, string> = { GET: "Read", POST: "Create or run", PUT: "Replace", PATCH: "Update", DELETE: "Delete" };
  for (const r of [...routes].sort((a, b) => (a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url)))) {
    const path = r.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const params = [...r.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string", ...(/id$/i.test(m[1]) && m[1] !== "guestId" ? { format: "uuid" } : {}) } }));
    const mutating = r.method !== "GET";
    const parameters: unknown[] = [...params];
    let security: unknown[] = []; const responses: Record<string, unknown> = { "200": { description: "Success" }, "400": { description: "Validation error" }, "429": { description: "Rate limit exceeded" } };
    let access = "Public (no sign-in). The address itself, a signed link or a guest session is the credential.";
    switch (r.auth?.kind) {
      case "permission":
        security = [{ cookieAuth: [] }]; access = `Staff sign-in${r.auth.eventScoped ? " with the permission on this event" : " (super administrator)"}: ${r.auth.permission}`;
        responses["401"] = { description: "Not signed in" }; responses["403"] = { description: "No permission on this event, or missing CSRF header" };
        if (mutating) parameters.push({ name: "x-rsp-csrf", in: "header", required: true, schema: { type: "string" }, description: "Per-session CSRF token returned by login" });
        break;
      case "user":
        security = [{ cookieAuth: [] }]; access = "Any signed-in staff user (results are limited to what the user may see)";
        responses["401"] = { description: "Not signed in" };
        if (mutating) parameters.push({ name: "x-rsp-csrf", in: "header", required: true, schema: { type: "string" }, description: "Per-session CSRF token returned by login" });
        break;
      case "agent": security = [{ agentToken: [] }]; access = "Print agent credential"; responses["401"] = { description: "Missing, revoked or unknown credential" }; break;
      case "sync": security = [{ syncToken: [] }]; access = "Sync credential of a local venue server (one event only; cloud server only)"; responses["401"] = { description: "Missing or revoked credential" }; break;
    }
    const name = r.url.split("/").filter((s) => s && s !== "api" && s !== "v1").map((s) => (s.startsWith(":") ? `{${s.slice(1)}}` : s)).join(" / ");
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      operationId: `${r.method.toLowerCase()}_${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      summary: `${verb[r.method] ?? r.method}: ${name}`, description: access, tags: [tagOf(r.url)], parameters, security, responses,
      ...(r.auth?.kind === "permission" ? { "x-required-permission": r.auth.permission } : {}),
      ...(r.rateLimited ? { "x-rate-limited": true } : {}),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Retreat Social Print API", version,
      description: "Generated from the registered routes. Staff routes use the httpOnly session cookie plus the x-rsp-csrf header on every non-GET request; print agents and local venue servers use bearer credentials. Request and response bodies are validated inside the handlers and are not described in this document.",
    },
    servers: [{ url: "/" }],
    components: { securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "rsp_session" },
      agentToken: { type: "http", scheme: "bearer", description: "agt_... device credential" },
      syncToken: { type: "http", scheme: "bearer", description: "sync_... credential" },
    } },
    paths,
  };
}
