// The TourSmith run: from one act name to a routed, packaged tour.
//
// Each phase is a Qloo question the LLM alone cannot answer:
//   1. Who is this act?            qloo_describe (+ ambiguity handling)
//   2. Who are their fans?         qloo_entity_tags, qloo_audience_demographics, qloo_trends
//   3. Where are their fans?       qloo_where_popular (region heat + one call per candidate city)
//   4. Which cities make the cut?  agent decision over the evidence
//   5. What does each stop need?   qloo_recommend x4 per city (openers, venues/food, brands, podcasts)
//   6. Who opens where?            qloo_rank per city over one shortlist
//   7. Why that opener?            qloo_compare_audiences (shared taste between fan bases)
//   8. How do we sell each night?  agent writes city copy using only Qloo-verified references
//
// Every step is streamed to the UI as an event so the judges can watch the
// agent work and see which Qloo call backs which decision.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callQloo, candidatesOf, entityTypeShort } from "./qloo.js";
import { REGIONS, orderRoute } from "./cities.js";
import { completeJSON, complete, hasLLM, llmInfo } from "./llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNS_DIR = process.env.RUNS_DIR || path.join(ROOT, "data", "runs");
const INSIGHTS_TYPES = new Set(["artist", "book", "brand", "movie", "person", "place", "podcast", "tv_show", "videogame"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const round = (v, d = 3) => (v === undefined ? undefined : Number(v.toFixed(d)));

export async function planTour(input, emit) {
  const region = REGIONS[input.region] || REGIONS.us;
  const stopsWanted = Math.max(3, Math.min(Number(input.stops) || 5, 8));
  const candidateCities = region.cities.slice(0, Math.max(stopsWanted + 2, Math.min(Number(input.candidates) || 10, region.cities.length)));
  const tour = {
    id: randomBytes(5).toString("hex"),
    created_at: new Date().toISOString(),
    input: { ...input, region: input.region || "us", stops: stopsWanted },
    region: { id: input.region || "us", label: region.label, center: region.center, zoom: region.zoom },
    llm: llmInfo(),
    mock: false,
    steps: [],
    calls: 0,
  };

  let stepNo = 0;
  // Run one Qloo call as a visible agent step.
  async function q(phase, label, tool, args) {
    const id = `s${++stepNo}`;
    emit({ type: "step", id, phase, label, tool, args, status: "running" });
    const { envelope, cached, mock, ms } = await callQloo(tool, args);
    tour.calls++;
    if (mock) tour.mock = true;
    const step = {
      id, phase, label, tool, args,
      status: envelope.status,
      summary: envelope.summary || `${envelope.result_count ?? (envelope.results?.length ?? 0)} results`,
      result_count: envelope.result_count ?? (Array.isArray(envelope.results) ? envelope.results.length : undefined),
      cached, mock, ms,
      request: envelope.provenance?.requests?.[0]?.query,
    };
    tour.steps.push(step);
    emit({ type: "step", ...step, status: envelope.status === "ok" ? "done" : envelope.status });
    return envelope;
  }
  function think(phase, text) {
    const id = `s${++stepNo}`;
    const step = { id, phase, label: text, tool: "agent", status: "done" };
    tour.steps.push(step);
    emit({ type: "step", ...step });
  }

  emit({ type: "start", id: tour.id, region: tour.region, llm: tour.llm, stops: stopsWanted, candidates: candidateCities.map((c) => ({ name: c.name, lat: c.lat, lng: c.lng })) });

  // ---- 1. Resolve the act -------------------------------------------------
  let described = await q("act", `Find "${input.act}" in Qloo's taste graph`, "qloo_describe", { entity: input.act, ...(input.actType ? { type: input.actType } : {}) });
  if (described.status === "needs_input") {
    const cands = candidatesOf(described);
    const pick = await chooseCandidate(input.act, cands, input.notes);
    if (!pick) throw new UserError(`Qloo found several matches for "${input.act}" and none was clearly right. Try the full name.`);
    think("act", `Ambiguous name. Picked "${pick.name}"${pick.reason ? `: ${pick.reason}` : ""}`);
    described = await q("act", `Load "${pick.name}"`, "qloo_describe", { entity: pick.id || pick.entity_id || pick.name });
  }
  const actEntity = Array.isArray(described.results) ? described.results[0] : undefined;
  if (!actEntity || described.status === "error") {
    throw new UserError(described.error?.recovery || described.summary || `Could not find "${input.act}" in Qloo.`);
  }
  const actKind = entityTypeShort(actEntity.type) || input.actType || "artist";
  const act = {
    id: actEntity.entity_id,
    name: actEntity.name,
    kind: actKind,
    popularity: actEntity.popularity,
    description: actEntity.properties?.short_description || actEntity.properties?.description,
    image: actEntity.properties?.image?.url || (typeof actEntity.properties?.image === "string" ? actEntity.properties.image : undefined),
  };
  const actRef = act.id || act.name;
  const peerType = ["artist", "person", "podcast"].includes(actKind) ? actKind : "artist";
  tour.act = act;
  emit({ type: "act", act });

  // ---- 2. Audience profile -----------------------------------------------
  const end = new Date();
  const start = new Date(end.getTime() - 140 * 864e5);
  const [tagsEnv, demoEnv, trendEnv] = await Promise.all([
    q("audience", "What concepts define this act's fan base?", "qloo_entity_tags", { entities: [actRef], limit: 12 }),
    q("audience", "Who are the fans? (age and gender skew)", "qloo_audience_demographics", { entity: actRef }),
    INSIGHTS_TYPES.has(actKind)
      ? q("audience", "Is the act rising or fading?", "qloo_trends", { entities: [actRef], entity_type: actKind, start_date: iso(start), end_date: iso(end), limit: 20 })
      : Promise.resolve(null),
  ]);
  const tags = (Array.isArray(tagsEnv.results) ? tagsEnv.results : []).map((t) => ({ id: t.id, name: t.name, affinity: num(t.affinity) })).filter((t) => t.name);
  const demoRow = (Array.isArray(demoEnv.results) ? demoEnv.results : []).find((r) => r.entity_id === act.id) || (demoEnv.results || [])[0];
  const demographics = demoRow?.query ? { age: demoRow.query.age || {}, gender: demoRow.query.gender || {} } : null;
  const trendPoints = (trendEnv?.series?.[0]?.points || [])
    .map((p) => ({ date: p.date, percentile: num(p.population_percentile), fold: num(p.velocity_fold_change) }))
    .filter((p) => p.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  tour.profile = { tags, demographics, trend: trendPoints, momentum: momentum(trendPoints) };
  emit({ type: "profile", profile: tour.profile });

  // ---- 3. Where are the fans? --------------------------------------------
  const heatEnv = await q("route", `Heatmap: where in ${region.label} does this act over-index?`, "qloo_where_popular", { entity: actRef, within: region.within, limit: 20 });
  tour.heat = heatPoints(heatEnv);
  emit({ type: "heat", points: tour.heat });

  const scored = await Promise.all(
    candidateCities.map(async (city) => {
      const env = await q("route", `Score ${city.name}`, "qloo_where_popular", { entity: actRef, within: city.query, limit: 10 });
      const s = scoreCity(env);
      const result = { ...city, ...s };
      emit({ type: "city", city: result });
      return result;
    }),
  );
  tour.cities = scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  // ---- 4. Route decision ---------------------------------------------------
  const decision = await decideRoute({ act, profile: tour.profile, cities: tour.cities, stopsWanted, input });
  think("route", decision.rationale);
  const keepSet = new Set(decision.keep);
  const chosen = orderRoute(tour.cities.filter((c) => keepSet.has(c.name)));
  tour.route = chosen.map((c) => ({ name: c.name, query: c.query, lat: c.lat, lng: c.lng, score: c.score, affinity: c.affinity, popularity: c.popularity, why: decision.why?.[c.name] }));
  tour.dropped = decision.dropped;
  tour.rationale = decision.rationale;
  emit({ type: "route", route: tour.route, dropped: tour.dropped, rationale: tour.rationale });

  // ---- 5. Package each stop ------------------------------------------------
  const peerLabel = peerType === "person" ? "comedians/personalities" : peerType === "podcast" ? "podcasts" : "artists";
  tour.stops = await Promise.all(
    tour.route.map(async (stop) => {
      const [peersEnv, placesEnv, brandsEnv, podsEnv] = await Promise.all([
        q("stops", `${stop.name}: local ${peerLabel} these fans also love (opener candidates)`, "qloo_recommend", { target_type: peerType, signals: [actRef], signal_location: stop.query, limit: 8 }),
        q("stops", `${stop.name}: venues, bars and restaurants with high fan affinity`, "qloo_recommend", { target_type: "place", signals: [actRef], filter_location: stop.query, limit: 6 }),
        q("stops", `${stop.name}: brands this audience over-indexes on (sponsors)`, "qloo_recommend", { target_type: "brand", signals: [actRef], signal_location: stop.query, limit: 5 }),
        q("stops", `${stop.name}: podcasts for local PR`, "qloo_recommend", { target_type: "podcast", signals: [actRef], signal_location: stop.query, limit: 4 }),
      ]);
      const pkg = {
        ...stop,
        peers: entities(peersEnv).filter((e) => e.id !== act.id && e.name !== act.name),
        places: entities(placesEnv),
        brands: entities(brandsEnv),
        podcasts: entities(podsEnv),
      };
      emit({ type: "stop", stop: pkg });
      return pkg;
    }),
  );

  // ---- 6. Opener shortlist ranked per city ---------------------------------
  const tally = new Map();
  for (const s of tour.stops)
    s.peers.forEach((p, i) => {
      const t = tally.get(p.id || p.name) || { ...p, hits: 0, best: Infinity };
      t.hits++;
      t.best = Math.min(t.best, i);
      tally.set(p.id || p.name, t);
    });
  const userOpeners = (input.openers || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
  const auto = [...tally.values()].sort((a, b) => b.hits - a.hits || a.best - b.best).slice(0, 8 - userOpeners.length);
  const shortlist = [...userOpeners.map((name) => ({ name, ref: name, user: true })), ...auto.map((a) => ({ name: a.name, ref: a.id || a.name, user: false }))];
  const perCity = {};
  if (shortlist.length >= 2) {
    await Promise.all(
      tour.stops.map(async (s) => {
        const env = await q("openers", `${s.name}: rank the opener shortlist for this crowd`, "qloo_rank", {
          options: shortlist.map((o) => o.ref),
          option_type: peerType,
          signals: [actRef],
          signal_location: s.query,
        });
        if (env.status === "needs_input") {
          // A user-typed opener didn't resolve; rank the rest.
          const ok = shortlist.filter((o) => !o.user);
          const retry = ok.length >= 2 ? await q("openers", `${s.name}: re-rank without unresolved names`, "qloo_rank", { options: ok.map((o) => o.ref), option_type: peerType, signals: [actRef], signal_location: s.query }) : null;
          perCity[s.name] = retry ? entities(retry) : [];
        } else perCity[s.name] = entities(env);
        s.opener = perCity[s.name][0] || s.peers[0] || null;
      }),
    );
  } else tour.stops.forEach((s) => (s.opener = s.peers[0] || null));
  // Overall pick: best average rank position across cities (scores from separate calls are not comparable).
  const positions = new Map();
  Object.values(perCity).forEach((list) =>
    list.forEach((e, i) => {
      const k = e.id || e.name;
      const p = positions.get(k) || { ...e, sum: 0, n: 0, firsts: 0 };
      p.sum += i + 1;
      p.n++;
      if (i === 0) p.firsts++;
      positions.set(k, p);
    }),
  );
  const board = [...positions.values()]
    .map((p) => ({ id: p.id, name: p.name, avg_rank: round(p.sum / p.n, 2), first_in: p.firsts, cities: p.n, user: shortlist.find((o) => o.ref === p.id || o.name === p.name)?.user || false }))
    .sort((a, b) => a.avg_rank - b.avg_rank);
  tour.openers = { shortlist: shortlist.map((o) => o.name), board, perCity: Object.fromEntries(Object.entries(perCity).map(([k, v]) => [k, v.map((e) => e.name)])) };
  emit({ type: "openers", openers: tour.openers, stops: tour.stops.map((s) => ({ name: s.name, opener: s.opener })) });

  // ---- 7. Why the top opener works -----------------------------------------
  const top = board[0];
  if (top?.id || top?.name) {
    const cmp = await q("openers", `Shared taste: ${act.name} fans vs ${top.name} fans`, "qloo_compare_audiences", { group_a: [actRef], group_b: [top.id || top.name], limit: 8 });
    const sharedTags = (cmp.results?.tags || []).map((t) => ({ name: t.name, score: num(t.query?.score) ?? num(t.score) })).filter((t) => t.name);
    tour.compare = { with: top.name, shared: sharedTags };
    emit({ type: "compare", compare: tour.compare });
  }

  // ---- 8. City-specific marketing copy -------------------------------------
  tour.copy = await writeCopy(tour);
  emit({ type: "copy", copy: tour.copy });

  tour.brief = await writeBrief(tour);
  emit({ type: "brief", brief: tour.brief });

  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(path.join(RUNS_DIR, `${tour.id}.json`), JSON.stringify(tour, null, 1));
  emit({ type: "done", id: tour.id, calls: tour.calls, mock: tour.mock });
  return tour;
}

export class UserError extends Error {}

// ---------------------------------------------------------------------------

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function entities(env) {
  if (!env || !Array.isArray(env.results)) return [];
  return env.results
    .filter((e) => e && e.name)
    .map((e) => ({
      id: e.entity_id,
      name: e.name,
      affinity: round(num(e.affinity)),
      popularity: round(num(e.popularity)),
      address: e.properties?.address,
      image: e.properties?.image?.url,
      description: e.properties?.short_description,
    }));
}

function heatPoints(env) {
  if (!env || !Array.isArray(env.results)) return [];
  return env.results
    .map((p) => ({
      lat: num(p.location?.latitude) ?? num(p.latitude),
      lng: num(p.location?.longitude) ?? num(p.longitude),
      affinity: num(p.query?.affinity) ?? num(p.affinity),
      popularity: num(p.query?.popularity) ?? num(p.popularity),
    }))
    .filter((p) => p.lat !== undefined && p.lng !== undefined);
}

// Qloo heatmap `affinity` compares this act to everything else people in that
// place engage with, so it is comparable across cities; `popularity` is the
// act's signal density there. Score = 75% affinity (top cells) + 25% popularity.
export function scoreCity(env) {
  const pts = heatPoints(env);
  if (env.status !== "ok" || pts.length === 0)
    return { score: null, affinity: null, popularity: null, cells: 0, note: env.status === "error" ? env.summary : "Not enough Qloo signal here" };
  const affs = pts.map((p) => p.affinity).filter((v) => v !== undefined).sort((a, b) => b - a).slice(0, 5);
  const pops = pts.map((p) => p.popularity).filter((v) => v !== undefined);
  const affinity = mean(affs) ?? 0;
  const popularity = mean(pops) ?? 0;
  return { score: Math.round(100 * (0.75 * affinity + 0.25 * popularity)), affinity: round(affinity), popularity: round(popularity), cells: pts.length };
}

function momentum(points) {
  const ps = points.filter((p) => p.percentile !== undefined);
  if (ps.length < 4) return null;
  const half = Math.floor(ps.length / 2);
  const a = mean(ps.slice(0, half).map((p) => p.percentile));
  const b = mean(ps.slice(half).map((p) => p.percentile));
  const delta = round(b - a, 1);
  return { delta, label: delta > 1.5 ? "rising" : delta < -1.5 ? "cooling" : "steady" };
}

async function chooseCandidate(query, cands, notes) {
  if (!cands.length) return null;
  if (hasLLM()) {
    try {
      const out = await completeJSON({
        system: "You resolve ambiguous entity names for a live-entertainment touring tool. Reply with JSON only.",
        prompt: `The user typed "${query}"${notes ? ` (context: ${notes})` : ""}. Qloo returned these candidates:\n${JSON.stringify(cands.slice(0, 8))}\nPick the one a touring performer most likely means. Reply {"index": <number>, "reason": "<short>"}.`,
        maxTokens: 200,
      });
      const c = cands[out.index];
      if (c) return { ...c, reason: out.reason };
    } catch {}
  }
  return { ...cands[0], reason: "highest-scoring match" };
}

async function decideRoute({ act, profile, cities, stopsWanted, input }) {
  const viable = cities.filter((c) => c.score !== null);
  const fallback = () => {
    const keep = viable.slice(0, stopsWanted).map((c) => c.name);
    const cutoff = viable[stopsWanted - 1]?.score;
    const dropped = cities
      .filter((c) => !keep.includes(c.name))
      .map((c) => ({ city: c.name, score: c.score, reason: c.score === null ? "Qloo has too little signal for this act here" : `Fan affinity score ${c.score} is below the cut-off of ${cutoff}` }));
    return {
      keep,
      dropped,
      why: Object.fromEntries(viable.slice(0, stopsWanted).map((c) => [c.name, `Affinity ${c.affinity} across ${c.cells} map cells, popularity ${c.popularity}`])),
      rationale: `Kept the ${keep.length} markets where ${act.name}'s fans over-index most; dropped ${dropped.length}.`,
    };
  };
  if (!hasLLM() || viable.length <= stopsWanted) return fallback();
  try {
    const out = await completeJSON({
      system:
        "You are a veteran tour routing agent at a major promoter. You decide which markets a performer should play, using only the Qloo evidence supplied. Be concrete and brief. Reply with JSON only.",
      prompt: `Act: ${act.name} (${act.kind}). Audience momentum: ${profile.momentum?.label ?? "unknown"}. Top fan-base concepts: ${profile.tags.slice(0, 6).map((t) => t.name).join(", ") || "n/a"}.
User constraints: ${input.notes || "none"}${input.month ? `; touring in ${input.month}` : ""}.
Candidate markets with Qloo heatmap evidence (score 0-100 = 75% affinity + 25% popularity; affinity compares the act to everything else people there engage with):
${JSON.stringify(cities.map((c) => ({ city: c.name, score: c.score, affinity: c.affinity, popularity: c.popularity, cells: c.cells, note: c.note })))}
Choose exactly ${stopsWanted} cities. Usually follow the scores, but you may swap a borderline city for geographic routing sense or the user's constraints; say so.
Reply: {"keep": [city names], "why": {"<city>": "<one line, cite the numbers>"}, "dropped": [{"city": "...", "reason": "<one line, cite the numbers>"}], "rationale": "<two sentences>"}`,
      maxTokens: 1200,
    });
    const names = new Set(cities.map((c) => c.name));
    const keep = (out.keep || []).filter((n) => names.has(n)).slice(0, stopsWanted);
    if (keep.length < Math.min(3, stopsWanted)) return fallback();
    const dropped = cities
      .filter((c) => !keep.includes(c.name))
      .map((c) => ({ city: c.name, score: c.score, reason: (out.dropped || []).find((d) => d.city === c.name)?.reason || "Lower fan affinity than the kept markets" }));
    return { keep, why: out.why || {}, dropped, rationale: out.rationale || fallback().rationale };
  } catch {
    return fallback();
  }
}

async function writeCopy(tour) {
  const stops = tour.stops.map((s) => ({
    city: s.name,
    opener: s.opener?.name,
    places: s.places.slice(0, 4).map((p) => p.name),
    brands: s.brands.slice(0, 3).map((b) => b.name),
    podcasts: s.podcasts.slice(0, 2).map((p) => p.name),
  }));
  const fallback = () => ({
    source: "template",
    stops: stops.map((s) => ({
      city: s.city,
      generic: `${tour.act.name} live in ${s.city}! Get your tickets now.`,
      hook: `${s.city}, ${tour.act.name} is coming${s.opener ? ` with ${s.opener} opening` : ""}.${s.places[0] ? ` Pre-show at ${s.places[0]}.` : ""}`,
      caption: `${tour.act.name} × ${s.city}${s.brands[0] ? ` · presented with ${s.brands[0]}` : ""}`,
      references: [s.opener, s.places[0], s.brands[0]].filter(Boolean),
    })),
  });
  if (!hasLLM()) return fallback();
  try {
    const out = await completeJSON({
      system:
        "You write tour marketing for live performers. You may only reference names that appear in the supplied Qloo evidence for that city; never invent venues, brands or people. Reply with JSON only.",
      prompt: `Act: ${tour.act.name}. Fan-base concepts from Qloo: ${tour.profile.tags.slice(0, 8).map((t) => t.name).join(", ")}.
For each city write:
- "generic": the bland ad copy an LLM writes with no data (one line, no local references).
- "hook": a punchy local promo line (max 25 words) that weaves in 1-2 references from that city's evidence.
- "caption": a social caption (max 20 words).
- "references": the exact evidence names you used.
Evidence per city: ${JSON.stringify(stops)}
Reply: {"stops": [{"city","generic","hook","caption","references"}]}`,
      maxTokens: 2500,
    });
    const allowed = new Map(stops.map((s) => [s.city, new Set([s.opener, ...s.places, ...s.brands, ...s.podcasts].filter(Boolean))]));
    // Guardrail: keep only references that really came from Qloo for that city.
    const cleaned = (out.stops || []).map((s) => ({ ...s, references: (s.references || []).filter((r) => allowed.get(s.city)?.has(r)) }));
    return { source: "llm", stops: cleaned.length ? cleaned : fallback().stops };
  } catch {
    return fallback();
  }
}

async function writeBrief(tour) {
  const facts = {
    act: tour.act.name,
    momentum: tour.profile.momentum,
    route: tour.route.map((r) => `${r.name} (${r.score})`),
    dropped: tour.dropped.slice(0, 4).map((d) => d.city),
    top_opener: tour.openers.board[0]?.name,
    shared_taste: tour.compare?.shared?.slice(0, 4).map((t) => t.name),
  };
  if (!hasLLM())
    return `${facts.act}: ${facts.route.length}-city run through ${facts.route.map((r) => r.split(" (")[0]).join(", ")}. ${facts.top_opener ? `${facts.top_opener} is the strongest opener across the route.` : ""} Audience momentum is ${facts.momentum?.label ?? "not measured"}.`;
  try {
    return (
      await complete({
        system: "You are a tour manager writing a 3-sentence executive summary for a promoter. Plain, specific, cite the scores. No hype.",
        prompt: JSON.stringify(facts),
        maxTokens: 300,
      })
    ).trim();
  } catch {
    return `${facts.act}: ${facts.route.join(", ")}.`;
  }
}
