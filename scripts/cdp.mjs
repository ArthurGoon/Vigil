// Cliente mínimo do Chrome DevTools Protocol, sem dependências.
// Usado só pelos scripts de desenvolvimento (screenshots e teste ponta a ponta).
//
// O Chrome estável não aceita mais --load-extension, então a extensão é carregada
// por Extensions.loadUnpacked, que exige --remote-debugging-pipe e
// --enable-unsafe-extension-debugging.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export async function launchChrome({ chromePath, headless = true, width = 1400, height = 900, extraArgs = [] } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "vigil-chrome-"));
  const args = [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    `--window-size=${width},${height}`,
    "--lang=pt-BR",
    ...(headless ? ["--headless"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(chromePath || CHROME_CANDIDATES[1], args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  proc.stderr.on("data", () => {});
  const browser = new Connection(proc.stdio[3], proc.stdio[4]);
  browser.close = async () => {
    try {
      await Promise.race([browser.send("Browser.close"), new Promise((r) => setTimeout(r, 2000))]);
    } catch (_) {
      /* já fechado */
    }
    await new Promise((r) => setTimeout(r, 300));
    proc.kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  };
  await browser.send("Target.setDiscoverTargets", { discover: true });
  return browser;
}

class Connection {
  constructor(writable, readable) {
    this.writable = writable;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    let buffer = "";
    readable.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\0")) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.dispatch(JSON.parse(raw));
      }
    });
  }

  dispatch(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, method } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    for (const fn of this.listeners) fn(message);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.writable.write(JSON.stringify(payload) + "\0");
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("timeout esperando evento do CDP"));
      }, timeoutMs);
      const off = this.on((message) => {
        if (predicate(message)) {
          clearTimeout(timer);
          off();
          resolve(message);
        }
      });
    });
  }

  async session(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => this.send(method, params, sessionId);
    return {
      sessionId,
      targetId,
      send,
      async evaluate(expression) {
        const { result, exceptionDetails } = await send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (exceptionDetails) {
          throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || "erro no evaluate");
        }
        return result.value;
      },
    };
  }

  async targets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos;
  }

  async waitForTarget(predicate, timeoutMs = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = (await this.targets()).find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("alvo do CDP não apareceu a tempo");
  }

  /** Abre uma aba e espera o carregamento. Devolve a sessão já anexada. */
  async openPage(url, { width = 1280, height = 900, waitMs = 0, colorScheme = "light" } = {}) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const page = await this.session(targetId);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }] });
    await navigate(page, url);
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    return page;
  }
}

export async function navigate(page, url, timeoutMs = 30_000) {
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const poll = async () => {
      try {
        const state = await page.evaluate("document.readyState");
        if (state === "complete" && (await page.evaluate("location.href")) !== "about:blank") {
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch (_) {
        /* página trocando de documento */
      }
      setTimeout(poll, 200);
    };
    setTimeout(poll, 300);
  });
  await page.send("Page.navigate", { url });
  await loaded;
}

export async function screenshot(page, path, { clip } = {}) {
  const { writeFileSync } = await import("node:fs");
  await page.send("Page.bringToFront");
  await new Promise((r) => setTimeout(r, 250));
  const params = { format: "png", captureBeyondViewport: false };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await page.send("Page.captureScreenshot", params);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

export async function loadExtension(browser, path) {
  const { id } = await browser.send("Extensions.loadUnpacked", { path });
  return id;
}
