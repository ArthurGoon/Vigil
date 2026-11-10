// Roda `node --check` em todos os .js/.mjs do projeto (sem build, então é o nosso "lint" mínimo).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const IGNORE = new Set([".git", "node_modules", "results", "data", "dist"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORE.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(m?js)$/.test(entry.name) ? [path] : [];
  });
}

let failed = 0;
const files = walk(".");
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${file}\n${result.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} arquivos sem erro de sintaxe.`);
process.exit(failed ? 1 : 0);
