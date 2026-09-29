import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { config } from "./config.ts";

export type Role = "ADMIN" | "ADVISER";
export interface TokenClaims { sub: string; email: string; role: Role; exp: number }

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

// Per-process fallback secret: tokens simply stop working after a restart if AUTH_SECRET isn't set.
const secret = config.authSecret || randomBytes(32).toString("hex");
export const usingEphemeralSecret = !config.authSecret;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signToken(claims: Omit<TokenClaims, "exp">): string {
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds }));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): TokenClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch { return null; }
}

// --- tiny in-memory rate limiter (per key, sliding window) ---
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
