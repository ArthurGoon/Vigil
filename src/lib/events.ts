import { db } from "../db/client.js";
import { events } from "../db/schema.js";

export const EVENT_NAMES = [
  "page_view",
  "page_leave",
  "signup_started",
  "signup_completed",
  "watch_create_started",
  "watch_created",
  "watch_check_clicked",
  "watch_check_succeeded",
  "watch_check_failed",
  "dashboard_viewed",
  "watch_change_detected",
  "webhook_delivered",
  "webhook_failed",
  "login_google",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export function isEventName(value: string): value is EventName {
  return (EVENT_NAMES as readonly string[]).includes(value);
}

export type TrackInput = {
  name: EventName;
  anonymousId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  props?: Record<string, unknown>;
  ipHash?: string | null;
  uaHash?: string | null;
  occurredAt?: Date;
};

export async function track(input: TrackInput): Promise<void> {
  await db.insert(events).values({
    name: input.name,
    anonymousId: input.anonymousId ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    props: sanitizeProps(input.props ?? {}),
    ipHash: input.ipHash ?? null,
    uaHash: input.uaHash ?? null,
    occurredAt: input.occurredAt ?? new Date(),
  });
}

export async function trackMany(items: TrackInput[]): Promise<number> {
  if (!items.length) return 0;
  await db.insert(events).values(
    items.map((input) => ({
      name: input.name,
      anonymousId: input.anonymousId ?? null,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      props: sanitizeProps(input.props ?? {}),
      ipHash: input.ipHash ?? null,
      uaHash: input.uaHash ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    }))
  );
  return items.length;
}

function sanitizeProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (["password", "token", "email", "authorization"].includes(key.toLowerCase())) {
      continue;
    }
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
