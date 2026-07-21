export type NotifyPayload = {
  watchId: string;
  url: string;
  changedAt: string;
  title: string;
  summary: string;
  preview: string;
};

export async function deliverWebhook(
  webhookUrl: string,
  payload: NotifyPayload
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "VigilBot/0.1",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, status: res.status };
      if (attempt === 1) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
    } catch (err) {
      if (attempt === 1) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "webhook failed",
        };
      }
    }
  }
  return { ok: false, error: "webhook failed" };
}

export async function deliverEmail(
  to: string,
  payload: NotifyPayload
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const subject = `Vigil: ${payload.title}`;
  const text = [
    payload.title,
    "",
    payload.summary,
    "",
    `URL: ${payload.url}`,
    `Quando: ${payload.changedAt}`,
    "",
    "Trecho:",
    payload.preview,
    "",
    "— Vigil",
  ].join("\n");

  if (!apiKey) {
    console.log(`[vigil:dev] Email to ${to}\n${subject}\n${text}`);
    return { ok: true };
  }

  const from = process.env.MAGIC_LINK_FROM ?? "Vigil <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: await res.text() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "email failed" };
  }
}

export function modeLabel(mode: string): string {
  switch (mode) {
    case "text_appears":
      return "O texto apareceu";
    case "text_disappears":
      return "O texto sumiu";
    default:
      return "O trecho monitorado mudou";
  }
}
