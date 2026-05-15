const COOKIE_NAME = "cstd_alpha_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 100_000;

export type AuthEnv = {
  AUTH_SECRET: string;
  REPORT_LIBRARY_DB?: D1Database;
};

export type UserSession = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  sessionId: string;
  expiresAt: string;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: string | null;
  disabled_at: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
};

export async function ensureAuthSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_username ON users (username)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id, expires_at DESC)`),
  ]);
}

export async function createPasswordHash(password: string, salt = randomBase64Url(16)) {
  const derived = await pbkdf2(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${salt}$${base64UrlEncodeBytes(derived)}`;
}

export async function verifyPasswordHash(password: string, stored: string) {
  const [algorithm, iterationsText, salt, expected] = stored.split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== "pbkdf2-sha256" || !Number.isFinite(iterations) || !salt || !expected) return false;
  if (iterations > PASSWORD_ITERATIONS) return false;
  const actual = base64UrlEncodeBytes(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

export async function hashSessionToken(token: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64UrlEncodeBytes(new Uint8Array(bytes));
}

export async function createUser(db: D1Database, input: { username: string; password: string; displayName?: string; role?: string; now?: string }) {
  await ensureAuthSchema(db);
  const username = normalizeUsername(input.username);
  const now = input.now ?? new Date().toISOString();
  const id = await sha256(`user:${username}`);
  const passwordHash = await createPasswordHash(input.password);
  await db
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at, disabled_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
       ON CONFLICT(username) DO UPDATE SET
         display_name = excluded.display_name,
         password_hash = excluded.password_hash,
         role = excluded.role,
         updated_at = excluded.updated_at,
         disabled_at = NULL`,
    )
    .bind(id, username, input.displayName?.trim() || input.username.trim(), passwordHash, input.role || "user", now, now)
    .run();
  return { userId: id, username, displayName: input.displayName?.trim() || input.username.trim(), role: input.role || "user" };
}

export async function authenticateUser(db: D1Database, usernameInput: string, password: string) {
  await ensureAuthSchema(db);
  const username = normalizeUsername(usernameInput);
  const user = await db
    .prepare(`SELECT id, username, display_name, password_hash, role, disabled_at FROM users WHERE username = ?1`)
    .bind(username)
    .first<UserRow>();
  if (!user || user.disabled_at) return null;
  if (!(await verifyPasswordHash(password, user.password_hash))) return null;
  return userRowToSessionUser(user);
}

export async function createAuthSession(db: D1Database, user: Omit<UserSession, "sessionId" | "expiresAt">, now = new Date()) {
  await ensureAuthSchema(db);
  const sessionId = randomBase64Url(18);
  const token = randomBase64Url(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(sessionId, user.userId, await hashSessionToken(token), now.toISOString(), expiresAt, now.toISOString())
    .run();
  return {
    cookie: createSessionCookie(sessionId, token),
    session: { ...user, sessionId, expiresAt },
  };
}

export function createSessionCookie(sessionId: string, token: string) {
  return `${COOKIE_NAME}=${sessionId}.${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function readSessionCookie(cookieHeader: string | null | undefined, env: AuthEnv): Promise<UserSession | null> {
  if (!cookieHeader || !env.REPORT_LIBRARY_DB) return null;
  await ensureAuthSchema(env.REPORT_LIBRARY_DB);
  const parsed = parseSessionCookie(cookieHeader);
  if (!parsed) return null;
  const tokenHash = await hashSessionToken(parsed.token);
  const row = await env.REPORT_LIBRARY_DB.prepare(
    `SELECT
       s.id, s.user_id, s.token_hash, s.expires_at,
       u.username, u.display_name, u.role, u.disabled_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?1`,
  )
    .bind(parsed.sessionId)
    .first<SessionRow & Pick<UserRow, "username" | "display_name" | "role" | "disabled_at">>();
  if (!row || row.disabled_at || row.token_hash !== tokenHash || new Date(row.expires_at).getTime() <= Date.now()) return null;
  await env.REPORT_LIBRARY_DB.prepare(`UPDATE auth_sessions SET last_seen_at = ?1 WHERE id = ?2`).bind(new Date().toISOString(), row.id).run();
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role || "user",
    sessionId: row.id,
    expiresAt: row.expires_at,
  };
}

export async function verifySessionCookie(cookieHeader: string | null | undefined, env: AuthEnv) {
  return Boolean(await readSessionCookie(cookieHeader, env));
}

export async function revokeSession(cookieHeader: string | null | undefined, env: AuthEnv) {
  if (!cookieHeader || !env.REPORT_LIBRARY_DB) return;
  const parsed = parseSessionCookie(cookieHeader);
  if (!parsed) return;
  await env.REPORT_LIBRARY_DB.prepare(`DELETE FROM auth_sessions WHERE id = ?1`).bind(parsed.sessionId).run();
}

export function normalizeUsername(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function publicUser(session: Pick<UserSession, "userId" | "username" | "displayName" | "role">) {
  return { userId: session.userId, username: session.username, displayName: session.displayName, role: session.role };
}

export function parseCookie(cookieHeader: string, name: string) {
  const parts = cookieHeader.split(";").map((part) => part.trim());
  const pair = parts.find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

function parseSessionCookie(cookieHeader: string) {
  const value = parseCookie(cookieHeader, COOKIE_NAME);
  if (!value) return null;
  const [sessionId, token] = value.split(".");
  if (!sessionId || !token) return null;
  return { sessionId, token };
}

function userRowToSessionUser(user: UserRow): Omit<UserSession, "sessionId" | "expiresAt"> {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role || "user",
  };
}

async function pbkdf2(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(digest)).slice(0, 32);
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
