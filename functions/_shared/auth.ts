const COOKIE_NAME = "cstd_alpha_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function createSessionCookie(secret: string, issuedAt = new Date().toISOString()) {
  const payload = base64UrlEncode(JSON.stringify({ issuedAt }));
  const signature = await sign(payload, secret);
  const value = `${payload}.${signature}`;

  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export async function verifySessionCookie(cookieHeader: string | null | undefined, secret: string) {
  if (!cookieHeader || !secret) return false;

  const value = parseCookie(cookieHeader, COOKIE_NAME);
  if (!value) return false;

  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;

  const expected = await sign(payload, secret);
  if (signature !== expected) return false;

  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as { issuedAt?: string };
    if (!decoded.issuedAt) return false;
    const ageSeconds = (Date.now() - new Date(decoded.issuedAt).getTime()) / 1000;
    return ageSeconds >= 0 && ageSeconds <= SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
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
