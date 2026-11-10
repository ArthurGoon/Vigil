export type NotifyPayload = {
  watchId: number;
  label: string;
  url: string;
  kind: string;
  summary: string;
  diff: string;
  detectedAt: string;
};

/** Optional per-watch webhook: one POST with JSON, one retry. */
export async function deliverWebhook(
  webhookUrl: string,
  payload: NotifyPayload
): Promise<{ ok: boolean; error?: string }> {
  const body = JSON.stringify(payload);
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Vigil/2.0" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true };
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : "falhou";
    }
  }
  return { ok: false, error };
}

export function logChange(payload: NotifyPayload): void {
  console.log(`[vigil] mudança em "${payload.label}": ${payload.summary}\n        ${payload.url}`);
}
