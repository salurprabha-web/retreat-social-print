import { buildApp } from "./app";
import { config } from "./config";
import { createPool, migrate } from "./db";
import { requeueAllStale } from "./printService";
import { startSyncTimer } from "./syncService";

const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = await buildApp(pool);
await app.listen({ port: config.port, host: "0.0.0.0" });
// A printer agent that crashed or lost its connection must not leave a picture stuck in "printing": put such jobs back in the queue.
setInterval(() => { requeueAllStale(pool, config.printStaleSeconds).catch((e) => console.error("requeue failed", e)); }, 30_000).unref();
// A venue server delivers its data to the cloud whenever the internet allows; it keeps working when it does not.
if (app.rspMode === "local" && app.rspSync) startSyncTimer(pool, app.rspSync, config.syncIntervalSeconds);
console.log(`RETREAT SOCIAL PRINT API listening on :${config.port} (${app.rspMode} mode)`);
