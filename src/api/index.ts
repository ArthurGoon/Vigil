import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Vigil listening on http://localhost:${info.port}`);
  console.log(`  UI  → http://localhost:${info.port}/`);
  console.log(`  API → http://localhost:${info.port}/health`);
});
