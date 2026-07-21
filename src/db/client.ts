import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgres://vigil:vigil@localhost:5432/vigil";

const client = postgres(url, { max: 10 });
export const db = drizzle(client, { schema });
export { client as sql };
