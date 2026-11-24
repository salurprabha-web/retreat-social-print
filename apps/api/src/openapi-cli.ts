// Writes the generated API document: node dist/openapi-cli.js [output-file]  (default: openapi.json in the current folder).
import fs from "node:fs";
import { buildApp } from "./app";
import { createPool } from "./db";

const pool = createPool("postgres://unused:unused@127.0.0.1:1/unused");      // the document comes from the registered routes; nothing connects
const app = await buildApp(pool);
await app.ready();
const { buildOpenApi } = await import("./openapi");
const out = process.argv[2] ?? "openapi.json";
fs.writeFileSync(out, JSON.stringify(buildOpenApi(app.rspRoutes, "0.1.0"), null, 2) + "\n");
console.log(`wrote ${out} (${app.rspRoutes.length} routes)`);
process.exit(0);
