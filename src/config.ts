import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LIMITS = {
  minIntervalMinutes: numberEnv("VIGIL_MIN_INTERVAL", 5),
  defaultIntervalMinutes: 60,
  maxBackoffMinutes: 24 * 60,
  manualCheckCooldownSeconds: numberEnv("VIGIL_CHECK_COOLDOWN", 10),
  maxHtmlBytes: 3 * 1024 * 1024,
  maxTextChars: 100_000,
  maxSnapshotsPerWatch: 20,
  maxChangesPerWatch: 200,
  fetchTimeoutMs: 15_000,
  claimLeaseSeconds: 120,
  schedulerConcurrency: numberEnv("VIGIL_CONCURRENCY", 3),
  schedulerPollMs: numberEnv("VIGIL_POLL_MS", 5000),
} as const;

export const PORT = numberEnv("PORT", 3000);

/** SQLite file. Defaults to data/vigil.db inside the project; ":memory:" is used by tests. */
export function databasePath(): string {
  return process.env.VIGIL_DB || join(ROOT_DIR, "data", "vigil.db");
}
