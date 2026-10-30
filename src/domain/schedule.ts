import { LIMITS } from "../lib/config.js";

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Delay after a failed check. The first error keeps the normal cadence,
 * then it doubles per consecutive error, capped at 24h (or the interval
 * itself, if the interval is already longer than that).
 */
export function backoffMinutes(intervalMinutes: number, consecutiveErrors: number): number {
  const base = Math.max(intervalMinutes, LIMITS.minIntervalMinutes);
  const exponent = Math.min(Math.max(consecutiveErrors - 1, 0), 10);
  const cap = Math.max(base, LIMITS.maxBackoffMinutes);
  return Math.min(cap, base * 2 ** exponent);
}

export function nextCheckAt(
  now: Date,
  intervalMinutes: number,
  consecutiveErrors: number
): Date {
  if (consecutiveErrors > 0) {
    return addMinutes(now, backoffMinutes(intervalMinutes, consecutiveErrors));
  }
  return addMinutes(now, Math.max(intervalMinutes, LIMITS.minIntervalMinutes));
}

/** Seconds the user still has to wait before another manual check (0 = allowed). */
export function manualCheckWaitSeconds(
  lastManualCheckAt: Date | string | null,
  now: Date,
  cooldownSeconds: number = LIMITS.manualCheckCooldownSeconds
): number {
  if (!lastManualCheckAt || cooldownSeconds <= 0) return 0;
  const elapsedMs = now.getTime() - new Date(lastManualCheckAt).getTime();
  const remainingMs = cooldownSeconds * 1000 - elapsedMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}
