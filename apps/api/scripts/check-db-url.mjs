// Checks a database address you are about to paste into Vercel, and says what is wrong WITHOUT printing the password.
// Usage (PowerShell):   $env:CHECK_URL = '<paste the address here>'; node apps/api/scripts/check-db-url.mjs
// (single quotes, so PowerShell does not change $ or other characters in it)
const raw = process.env.CHECK_URL ?? "";
const problems = [];
const say = (m) => problems.push(m);

if (!raw) { console.log("Set CHECK_URL first:  $env:CHECK_URL = '<address>'"); process.exit(2); }
const v = raw.trim();
if (v !== raw) say("It has spaces or line breaks before or after it. Paste it again as one line with nothing around it.");
if (/^DATABASE_URL\s*=|^[A-Z_]+=/.test(v)) say("It starts with a NAME= part (copied from an .env example). Paste only the part that starts with postgresql://");
if (/^["'`]|["'`]$/.test(v)) say("It is wrapped in quotes. Remove the quotes.");
if (/^psql\s/.test(v)) say("It is a psql command, not an address. In Supabase > Connect choose the 'URI' / connection string form.");
if (!/^postgres(ql)?:\/\//i.test(v.replace(/^["'`]|["'`]$/g, ""))) say("It does not start with postgresql:// (or postgres://).");
if (/\[YOUR-PASSWORD\]|\[PASSWORD\]/i.test(v)) say("It still contains [YOUR-PASSWORD]. Replace it, including the square brackets, with your database password.");
if (/\s/.test(v)) say("It contains a space or line break in the middle.");

const m = /^postgres(?:ql)?:\/\/([^:/?#]*):(.*)@([^@/?#]+)(\/[^?#]*)?(\?.*)?$/i.exec(v);
if (m) {
  const [, user, pass, hostport, path] = m;
  const bad = [...new Set(pass.match(/[#/?@:%\[\] ]/g) ?? [])].filter((c) => !(c === "%" && /%[0-9A-Fa-f]{2}/.test(pass)));
  if (bad.length) say(`The password contains ${bad.map((c) => (c === " " ? "a space" : `'${c}'`)).join(", ")}: change the password to letters and digits, or encode them (# %23, / %2F, ? %3F, @ %40, : %3A, % %25, [ %5B, ] %5D).`);
  if (!pass) say("The password part is empty.");
  console.log(`user: ${user}   password: ${pass.length} characters (not shown)   host and port: ${hostport}   database: ${(path ?? "/").slice(1) || "(none)"}`);
  if (/supabase\.co$/i.test(hostport.split(":")[0]) && /^db\./i.test(hostport)) say("This is Supabase's DIRECT address (db.….supabase.co): Vercel cannot reach it. Use the Session pooler (port 5432) or Transaction pooler (port 6543) address.");
  if (/pooler\.supabase\.com/i.test(hostport) && !/^postgres\./i.test(user)) say("A Supabase pooler address needs the user postgres.<project ref>, not just postgres.");
  const port = hostport.split(":")[1];
  if (/pooler\.supabase\.com/i.test(hostport)) console.log(port === "6543" ? "  -> transaction pooler (use for DATABASE_URL)" : port === "5432" ? "  -> session pooler (use for DATABASE_URL_DIRECT)" : "  -> unexpected port: expected 6543 or 5432");
} else if (!problems.length) say("It does not have the shape postgresql://USER:PASSWORD@HOST:PORT/DATABASE");

try { new URL(v); } catch { if (!problems.length) say("It is not a valid address (most often a special character in the password)."); }
console.log(problems.length ? "\nProblems:\n- " + problems.join("\n- ") : "\nThe address looks right.");
process.exit(problems.length ? 1 : 0);
