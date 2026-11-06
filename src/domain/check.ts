import { LIMITS } from "../config.js";
import type { Change, Store, Watch } from "../db/store.js";
import { fetchPage } from "../lib/html.js";
import { deliverWebhook, logChange } from "../lib/notify.js";
import { decideCheck, pageTextFor } from "./observation.js";
import { nextCheckAt } from "./schedule.js";

export type CheckResult = {
  status: "ok" | "error";
  preview: string;
  error: string | null;
  change: Change | null;
};

export class AlreadyCheckingError extends Error {
  constructor() {
    super("Esse alerta já está sendo checado");
    this.name = "AlreadyCheckingError";
  }
}

/**
 * Runs checks and guarantees that one watch is never checked twice at the
 * same time: the scheduler and the "checar agora" button go through the same
 * in-flight set. With a single process this is all the locking needed.
 */
export class Checker {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly store: Store,
    private readonly fetcher: typeof fetchPage = fetchPage
  ) {}

  busyIds(): number[] {
    return [...this.inFlight];
  }

  isBusy(id: number): boolean {
    return this.inFlight.has(id);
  }

  async run(watch: Watch, opts: { manual?: boolean } = {}): Promise<CheckResult> {
    if (this.inFlight.has(watch.id)) throw new AlreadyCheckingError();
    this.inFlight.add(watch.id);
    try {
      return await this.check(watch, opts);
    } finally {
      this.inFlight.delete(watch.id);
    }
  }

  private async check(watch: Watch, opts: { manual?: boolean }): Promise<CheckResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const manualPatch = opts.manual ? { lastManualCheckAt: nowIso } : {};

    let decision;
    let httpStatus: number;
    try {
      const page = await this.fetcher(watch.url);
      httpStatus = page.httpStatus;
      decision = decideCheck(watch, pageTextFor(watch, page.html), this.store.latestSnapshot(watch.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha no check";
      const errors = watch.consecutiveErrors + 1;
      this.store.updateWatch(watch.id, {
        lastCheckedAt: nowIso,
        lastStatus: "error",
        lastError: message,
        consecutiveErrors: errors,
        nextCheckAt: nextCheckAt(now, watch.intervalMinutes, errors).toISOString(),
        ...manualPatch,
      });
      return { status: "error", preview: "", error: message, change: null };
    }

    const { observation } = decision;
    // The watch may have been deleted or retargeted while the page was loading.
    const current = this.store.getWatch(watch.id);
    if (!current || current.url !== watch.url || current.cssSelector !== watch.cssSelector ||
        current.targetText !== watch.targetText || current.monitorMode !== watch.monitorMode) {
      return { status: "ok", preview: observation.preview, error: null, change: null };
    }

    const change = this.store.transaction(() => {
      let saved: Change | null = null;
      if (!decision.unchanged) {
        this.store.insertSnapshot({
          watchId: watch.id,
          contentHash: observation.key,
          contentText: decision.snapshotPayload,
          httpStatus,
          fetchedAt: nowIso,
        });
        this.store.prune("snapshots", watch.id, LIMITS.maxSnapshotsPerWatch);
      }
      if (decision.change) {
        saved = this.store.insertChange({
          watchId: watch.id,
          kind: decision.change.kind,
          beforeText: decision.change.before,
          afterText: decision.change.after,
          summary: decision.change.summary,
          diff: decision.change.diff,
          createdAt: nowIso,
        });
        this.store.prune("changes", watch.id, LIMITS.maxChangesPerWatch);
      }
      this.store.updateWatch(watch.id, {
        lastCheckedAt: nowIso,
        lastChangedAt: saved ? nowIso : current.lastChangedAt,
        lastStatus: "ok",
        lastError: null,
        lastPreview: observation.preview,
        consecutiveErrors: 0,
        nextCheckAt: nextCheckAt(now, current.intervalMinutes, 0).toISOString(),
        ...manualPatch,
      });
      return saved;
    });

    if (change) {
      const payload = {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        kind: change.kind,
        summary: change.summary,
        diff: change.diff,
        detectedAt: nowIso,
      };
      logChange(payload);
      if (current.webhookUrl) {
        const hook = await deliverWebhook(current.webhookUrl, payload);
        if (!hook.ok) console.warn(`[vigil] webhook falhou para "${watch.label}": ${hook.error}`);
      }
    }

    return { status: "ok", preview: observation.preview, error: null, change };
  }
}
