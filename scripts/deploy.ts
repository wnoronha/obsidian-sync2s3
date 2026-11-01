import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

// Comma-separated plugin folders, one per vault under test.
// Set SYNC2S3_DEPLOY_TARGETS in the local shell. Never commit real paths.
const raw = process.env["SYNC2S3_DEPLOY_TARGETS"] ?? "";
const targets = raw
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
if (targets.length === 0) {
  throw new Error("Set SYNC2S3_DEPLOY_TARGETS to comma-separated plugin folders, e.g. /path/to/vault/.obsidian/plugins/sync2s3");
}
for (const f of ["manifest.json", "main.js", "styles.css"]) {
  if (!existsSync(`./${f}`)) throw new Error(`missing build output ./${f}; run bun run build first`);
}
for (const target of targets) {
  await mkdir(target, { recursive: true });
  for (const f of ["manifest.json", "main.js", "styles.css"]) {
    await cp(`./${f}`, `${target}/${f}`);
    console.log(`deployed ${f} -> ${target}/${f}`);
  }
  if (existsSync("./main.js.map")) await cp("./main.js.map", `${target}/main.js.map`);
}
