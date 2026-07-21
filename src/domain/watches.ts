import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { watches } from "../db/schema.js";
import { LIMITS } from "../lib/config.js";
import { track } from "../lib/events.js";

export const MONITOR_MODES = ["text_changed", "text_appears", "text_disappears"] as const;

export const createWatchSchema = z
  .object({
    url: z.string().url(),
    cssSelector: z.string().min(1).max(500).optional().nullable(),
    monitorMode: z.enum(MONITOR_MODES).default("text_changed"),
    targetText: z.string().min(2).max(2000),
    intervalMinutes: z
      .number()
      .int()
      .min(LIMITS.minIntervalMinutes)
      .default(LIMITS.minIntervalMinutes),
    webhookUrl: z.string().url().optional().nullable(),
    notifyEmail: z.boolean().optional().default(true),
    isActive: z.boolean().optional().default(true),
  })
  .refine((v) => v.notifyEmail !== false || Boolean(v.webhookUrl), {
    message: "Informe e-mail (padrão) ou um webhook",
  });

export const updateWatchSchema = z.object({
  url: z.string().url().optional(),
  cssSelector: z.string().min(1).max(500).nullable().optional(),
  monitorMode: z.enum(MONITOR_MODES).optional(),
  targetText: z.string().min(2).max(2000).optional(),
  intervalMinutes: z.number().int().min(LIMITS.minIntervalMinutes).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  notifyEmail: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export async function createWatch(userId: string, input: z.infer<typeof createWatchSchema>) {
  const [{ value: existing }] = await db
    .select({ value: count() })
    .from(watches)
    .where(eq(watches.userId, userId));

  if (Number(existing) >= LIMITS.maxWatchesPerUser) {
    throw new WatchLimitError(`Max ${LIMITS.maxWatchesPerUser} watches per user`);
  }

  const [row] = await db
    .insert(watches)
    .values({
      userId,
      url: input.url,
      cssSelector: input.cssSelector ?? null,
      monitorMode: input.monitorMode,
      targetText: input.targetText.trim(),
      intervalMinutes: input.intervalMinutes,
      webhookUrl: input.webhookUrl ?? null,
      notifyEmail: input.notifyEmail ?? true,
      isActive: input.isActive ?? true,
      nextCheckAt: new Date(),
    })
    .returning();

  await track({
    name: "watch_created",
    userId,
    props: {
      watchId: row.id,
      url: row.url,
      monitorMode: row.monitorMode,
    },
  });

  return row;
}

export async function updateWatch(
  userId: string,
  watchId: string,
  input: z.infer<typeof updateWatchSchema>
) {
  const [row] = await db
    .update(watches)
    .set({
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.cssSelector !== undefined ? { cssSelector: input.cssSelector } : {}),
      ...(input.monitorMode !== undefined ? { monitorMode: input.monitorMode } : {}),
      ...(input.targetText !== undefined ? { targetText: input.targetText.trim() } : {}),
      ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}),
      ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
      ...(input.notifyEmail !== undefined ? { notifyEmail: input.notifyEmail } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    })
    .where(and(eq(watches.id, watchId), eq(watches.userId, userId)))
    .returning();

  if (!row) throw new NotFoundError("Watch not found");
  return row;
}

export async function deleteWatch(userId: string, watchId: string) {
  const [row] = await db
    .delete(watches)
    .where(and(eq(watches.id, watchId), eq(watches.userId, userId)))
    .returning();
  if (!row) throw new NotFoundError("Watch not found");
  return row;
}

export class WatchLimitError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "WatchLimitError";
  }
}

export class NotFoundError extends Error {
  status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends Error {
  status = 429;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
