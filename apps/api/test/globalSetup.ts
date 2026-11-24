import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Real PostgreSQL for tests (no Docker needed): starts a throwaway instance on a free port.
export default async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-pg-"));
  const port = 54339;
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: "test", password: "test", port, persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    // Throw-away database: skip durability work (also avoids Windows checkpoint/file-locking crashes under heavy write load).
    postgresFlags: ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "checkpoint_timeout=1h", "-c", "max_wal_size=8GB", "-c", "max_connections=300"],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("rsp_test");
  // The suites fire thousands of requests from one address; the dedicated rate-limit tests lower these themselves.
  process.env.GLOBAL_RATE_LIMIT_PER_MIN = "100000000";
  process.env.STATUS_RATE_LIMIT_PER_MIN = "100000000";
  process.env.LOGIN_RATE_LIMIT_PER_MIN = "100000"; process.env.TEST_DATABASE_URL = `postgres://test:test@localhost:${port}/rsp_test`;
  return async () => {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
