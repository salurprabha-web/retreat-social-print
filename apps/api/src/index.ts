import { buildApp } from "./app";
import { checkProductionEnv } from "./prodcheck";
import { config } from "./config";
import { createPool, migrate } from "./db";
import { requeueAllStale } from "./printService";
import { countPending, startSyncTimer } from "./syncService";
import { startRetentionTimer } from "./retention";

if (process.env.NODE_ENV === "production") {
  const check = checkProductionEnv(process.env);
  for (const w of check.warnings) console.warn(`[config] warning: ${w}`);
  if (check.errors.length) { for (const e of check.errors) console.error(`[config] ERROR: ${e}`); console.error("Refusing to start with an unsafe configuration."); process.exit(1); }
}
const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = await buildApp(pool, { logger: process.env.NODE_ENV === "production" });
await app.listen({ port: config.port, host: "0.0.0.0" });
// A printer agent that crashed or lost its connection must not leave a picture stuck in "printing": put such jobs back in the queue.
setInterval(() => { requeueAllStale(pool, config.printStaleSeconds).catch((e) => console.error("requeue failed", e)); }, 30_000).unref();
// A venue server delivers its data to the cloud whenever the internet allows; it keeps working when it does not.
if (app.rspMode === "local" && app.rspSync) startSyncTimer(pool, app.rspSync, config.syncIntervalSeconds);
// Archived events lose their guest data when their retention period ends (a venue server waits until everything has been delivered).
startRetentionTimer(pool, 60, app.rspMode === "local" && app.rspSync ? async (id) => (await countPending(pool, id)) === 0 : undefined);
console.log(`RETREAT SOCIAL PRINT API listening on :${config.port} (${app.rspMode} mode)`);

// Orderly shutdown: stop accepting requests, finish the ones in flight, close the database. (Docker and systemd send SIGTERM.)
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, async () => {
  if (stopping) return; stopping = true; console.log(`[server] ${sig}: shutting down`);
  const force = setTimeout(() => process.exit(1), 15_000); force.unref();
  try { await app.close(); await pool.end(); } finally { process.exit(0); }
});
