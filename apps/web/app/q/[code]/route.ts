// What a scanned QR code opens (/q/<code>). When the API runs inside this project the request is handed to it under its real path
// (a rewrite would not do: a route handler still sees the original address). In every other setup next.config.mjs rewrites /q to the API
// process and this handler is switched off at build time (RSP_EMBED_API).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let api: Promise<{ handleRequest: (req: Request) => Promise<Response> }> | null = null;
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  if (process.env.RSP_EMBED_API !== "1") return Response.json({ error: "not_found" }, { status: 404 });
  const { code } = await ctx.params;
  const target = new Request(new URL(`/api/v1/public/q/${encodeURIComponent(code)}`, req.url), req);
  return (await (api ??= import(/* webpackIgnore: true */ "@rsp/api/serverless"))).handleRequest(target);
}
