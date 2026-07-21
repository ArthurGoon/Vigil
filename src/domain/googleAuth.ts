import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { LIMITS, appUrl } from "../lib/config.js";
import { hashToken, randomToken } from "../lib/crypto.js";
import { track } from "../lib/events.js";

function envTrim(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v.trim().replace(/^["']|["']$/g, "");
}

export function googleConfigured(): boolean {
  return Boolean(envTrim("GOOGLE_CLIENT_ID") && envTrim("GOOGLE_CLIENT_SECRET"));
}

export function googleClientId(): string {
  const id = envTrim("GOOGLE_CLIENT_ID");
  if (!id) throw new Error("GOOGLE_CLIENT_ID not configured");
  return id;
}

function googleClientSecret(): string {
  const secret = envTrim("GOOGLE_CLIENT_SECRET");
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET not configured");
  return secret;
}

export function defaultGoogleRedirectUri(): string {
  const fromEnv = envTrim("GOOGLE_REDIRECT_URI");
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const base = (envTrim("APP_URL") || appUrl()).replace(/\/$/, "");
  return `${base}/auth/google/callback`;
}

export function buildGoogleAuthUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: opts.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type GoogleTokenResponse = {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<{ email: string; name?: string; sub: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || "Google token exchange failed");
  }

  if (data.id_token) {
    return verifyGoogleIdToken(data.id_token);
  }

  if (data.access_token) {
    return fetchGoogleUserInfo(data.access_token);
  }

  throw new Error("Google did not return id_token or access_token");
}

export async function verifyGoogleIdToken(
  idToken: string
): Promise<{ email: string; name?: string; sub: string }> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  const data = (await res.json()) as {
    aud?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
    sub?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || data.error || !data.email || !data.sub) {
    throw new Error(data.error_description || data.error || "Invalid Google ID token");
  }

  const allowedAudiences = [
    googleClientId(),
    envTrim("GOOGLE_EXTENSION_CLIENT_ID"),
  ].filter(Boolean) as string[];

  if (!data.aud || !allowedAudiences.includes(data.aud)) {
    throw new Error("Google token audience mismatch");
  }

  const verified = data.email_verified === true || data.email_verified === "true";
  if (!verified) {
    throw new Error("Google email is not verified");
  }

  return {
    email: data.email.trim().toLowerCase(),
    name: data.name,
    sub: data.sub,
  };
}

async function fetchGoogleUserInfo(
  accessToken: string
): Promise<{ email: string; name?: string; sub: string }> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    sub?: string;
    error?: string;
  };
  if (!res.ok || !data.email || !data.sub) {
    throw new Error(data.error || "Failed to load Google profile");
  }
  if (data.email_verified === false) {
    throw new Error("Google email is not verified");
  }
  return {
    email: data.email.trim().toLowerCase(),
    name: data.name,
    sub: data.sub,
  };
}

export async function upsertUserByEmail(
  email: string,
  props: { source: string }
): Promise<{ id: string; email: string; createdAt: Date; isNew: boolean }> {
  const normalized = email.trim().toLowerCase();
  let [user] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  let isNew = false;

  if (!user) {
    [user] = await db.insert(users).values({ email: normalized }).returning();
    isNew = true;
    await track({
      name: "signup_completed",
      userId: user.id,
      props: { emailDomain: normalized.split("@")[1], source: props.source },
    });
  }

  return { ...user, isNew };
}

export async function createSessionForUser(
  userId: string
): Promise<{ sessionToken: string; userId: string }> {
  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + LIMITS.sessionDays * 24 * 60 * 60_000);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(sessionToken),
    expiresAt,
  });
  return { sessionToken, userId };
}

export async function loginWithGoogleProfile(
  profile: { email: string; name?: string; sub: string },
  source: "google_web" | "google_extension" | "google_id_token"
): Promise<{ sessionToken: string; userId: string; email: string; isNew: boolean }> {
  await track({
    name: "signup_started",
    props: { emailDomain: profile.email.split("@")[1], source },
  });

  const user = await upsertUserByEmail(profile.email, { source });
  const session = await createSessionForUser(user.id);

  await track({
    name: "login_google",
    userId: user.id,
    props: { source, isNew: user.isNew },
  });

  return {
    sessionToken: session.sessionToken,
    userId: user.id,
    email: user.email,
    isNew: user.isNew,
  };
}

/** Encode opaque state for CSRF (base64url JSON). */
export function encodeOAuthState(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeOAuthState(state: string | undefined): Record<string, string> {
  if (!state) return {};
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
