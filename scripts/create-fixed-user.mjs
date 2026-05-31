import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const username = String(args.username || "").trim().toLowerCase();
const password = String(args.password || process.env.CSTD_USER_PASSWORD || "");
const displayName = String(args.displayName || args.username || "").trim();
const role = String(args.role || "user");
const database = String(args.database || "cstd-alpha-report-library");
const remote = args.remote !== "false";
const passwordIterations = 600000;

if (!username || !password) {
  console.error("Usage: node scripts/create-fixed-user.mjs --username=alice --password=secret --displayName=Alice [--role=admin] [--remote=false]");
  console.error("Tip: set CSTD_USER_PASSWORD to avoid putting the password on the command line.");
  process.exit(1);
}

const now = new Date().toISOString();
const id = (await sha256(`user:${username}`)).slice(0, 32);
const passwordHash = await createPasswordHash(password);
const sql = `
INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at, disabled_at)
VALUES (${quote(id)}, ${quote(username)}, ${quote(displayName || username)}, ${quote(passwordHash)}, ${quote(role)}, ${quote(now)}, ${quote(now)}, NULL)
ON CONFLICT(username) DO UPDATE SET
  display_name = excluded.display_name,
  password_hash = excluded.password_hash,
  role = excluded.role,
  updated_at = excluded.updated_at,
  disabled_at = NULL;
`;

const tempDir = mkdtempSync(join(tmpdir(), "cstd-user-"));
const sqlPath = join(tempDir, "user.sql");
try {
  writeFileSync(sqlPath, sql, "utf8");
  execFileSync(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "d1", "execute", database, ...(remote ? ["--remote"] : []), "--file", sqlPath], { stdio: "inherit" });
  console.log(`Created or updated fixed account: ${username}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

async function createPasswordHash(value) {
  const salt = randomBase64Url(16);
  const derived = await pbkdf2(value, salt, passwordIterations);
  return `pbkdf2-sha256$${passwordIterations}$${salt}$${base64Url(derived)}`;
}

async function pbkdf2(password, salt, iterations) {
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

async function sha256(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function randomBase64Url(length) {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
