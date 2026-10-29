// Sanity check: is the key live, and does Qloo have heat data for the demo
// acts? Spends about 2 Qloo calls per act.
//   npm run check
//   npm run check -- "Another Comedian" us person
import { startQloo, callQloo, regionHeatmap } from "../server/qloo.js";
import { REGIONS } from "../server/cities.js";
const { PRESETS } = await import("../server/presets.js");

const s = await startQloo();
console.log(`Qloo mode: ${s.mode}${s.error ? ` (${s.error})` : ""}`);
if (s.mode !== "live") process.exit(1);

const [act, region, actType] = process.argv.slice(2);
const list = act ? [{ act, region: region || "us", actType }] : PRESETS;
for (const p of list) {
  const d = await callQloo("qloo_describe", { entity: p.act, ...(p.actType ? { type: p.actType } : {}) });
  const env = d.envelope;
  if (env.status === "needs_input") {
    const c = env.resolution?.issues?.[0]?.candidates || [];
    console.log(`\n${p.act}: ambiguous, add a type. Candidates: ${c.map((x) => `${x.name} (${x.type}, popularity ${x.popularity?.toFixed?.(2)})`).join("; ")}`);
    continue;
  }
  const e = env.results?.[0];
  console.log(`\n${p.act}: ${env.status} → ${e ? `${e.name} (${e.subtype || e.type})` : env.summary}`);
  if (!e) continue;
  const h = await regionHeatmap(e.entity_id, REGIONS[p.region].wkt);
  console.log(`  heatmap across ${REGIONS[p.region].label}: ${h.status}, ${h.points?.length ?? 0} grid cells`);
}
process.exit(0);
