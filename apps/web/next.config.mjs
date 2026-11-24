const api = process.env.API_URL ?? "http://localhost:4100";
export default {
  transpilePackages: ["@rsp/shared"],
  async rewrites() { return [{ source: "/api/:path*", destination: `${api}/api/:path*` }]; },
};
