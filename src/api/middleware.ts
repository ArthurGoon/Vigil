import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { getUserBySessionToken } from "../domain/auth.js";
import type { User } from "../db/schema.js";

export type AppVariables = {
  user: User | null;
  sessionToken: string | null;
};

const COOKIE = "vigil_session";

export function readSessionToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return getCookie(c, COOKIE);
}

export function writeSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: (process.env.APP_URL ?? "").startsWith("https"),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function sessionMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = readSessionToken(c) ?? null;
  const row = await getUserBySessionToken(token ?? undefined);
  c.set("user", row?.user ?? null);
  c.set("sessionToken", token);
  await next();
}

export function requireUser(c: Context<{ Variables: AppVariables }>): User {
  const user = c.get("user");
  if (!user) {
    throw new AuthError("Unauthorized");
  }
  return user;
}

export class AuthError extends Error {
  status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
