import { z } from "zod";
import { LIMITS } from "../config.js";
import { MONITOR_MODES, type Store, type Watch, type WatchPatch } from "../db/store.js";

const httpUrl = z
  .string()
  .trim()
  .url("URL inválida")
  .refine((u) => /^https?:\/\//i.test(u), "Use uma URL http ou https");

const interval = z
  .number()
  .int()
  .min(LIMITS.minIntervalMinutes, `O intervalo mínimo é ${LIMITS.minIntervalMinutes} min`)
  .max(7 * 24 * 60, "O intervalo máximo é 7 dias");

const optionalUrl = z
  .union([httpUrl, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : v === undefined ? undefined : null));

const selector = z
  .union([z.string().trim().max(1000), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v ? v : null));

export const createWatchSchema = z.object({
  url: httpUrl,
  label: z.string().trim().max(200).optional(),
  cssSelector: selector,
  monitorMode: z.enum(MONITOR_MODES).default("text_changed"),
  targetText: z.string().trim().min(2, "O trecho precisa de pelo menos 2 caracteres").max(2000),
  intervalMinutes: interval.default(LIMITS.defaultIntervalMinutes),
  webhookUrl: optionalUrl,
  isActive: z.boolean().default(true),
});

export const updateWatchSchema = z.object({
  url: httpUrl.optional(),
  label: z.string().trim().min(1).max(200).optional(),
  cssSelector: selector,
  monitorMode: z.enum(MONITOR_MODES).optional(),
  targetText: z.string().trim().min(2).max(2000).optional(),
  intervalMinutes: interval.optional(),
  webhookUrl: optionalUrl,
  isActive: z.boolean().optional(),
});

/** "vagas.empresa.com/carreiras" from a URL, used when the page gave no title. */
export function defaultLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

export function createWatch(store: Store, raw: unknown, now = new Date()): Watch {
  const input = createWatchSchema.parse(raw);
  return store.insertWatch(
    {
      label: input.label || defaultLabel(input.url),
      url: input.url,
      cssSelector: input.cssSelector ?? null,
      monitorMode: input.monitorMode,
      targetText: input.targetText,
      intervalMinutes: input.intervalMinutes,
      webhookUrl: input.webhookUrl ?? null,
      isActive: input.isActive,
    },
    now
  );
}

/**
 * Changing what is observed (url, selector, text or mode) invalidates the
 * old snapshots: the next check starts a new baseline, right away.
 * Resuming a paused watch also checks right away.
 */
export function updateWatch(store: Store, id: number, raw: unknown, now = new Date()): Watch | null {
  const input = updateWatchSchema.parse(raw);
  const existing = store.getWatch(id);
  if (!existing) return null;

  const retarget =
    (input.url !== undefined && input.url !== existing.url) ||
    (input.cssSelector !== undefined && input.cssSelector !== existing.cssSelector) ||
    (input.monitorMode !== undefined && input.monitorMode !== existing.monitorMode) ||
    (input.targetText !== undefined && input.targetText !== existing.targetText);
  const resumed = input.isActive === true && !existing.isActive;

  const patch: WatchPatch = { ...input };
  if (retarget) {
    Object.assign(patch, { lastStatus: "pending", lastError: null, lastPreview: null, consecutiveErrors: 0 });
  }
  if (retarget || resumed) patch.nextCheckAt = now.toISOString();

  return store.transaction(() => {
    if (retarget) store.deleteSnapshots(id);
    return store.updateWatch(id, patch);
  });
}
