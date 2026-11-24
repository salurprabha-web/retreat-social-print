const api = process.env.API_URL ?? "http://localhost:4100";
export default {
  transpilePackages: ["@rsp/shared"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      // What a scanned QR code opens: the API counts the scan and redirects to the guest page.
      { source: "/q/:code", destination: `${api}/api/v1/public/q/:code` },
    ];
  },
};
