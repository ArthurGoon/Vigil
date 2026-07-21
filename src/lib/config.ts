export const LIMITS = {
  maxWatchesPerUser: 5,
  minIntervalMinutes: 360,
  manualCheckCooldownMinutes: 10,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxTextChars: 100_000,
  maxSnapshotsPerWatch: 20,
  fetchTimeoutMs: 15_000,
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 3),
  workerPollMs: Number(process.env.WORKER_POLL_MS ?? 5000),
  ingestBatchMax: 50,
  eventRetentionDays: 90,
  sessionDays: 30,
  magicLinkMinutes: 15,
} as const;

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

export function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}
