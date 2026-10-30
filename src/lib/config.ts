function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const LIMITS = {
  maxWatchesPerUser: numberEnv("MAX_WATCHES_PER_USER", 20),
  minIntervalMinutes: numberEnv("MIN_INTERVAL_MINUTES", 5),
  defaultIntervalMinutes: 60,
  maxBackoffMinutes: 24 * 60,
  manualCheckCooldownSeconds: numberEnv("MANUAL_CHECK_COOLDOWN_SECONDS", 30),
  maxHtmlBytes: 2 * 1024 * 1024,
  maxTextChars: 100_000,
  maxSnapshotsPerWatch: 20,
  fetchTimeoutMs: 15_000,
  claimLeaseSeconds: 60,
  workerConcurrency: numberEnv("WORKER_CONCURRENCY", 3),
  workerPollMs: numberEnv("WORKER_POLL_MS", 5000),
  ingestBatchMax: 50,
  eventRetentionDays: 90,
  sessionDays: 30,
  magicLinkMinutes: 15,
} as const;

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
