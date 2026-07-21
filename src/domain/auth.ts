import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { magicLinks, sessions, users } from "../db/schema.js";
import { LIMITS, appUrl } from "../lib/config.js";
import { hashToken, randomToken } from "../lib/crypto.js";
import { track } from "../lib/events.js";

export async function requestMagicLink(email: string): Promise<{ devLink?: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error("Invalid email");
  }

  await track({ name: "signup_started", props: { emailDomain: normalized.split("@")[1] } });

  const token = randomToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + LIMITS.magicLinkMinutes * 60_000);

  await db.insert(magicLinks).values({
    email: normalized,
    tokenHash,
    expiresAt,
  });

  const link = `${appUrl()}/auth/callback?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent("/app.html")}`;
  await sendMagicLinkEmail(normalized, link);

  const devMode = !process.env.RESEND_API_KEY;
  return devMode ? { devLink: link } : {};
}

async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[vigil:dev] Magic link for ${to}: ${link}`);
    return;
  }

  const from = process.env.MAGIC_LINK_FROM ?? "Vigil <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your Vigil login link",
      text: `Sign in to Vigil:\n\n${link}\n\nExpires in ${LIMITS.magicLinkMinutes} minutes.`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send magic link: ${body}`);
  }
}

export async function consumeMagicLink(token: string): Promise<{ sessionToken: string; userId: string }> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const [link] = await db
    .select()
    .from(magicLinks)
    .where(and(eq(magicLinks.tokenHash, tokenHash), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, now)))
    .limit(1);

  if (!link) {
    throw new Error("Invalid or expired magic link");
  }

  await db.update(magicLinks).set({ usedAt: now }).where(eq(magicLinks.id, link.id));

  let [user] = await db.select().from(users).where(eq(users.email, link.email)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ email: link.email }).returning();
    await track({
      name: "signup_completed",
      userId: user.id,
      props: { emailDomain: link.email.split("@")[1], source: "magic_link" },
    });
  }

  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + LIMITS.sessionDays * 24 * 60 * 60_000);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt,
  });

  return { sessionToken, userId: user.id };
}

export async function getUserBySessionToken(sessionToken: string | undefined) {
  if (!sessionToken) return null;
  const tokenHash = hashToken(sessionToken);
  const now = new Date();

  const rows = await db
    .select({
      user: users,
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);

  return rows[0] ?? null;
}

export async function destroySession(sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(sessionToken)));
}
