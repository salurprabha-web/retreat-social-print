const api = process.env.API_URL ?? "http://localhost:4100";
export default {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",   // lets a second dev server (a local venue server demo) run beside the first
  transpilePackages: ["@rsp/shared"],
  compress: false,   // gzip would buffer the live (SSE) print stream; compression belongs to the reverse proxy
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      // What a scanned QR code opens: the API counts the scan and redirects to the guest page.
      { source: "/q/:code", destination: `${api}/api/v1/public/q/:code` },
    ];
  },
};
