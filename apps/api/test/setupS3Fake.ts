import { vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { S3Backend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

// TEST_STORAGE=s3fake runs a whole suite on the S3 backend (in-memory stand-in) instead of the local disk.
// Each test file gets its own empty bucket. The signing client is a real one (signing is local arithmetic, no network).
const signer = new S3Client({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } });
(globalThis as any).__rspStorageFactory = () => new S3Backend(new FakeS3(), "test-bucket", "", signer);

// On object storage big downloads answer with a redirect to a signed storage address, which a browser follows. In this mode every request the
// tests make through app.inject follows such a redirect the same way, so the existing assertions about the downloaded bytes keep meaning the same.
// A suite that wants to look at the redirect itself sets globalThis.__rspNoFollow = true before it builds the app.
vi.mock("../src/app", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/app")>();
  return {
    ...m,
    buildApp: async (...args: Parameters<typeof m.buildApp>) => {
      const app = await m.buildApp(...args);
      if ((globalThis as any).__rspNoFollow) return app;
      const original = app.inject.bind(app) as (o: any) => Promise<any>;
      (app as any).inject = async (opts: any) => {
        const res = await original(opts);
        const loc = res.statusCode === 302 ? String(res.headers.location ?? "") : "";
        if (!/^https:\/\/[^/]+\.acct\.r2\.cloudflarestorage\.com\//.test(loc)) return res;
        const u = new URL(loc);
        const bytes = await (await import("../src/storage")).getFile(decodeURIComponent(u.pathname.slice(1)));
        const headers: Record<string, any> = { ...res.headers, "content-length": String(bytes.length) };
        delete headers.location;
        const ct = u.searchParams.get("response-content-type"); if (ct) headers["content-type"] = ct;
        const cd = u.searchParams.get("response-content-disposition"); if (cd) headers["content-disposition"] = cd;
        const text = bytes.toString("utf8");
        return { ...res, statusCode: 200, headers, rawPayload: bytes, payload: text, body: text, json: () => JSON.parse(text) };
      };
      return app;
    },
  };
});
