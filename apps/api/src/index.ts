import { buildApp } from "./app";
import { config } from "./config";
import { createPool, migrate } from "./db";
import { requeueAllStale } from "./printService";

const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = await buildApp(pool);
await app.listen({ port: config.port, host: "0.0.0.0" });
// A printer agent that crashed or lost its connection must not leave a picture stuck in "printing": put such jobs back in the queue.
setInterval(() => { requeueAllStale(pool, config.printStaleSeconds).catch((e) => console.error("requeue failed", e)); }, 30_000).unref();
console.log(`RETREAT SOCIAL PRINT API listening on :${config.port}`);
