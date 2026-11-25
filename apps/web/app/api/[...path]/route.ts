// The whole API runs inside this one function when the site is hosted on Vercel (same origin as the pages: the session cookie, CSRF header
// and Content-Security-Policy keep working unchanged). In every other setup the API is its own process, next.config.mjs forwards /api to it,
// and this handler is switched off at build time (RSP_EMBED_API), so none of the API is even packaged with the site.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;   // seconds: compose, mosaic render and exports are the slow ones

// Loaded with a native import so the bundler leaves the prebuilt API alone (it and its native libraries are copied into the function as they are).
let api: Promise<{ handleRequest: (req: Request) => Promise<Response> }> | null = null;
const handle = async (req: Request) => {
  if (process.env.RSP_EMBED_API !== "1") return Response.json({ error: "not_found" }, { status: 404 });
  return (await (api ??= import(/* webpackIgnore: true */ "@rsp/api/serverless"))).handleRequest(req);
};
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
