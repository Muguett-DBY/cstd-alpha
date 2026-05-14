const COOKIE_NAME = "cstd_alpha_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type SessionPayload = {
  issuedAt: string;
  userKey: string;
  username: string;
};

export async function createSessionCookie(secret: string, issuedAt = new Date().toISOString(), user?: { userKey?: string; username?: string }) {
  const username = normalizeUsername(user?.username);
  const payload = base64UrlEncode(JSON.stringify({ issuedAt, userKey: user?.userKey || usernameToKey(username), username }));
  const signature = await sign(payload, secret);
  const value = `${payload}.${signature}`;

  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export async function verifySessionCookie(cookieHeader: string | null | undefined, secret: string) {
  return Boolean(await readSessionCookie(cookieHeader, secret));
}

export async function readSessionCookie(cookieHeader: string | null | undefined, secret: string): Promise<SessionPayload | null> {
  if (!cookieHeader || !secret) return null;

  const value = parseCookie(cookieHeader, COOKIE_NAME);
  if (!value) return null;

  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;

  const expected = await sign(payload, secret);
  if (signature !== expected) return null;

  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as Partial<SessionPayload>;
    if (!decoded.issuedAt) return null;
    const ageSeconds = (Date.now() - new Date(decoded.issuedAt).getTime()) / 1000;
    if (ageSeconds < 0 || ageSeconds > SESSION_TTL_SECONDS) return null;
    const username = normalizeUsername(decoded.username);
    return {
      issuedAt: decoded.issuedAt,
      username,
      userKey: decoded.userKey || usernameToKey(username),
    };
  } catch {
    return null;
  }
}

export function normalizeUsername(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "默认用户";
}

export function usernameToKey(value: unknown) {
  const username = normalizeUsername(value);
  if (username === "默认用户") return "default";
  return username.toLowerCase().replace(/\s+/g, "-").slice(0, 80) || "default";
}

export function parseCookie(cookieHeader: string, name: string) {
  const parts = cookieHeader.split(";").map((part) => part.trim());
  const pair = parts.find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

async function sign(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
