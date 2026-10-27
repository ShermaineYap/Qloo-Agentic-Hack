// Pre-run the demo tours against live Qloo and save them, so judges get
// instant, quota-free results. Run after `qloo setup --qloo` or with
// QLOO_API_KEY set:   npm run warm            (all presets)
//                     npm run warm -- comedy-us
// Commit data/cache, data/runs and data/featured.json afterwards.
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startQloo } from "../server/qloo.js";
import { planTour } from "../server/pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PRESETS } = await import("../server/presets.js");

const s = await startQloo();
if (s.mode !== "live" && !process.argv.includes("--allow-sample")) {
  console.error(`Qloo is not live (mode: ${s.mode}${s.error ? `, ${s.error}` : ""}). Set QLOO_API_KEY or run \`qloo setup --qloo\` first.`);
  process.exit(1);
}
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const featuredFile = path.join(ROOT, "data", "featured.json");
const featured = existsSync(featuredFile) ? JSON.parse(await readFile(featuredFile, "utf8")) : [];

for (const p of PRESETS.filter((p) => !only.length || only.includes(p.id))) {
  console.log(`\n▶ ${p.label}: ${p.act}`);
  try {
    const tour = await planTour(p, (e) => {
      if (e.type === "step" && e.status !== "running") console.log(`  ${e.status.padEnd(11)} ${e.tool}  ${e.label}`);
      if (e.type === "error") console.log("  ERROR", e.message);
    });
    const entry = { preset: p.id, id: tour.id, act: tour.act.name, region: tour.region.label, stops: tour.route.length, mock: tour.mock };
    const i = featured.findIndex((f) => f.preset === p.id);
    if (i >= 0) featured[i] = entry;
    else featured.push(entry);
    console.log(`  ✓ saved /tour/${tour.id} (${tour.calls} Qloo calls)`);
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
  }
}
await writeFile(featuredFile, JSON.stringify(featured, null, 2));
process.exit(0);
