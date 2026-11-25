// What a scanned QR code opens (/q/<code>). When the API runs inside this project the request is handed to it under its real path
// (a rewrite would not do: a route handler still sees the original address). On a server that forwards /api elsewhere,
// next.config.mjs rewrites /q instead and this handler is not reached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let api: Promise<{ handleRequest: (req: Request) => Promise<Response> }> | null = null;
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const target = new Request(new URL(`/api/v1/public/q/${encodeURIComponent(code)}`, req.url), req);
  return (await (api ??= import(/* webpackIgnore: true */ "@rsp/api/serverless"))).handleRequest(target);
}
