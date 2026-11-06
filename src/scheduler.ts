import { LIMITS } from "./config.js";
import type { Store } from "./db/store.js";
import type { Checker } from "./domain/check.js";

/**
 * In-process scheduler. Every tick it claims due watches (claimDue pushes
 * their next_check_at forward as a lease) up to the free concurrency slots
 * and runs them without waiting for the batch, so one slow site does not
 * hold the others back.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly checker: Checker,
    private readonly opts = { concurrency: LIMITS.schedulerConcurrency, pollMs: LIMITS.schedulerPollMs }
  ) {}

  start(): void {
    this.stopping = false;
    this.tick();
  }

  /** Claims and starts what fits now. Returns the started checks (tests await them). */
  tick(): Promise<unknown>[] {
    clearTimeout(this.timer);
    const started: Promise<unknown>[] = [];
    if (this.stopping) return started;
    try {
      const free = this.opts.concurrency - this.running.size;
      const due = this.store.claimDue(free, LIMITS.claimLeaseSeconds, new Date(), this.checker.busyIds());
      for (const watch of due) {
        const job = this.checker
          .run(watch)
          .then((result) => {
            const tag = result.change ? `mudou: ${result.change.summary}` : result.status;
            console.log(`[scheduler] #${watch.id} ${watch.label.slice(0, 40)}: ${tag}${result.error ? ` (${result.error})` : ""}`);
          })
          .catch((err) => console.error(`[scheduler] #${watch.id} falhou`, err))
          .finally(() => {
            this.running.delete(job);
          });
        this.running.add(job);
        started.push(job);
      }
    } catch (err) {
      console.error("[scheduler] erro ao buscar alertas vencidos", err);
    }
    if (!this.stopping) this.timer = setTimeout(() => this.tick(), this.opts.pollMs);
    return started;
  }

  /** Stops claiming new work and waits for the checks already running. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.running]);
  }
}
