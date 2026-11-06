import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { PORT, databasePath } from "./config.js";
import { Store } from "./db/store.js";
import { Checker } from "./domain/check.js";
import { PageCache } from "./domain/probe.js";
import { Scheduler } from "./scheduler.js";

const dbPath = databasePath();
const store = new Store(dbPath);
const checker = new Checker(store);
const scheduler = new Scheduler(store, checker);
const app = createApp({ store, checker, pages: new PageCache() });

// 127.0.0.1 only: there is no login, so the API must not be reachable from the network.
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  const count = store.listWatches().length;
  console.log(`\n  Vigil rodando em http://localhost:${info.port}`);
  console.log(`  banco: ${dbPath} (${count} ${count === 1 ? "alerta" : "alertas"})`);
  console.log("  Ctrl+C para parar\n");
  scheduler.start();
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  A porta ${PORT} já está em uso. Outro Vigil aberto? Ou rode com PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("\n  Parando: esperando os checks em andamento...");
  server.close();
  await scheduler.stop();
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
