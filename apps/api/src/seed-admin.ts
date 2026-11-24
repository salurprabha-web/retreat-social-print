import { hashPassword } from "./auth";
import { config } from "./config";
import { createPool } from "./db";

const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "";
if (!email || password.length < 12) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars).");
  process.exit(1);
}
const pool = createPool(config.databaseUrl);
await pool.query(
  `INSERT INTO users(email,name,password_hash,global_role) VALUES ($1,'Administrator',$2,'super_admin')
   ON CONFLICT (lower(email)) DO UPDATE SET password_hash=EXCLUDED.password_hash, global_role='super_admin', active=true,
     failed_logins=0, locked_until=NULL`,
  [email, await hashPassword(password)]);
console.log(`Super administrator ready: ${email}`);
await pool.end();
