// Sample data for local development before a Qloo key arrives.
//
// Every envelope is marked `mock: true` and every name is obviously synthetic
// ("Sample opener 3"), so nothing here can be mistaken for real Qloo output.
// The UI shows a banner whenever a run used sample data. Shapes follow the
// harness result envelopes and the documented raw API fields.

import { REGIONS } from "./cities.js";

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rand(seed) {
  let s = hash(seed) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

const ALL_CITIES = Object.values(REGIONS).flatMap((r) => r.cities);
function findCity(q) {
  const s = String(q || "").toLowerCase();
  return ALL_CITIES.find((c) => c.query.toLowerCase() === s || c.name.toLowerCase() === s);
}

function env(operation, extra) {
  return {
    schema_version: "1.0-preview.1",
    operation,
    status: "ok",
    mock: true,
    summary: "Sample data (mock mode). Connect a Qloo key for live results.",
    ...extra,
  };
}

const TAGS = [
  "Observational humor", "Storytelling", "Clean comedy", "Indie pop", "Singer-songwriter",
  "Late-night TV", "Southern charm", "Family friendly", "Feel-good", "Acoustic",
  "Podcast culture", "Nostalgic", "Craft beer", "Comfort food", "Live music venues",
];

const NAMES = new Map(); // mock id -> name, so rank can echo names back
function mockEntity(name, type, r) {
  const resolved = NAMES.get(name) || name;
  const id = name.startsWith("mock-") ? name : `mock-${hash(name + type).toString(16)}`;
  NAMES.set(id, resolved);
  return {
    entity_id: id,
    name: resolved,
    type: `urn:entity:${type}`,
    popularity: Number((0.5 + r() * 0.5).toFixed(3)),
    affinity: Number((0.6 + r() * 0.4).toFixed(3)),
  };
}

export function mockCall(name, args = {}) {
  const r = rand(name + JSON.stringify(args));
  switch (name) {
    case "qloo_describe": {
      const type = args.type || "artist";
      return env("describe", {
        interpretation: { entity: { input: args.entity, name: args.entity, match: "mock" } },
        results: [
          {
            ...mockEntity(args.entity, type, r),
            properties: { short_description: "Sample entity for local development (mock mode)." },
          },
        ],
        result_count: 1,
      });
    }
    case "qloo_where_popular": {
      const city = findCity(args.within);
      const base = city || { lat: 0, lng: 0 };
      const strength = 0.55 + r() * 0.45;
      const n = Math.min(args.limit ?? 10, 10);
      const results = Array.from({ length: n }, () => ({
        location: {
          latitude: base.lat + (r() - 0.5) * (city ? 0.3 : 20),
          longitude: base.lng + (r() - 0.5) * (city ? 0.3 : 30),
          geohash: "mock",
        },
        query: {
          affinity: Math.min(1, strength + (r() - 0.5) * 0.1),
          affinity_rank: r(),
          popularity: 0.3 + r() * 0.7,
        },
      })).sort((a, b) => b.query.affinity - a.query.affinity);
      return env("where_popular", { interpretation: { within: args.within }, results, result_count: results.length });
    }
    case "qloo_recommend": {
      const t = args.target_type;
      const loc = args.filter_location || args.signal_location || "";
      const label = { artist: "Sample artist", person: "Sample comedian", place: "Sample venue/restaurant", brand: "Sample brand", podcast: "Sample podcast", tv_show: "Sample TV show", movie: "Sample film", book: "Sample book", videogame: "Sample game" }[t] || "Sample entity";
      const n = args.limit ?? 10;
      const results = Array.from({ length: n }, (_, i) => mockEntity(`${label} ${String.fromCharCode(65 + ((hash(loc) + i) % 26))}${i + 1}${loc ? ` (${loc.split(",")[0]})` : ""}`, t, r))
        .sort((a, b) => b.affinity - a.affinity);
      return env("recommend", { interpretation: { target_type: `urn:entity:${t}`, signal_location: args.signal_location, filter_location: args.filter_location }, results, result_count: n });
    }
    case "qloo_rank": {
      const results = (args.options || []).map((o) => mockEntity(o, args.option_type, r)).sort((a, b) => b.affinity - a.affinity);
      return env("rank", { results, result_count: results.length });
    }
    case "qloo_entity_tags": {
      const results = TAGS.map((t) => ({ id: `urn:tag:mock:${t.toLowerCase().replace(/\W+/g, "_")}`, name: t, type: "urn:tag:mock", affinity: r() }))
        .sort((a, b) => b.affinity - a.affinity)
        .slice(0, args.limit ?? 10);
      return env("entity_tags", { results, result_count: results.length });
    }
    case "qloo_audience_demographics": {
      const ages = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];
      const m = Number((r() * 0.6 - 0.3).toFixed(2));
      return env("audience_demographics", {
        results: [{ entity_id: "mock", query: { age: Object.fromEntries(ages.map((a) => [a, Number((r() * 1.2 - 0.5).toFixed(2))])), gender: { male: m, female: -m } } }],
        result_count: 1,
      });
    }
    case "qloo_trends": {
      const points = Array.from({ length: 12 }, (_, i) => ({
        date: new Date(Date.now() - i * 7 * 864e5).toISOString().slice(0, 10),
        population_percentile: Number((70 + r() * 25).toFixed(1)),
        velocity_fold_change: Number((0.9 + r() * 0.3).toFixed(2)),
      }));
      return env("trends", { series: (args.entities || []).map((e) => ({ entity: { name: e }, points })), result_count: 1 });
    }
    case "qloo_compare_audiences": {
      const tags = TAGS.slice(0, 8).map((t) => ({ tag_id: `urn:tag:mock:${t}`, name: t, popularity: r(), query: { score: Number(r().toFixed(3)) } }))
        .sort((a, b) => b.query.score - a.query.score);
      return env("compare_audiences", { results: { tags } });
    }
    case "qloo_find_tags": {
      const results = TAGS.filter((t) => r() > 0.5).slice(0, 5).map((t) => ({ id: `urn:tag:mock:${t}`, name: t }));
      return env("find_tags", { results, result_count: results.length });
    }
    case "region_heatmap": {
      // A coarse grid around every known city, with seeded affinities.
      const points = [];
      for (const c of ALL_CITIES) {
        const base = 0.4 + r() * 0.6;
        for (let i = 0; i < 12; i++)
          points.push({ lat: c.lat + (r() - 0.5) * 0.8, lng: c.lng + (r() - 0.5) * 0.8, affinity: Math.min(1, base + (r() - 0.5) * 0.15), affinity_rank: r(), popularity: 0.3 + r() * 0.7 });
      }
      return { status: "ok", mock: true, summary: `${points.length} heatmap cells (sample)`, points };
    }
    default:
      return { status: "error", mock: true, summary: `Unknown tool ${name}`, error: { code: "UNKNOWN_TOOL", retryable: false }, results: [] };
  }
}
