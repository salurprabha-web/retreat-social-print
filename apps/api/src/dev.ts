// Local development only: starts a private PostgreSQL in ./.pgdata, migrates, and serves the API. No Docker needed.
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import { buildApp } from "./app";
import { hashPassword } from "./auth";
import { createPool, migrate } from "./db";
import { config } from "./config";
import { requeueAllStale } from "./printService";
import { startSyncTimer } from "./syncService";

const dir = process.env.DEV_PG_DIR ?? new URL("../.pgdata", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pgPort = Number(process.env.DEV_PG_PORT ?? 54340);
const fresh = !fs.existsSync(dir);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "dev", password: "dev", port: pgPort, persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"] });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("rsp_dev");
const pool = createPool(`postgres://dev:dev@localhost:${pgPort}/rsp_dev`);
await migrate(pool);
const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
if (email && password && password.length >= 12) {
  await pool.query(`INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,'Administrator',$2,'super_admin')
    ON CONFLICT (lower(email)) DO UPDATE SET password_hash=EXCLUDED.password_hash`, [email, await hashPassword(password)]);
}
const app = await buildApp(pool);
setInterval(() => { requeueAllStale(pool, config.printStaleSeconds).catch(() => {}); }, 30_000).unref();
await app.listen({ port: config.port, host: "127.0.0.1" });
if (app.rspMode === "local" && app.rspSync) startSyncTimer(pool, app.rspSync, config.syncIntervalSeconds);
console.log(`DEV API on :${config.port} (${app.rspMode} mode, database in ${dir})`);
process.on("SIGINT", async () => { await app.close(); await pool.end(); await pg.stop(); process.exit(0); });
