import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://vigil:vigil@localhost:5432/vigil";

async function main() {
  const sql = postgres(url, { max: 1 });
  console.log("Applying SQL migrations...");

  await sql`
    CREATE TABLE IF NOT EXISTS vigil_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz DEFAULT now() NOT NULL
    )
  `;

  const dir = join(process.cwd(), "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const already = await sql`SELECT 1 FROM vigil_migrations WHERE id = ${file}`;
    if (already.length) {
      console.log(`skip ${file}`);
      continue;
    }
    const body = readFileSync(join(dir, file), "utf8");
    await sql.unsafe(body);
    await sql`INSERT INTO vigil_migrations (id) VALUES (${file})`;
    console.log(`applied ${file}`);
  }

  const views = readFileSync(join(process.cwd(), "sql/analytics_views.sql"), "utf8");
  await sql.unsafe(views);
  console.log("applied analytics views");

  await sql.end({ timeout: 5 });
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
