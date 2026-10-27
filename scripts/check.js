// First-hour sanity check: is the key live, and does Qloo have enough data on
// the demo acts and cities? Spends roughly 2 Qloo calls per preset.
//   npm run check
//   npm run check -- "Another Comedian" us
import { startQloo, callQloo } from "../server/qloo.js";
import { REGIONS } from "../server/cities.js";
const { PRESETS } = await import("../server/presets.js");

const s = await startQloo();
console.log(`Qloo mode: ${s.mode}${s.error ? ` (${s.error})` : ""}`);
if (s.mode !== "live") process.exit(1);

const [act, region] = process.argv.slice(2);
const list = act ? [{ act, region: region || "us" }] : PRESETS;
for (const p of list) {
  const d = await callQloo("qloo_describe", { entity: p.act });
  const e = d.envelope.results?.[0];
  console.log(`\n${p.act}: ${d.envelope.status} → ${e ? `${e.name} (${e.type}, popularity ${e.popularity})` : d.envelope.summary}`);
  if (!e) continue;
  const city = REGIONS[p.region].cities[0];
  const w = await callQloo("qloo_where_popular", { entity: e.entity_id, within: city.query, limit: 10 });
  console.log(`  heatmap in ${city.name}: ${w.envelope.status}, ${w.envelope.result_count ?? 0} cells`);
}
process.exit(0);
