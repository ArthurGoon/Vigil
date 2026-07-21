import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  const pepper = process.env.SESSION_SECRET ?? "dev-secret";
  return sha256(`${pepper}:${token}`);
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const pepper = process.env.SESSION_SECRET ?? "dev-secret";
  return sha256(`ip:${pepper}:${ip}`);
}

export function hashUa(ua: string | undefined): string | null {
  if (!ua) return null;
  const pepper = process.env.SESSION_SECRET ?? "dev-secret";
  return sha256(`ua:${pepper}:${ua}`);
}
