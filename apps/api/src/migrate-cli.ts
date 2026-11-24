import { config } from "./config";
import { createPool, migrate } from "./db";
const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
await pool.end();
