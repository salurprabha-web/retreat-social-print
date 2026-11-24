import { buildApp } from "./app";
import { config } from "./config";
import { createPool, migrate } from "./db";

const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = await buildApp(pool);
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`RETREAT SOCIAL PRINT API listening on :${config.port}`);
