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
import { callQloo, candidatesOf, entityTypeShort, regionHeatmap } from "./qloo.js";
import { REGIONS, orderRoute, scoreCities } from "./cities.js";
import { completeJSON, complete, hasLLM, llmInfo } from "./llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLED_RUNS = path.join(ROOT, "data", "runs");
// Serverless file systems are read-only except /tmp.
export const RUNS_DIR = process.env.RUNS_DIR || (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? "/tmp/toursmith/runs" : BUNDLED_RUNS);
const INSIGHTS_TYPES = new Set(["artist", "book", "brand", "movie", "person", "place", "podcast", "tv_show", "videogame"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const round = (v, d = 3) => (v === undefined ? undefined : Number(v.toFixed(d)));

export async function planTour(input, emit) {
  const region = REGIONS[input.region] || REGIONS.us;
  const stopsWanted = Math.max(3, Math.min(Number(input.stops) || 5, 8));
  const candidateCities = region.cities; // all scored from one heatmap call
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
  // Qloo often holds the same name under several types (a comedian can be both
  // a `person` and an `artist`). Resolve once, then use the entity ID everywhere.
  let described = await q("act", `Find "${input.act}" in Qloo's taste graph`, "qloo_describe", { entity: input.act, ...(input.actType ? { type: input.actType } : {}) });
  let picked = null;
  let alternates = [];
  if (described.status === "needs_input") {
    const cands = candidatesOf(described);
    picked = await chooseCandidate(input.act, cands, input.notes);
    if (!picked) throw new UserError(`Qloo found several matches for "${input.act}" and none was clearly right. Try the full name.`);
    alternates = cands.filter((c) => c.id !== picked.id && /person|artist|podcast/.test(String(c.type)));
    think("act", `"${input.act}" matches ${cands.length} Qloo entities. Using the ${entityTypeShort(picked.type) || "best"} entry${picked.description ? ` (${picked.description})` : ""}${picked.reason ? `: ${picked.reason}` : ""}.`);
    described = await loadCandidate(picked);
  }
  if (described.status === "needs_input" && input.actType) {
    // Typed but still ambiguous (two entities share the name and type).
    const cands = candidatesOf(described);
    picked = cands.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
    if (picked) described = await q("act", `Load ${picked.name} by Qloo ID`, "qloo_describe", { entity: picked.id });
  }
  let act = toAct(described, picked);

  async function loadCandidate(c) {
    const t = entityTypeShort(c.type);
    let env = await q("act", `Load ${c.name} as a ${t}`, "qloo_describe", { entity: c.name, ...(t ? { type: t } : {}) });
    if (env.status !== "ok") env = await q("act", `Load ${c.name} by Qloo ID`, "qloo_describe", { entity: c.id });
    return env;
  }
  function toAct(env, c) {
    const e = Array.isArray(env.results) ? env.results[0] : undefined;
    if (!e || env.status === "error") throw new UserError(env.error?.recovery || env.summary || `Could not find "${input.act}" in Qloo.`);
    const kind = entityTypeShort(e.subtype || e.type) || entityTypeShort(c?.type) || input.actType || "artist";
    return {
      id: e.entity_id,
      name: e.name,
      kind,
      popularity: num(e.popularity) ?? num(c?.popularity),
      description: e.properties?.short_description || e.properties?.description || c?.description,
      image: e.properties?.image?.url || (typeof e.properties?.image === "string" ? e.properties.image : undefined),
    };
  }

  // ---- 2. Where are the fans? ----------------------------------------------
  // One Qloo heatmap over the whole region; every city is scored from the
  // same grid, so scores are comparable. If this entry has no heat data, try
  // the other entries Qloo returned for the name.
  let heat = await heatStep(act);
  while (heat.status !== "ok" && alternates.length) {
    const next = alternates.shift();
    think("act", `Qloo has no heatmap for the ${act.kind} entry, so switching to the ${entityTypeShort(next.type)} entry for ${next.name}.`);
    picked = next;
    act = toAct(await loadCandidate(next), next);
    heat = await heatStep(act);
  }
  if (heat.status !== "ok") throw new UserError(`Qloo has no heatmap data for ${act.name} in ${region.label}. Try another region or act.`);

  async function heatStep(a) {
    const id = `s${++stepNo}`;
    const label = `Heatmap of ${a.name}'s fans across ${region.label}`;
    const args = { entity: a.name, boundary: region.label };
    emit({ type: "step", id, phase: "route", label, tool: "qloo heatmap", args, status: "running" });
    const h = await regionHeatmap(a.id, region.wkt);
    tour.calls++;
    if (h.mock) tour.mock = true;
    const step = { id, phase: "route", label, tool: "qloo heatmap", args, status: h.status, summary: h.status === "ok" ? `${h.points.length.toLocaleString("en")} grid cells, each with an affinity and popularity score` : h.summary, cached: h.cached, mock: h.mock, ms: h.ms, request: h.provenance?.query };
    tour.steps.push(step);
    emit({ type: "step", ...step, status: h.status === "ok" ? "done" : h.status });
    return h;
  }

  const actRef = act.id;
  const actKind = act.kind;
  const peerType = ["artist", "person", "podcast"].includes(actKind) ? actKind : "artist";
  tour.act = act;
  emit({ type: "act", act });

  tour.heat = heat.points
    .slice()
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 600)
    .map((p) => ({ lat: round(p.lat, 4), lng: round(p.lng, 4), affinity: round(p.affinity, 4), popularity: round(p.popularity, 3) }));
  emit({ type: "heat", points: tour.heat });
  tour.cities = scoreCities(candidateCities, heat.points).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  tour.cities.forEach((city) => emit({ type: "city", city }));
  const best = tour.cities[0];
  const worst = tour.cities.filter((c) => c.score !== null).at(-1);
  if (best && worst) think("route", `Scored ${tour.cities.length} markets from the grid: ${best.name} leads (${best.score}), ${worst.name} trails (${worst.score}).`);

  // ---- 3. Audience profile -----------------------------------------------
  const end = new Date();
  const start = new Date(end.getTime() - 140 * 864e5);
  const [tagsEnv, demoEnv, trendEnv] = await Promise.all([
    q("audience", "What concepts define this act's fan base?", "qloo_entity_tags", { entities: [actRef], limit: 20 }),
    q("audience", "Who are the fans? (age and gender skew)", "qloo_audience_demographics", { entity: actRef }),
    INSIGHTS_TYPES.has(actKind)
      ? q("audience", "Is the act rising or fading?", "qloo_trends", { entities: [actRef], entity_type: actKind, start_date: iso(start), end_date: iso(end), limit: 20 })
      : Promise.resolve(null),
  ]);
  const tags = fanTags(Array.isArray(tagsEnv.results) ? tagsEnv.results : []);
  const demoRow = (Array.isArray(demoEnv.results) ? demoEnv.results : []).find((r) => r.entity_id === act.id) || (demoEnv.results || [])[0];
  const demographics = demoRow?.query ? { age: demoRow.query.age || {}, gender: demoRow.query.gender || {} } : null;
  let trendPoints = (trendEnv?.series?.[0]?.points || [])
    .map((p) => ({ date: p.date, percentile: num(p.population_percentile), fold: num(p.velocity_fold_change) }))
    .filter((p) => p.date && p.percentile !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
  // The API reports percentiles as 0–1 for some types and 0–100 for others.
  if (trendPoints.length && Math.max(...trendPoints.map((p) => p.percentile)) <= 1) trendPoints = trendPoints.map((p) => ({ ...p, percentile: round(p.percentile * 100, 2) }));
  tour.profile = { tags, demographics, trend: trendPoints, momentum: momentum(trendPoints) };
  emit({ type: "profile", profile: tour.profile });

  // ---- 4. Route decision ---------------------------------------------------
  const decision = await decideRoute({ act, profile: tour.profile, cities: tour.cities, stopsWanted, input });
  think("route", decision.rationale);
  const keepSet = new Set(decision.keep);
  const chosen = orderRoute(tour.cities.filter((c) => keepSet.has(c.name)));
  tour.route = chosen.map((c) => ({ name: c.name, query: c.query, lat: c.lat, lng: c.lng, score: c.score, affinity: c.affinity, popularity: c.popularity, cells: c.cells, why: decision.why?.[c.name] }));
  tour.dropped = decision.dropped;
  tour.rationale = decision.rationale;
  emit({ type: "route", route: tour.route, dropped: tour.dropped, rationale: tour.rationale });

  // ---- 5. Package each stop ------------------------------------------------
  const peerLabel = peerType === "person" ? "comedians" : peerType === "podcast" ? "podcasts" : "artists";
  const roomTag = peerType === "person" ? ["urn:tag:category:place:comedy_club"] : ["urn:tag:category:place:live_music_venue"];
  const roomLabel = peerType === "person" ? "comedy clubs" : "live music venues";
  tour.stops = await Promise.all(
    tour.route.map(async (stop) => {
      const [peersEnv, roomsEnv, placesEnv, brandsEnv, podsEnv] = await Promise.all([
        q("stops", `${stop.name}: ${peerLabel} these fans also love (opener pool)`, "qloo_recommend", { target_type: peerType, signals: [actRef], signal_location: stop.query, limit: 15 }),
        q("stops", `${stop.name}: ${roomLabel} with high fan affinity`, "qloo_recommend", { target_type: "place", signals: [actRef], filter_location: stop.query, include_tags: roomTag, limit: 5 }),
        q("stops", `${stop.name}: bars and restaurants these fans love (pre-show, after-party)`, "qloo_recommend", { target_type: "place", signals: [actRef], filter_location: stop.query, include_tags: ["urn:tag:category:place:bar", "urn:tag:category:place:restaurant"], include_tags_operator: "union", limit: 5 }),
        q("stops", `${stop.name}: brands this audience over-indexes on (sponsors)`, "qloo_recommend", { target_type: "brand", signals: [actRef], signal_location: stop.query, limit: 5 }),
        q("stops", `${stop.name}: podcasts for local PR`, "qloo_recommend", { target_type: "podcast", signals: [actRef], signal_location: stop.query, limit: 4 }),
      ]);
      const pkg = {
        ...stop,
        peers: entities(peersEnv).filter((e) => e.id !== act.id && e.name !== act.name),
        rooms: entities(roomsEnv),
        places: entities(placesEnv),
        brands: entities(brandsEnv),
        podcasts: entities(podsEnv),
      };
      emit({ type: "stop", stop: pkg });
      return pkg;
    }),
  );

  // ---- 6. Opener shortlist ranked per city ---------------------------------
  // An opener is usually a rising act below the headliner's draw, so prefer
  // peers with lower Qloo popularity than the headliner.
  const tally = new Map();
  for (const s of tour.stops)
    s.peers.forEach((p, i) => {
      const t = tally.get(p.id || p.name) || { ...p, hits: 0, best: Infinity };
      t.hits++;
      t.best = Math.min(t.best, i);
      tally.set(p.id || p.name, t);
    });
  const pool = [...tally.values()];
  const below = act.popularity !== undefined ? pool.filter((p) => typeof p.popularity === "number" && p.popularity < act.popularity) : [];
  const candidates = below.length >= 4 ? below : pool;
  const userOpeners = (input.openers || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
  const auto = candidates.sort((a, b) => b.hits - a.hits || a.best - b.best).slice(0, 8 - userOpeners.length);
  if (below.length >= 4) think("openers", `Shortlisted ${auto.length} opener candidates with less Qloo popularity than ${act.name}, so the bill stays headliner-led.`);
  const shortlist = [...userOpeners.map((name) => ({ name, ref: name, user: true })), ...auto.map((a) => ({ name: a.name, ref: a.id || a.name, user: false, popularity: a.popularity }))];
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
    const cmp = await q("openers", `Shared taste: ${act.name} fans vs ${top.name} fans`, "qloo_compare_audiences", { group_a: [actRef], group_b: [top.id || top.name], limit: 20 });
    const sharedTags = fanTags(cmp.results?.tags || [], { generic: true }).map((t) => ({ name: t.name, score: t.score }));
    tour.compare = { with: top.name, shared: sharedTags };
    emit({ type: "compare", compare: tour.compare });
  }

  // ---- 8. City-specific marketing copy -------------------------------------
  tour.copy = await writeCopy(tour);
  emit({ type: "copy", copy: tour.copy });

  tour.brief = await writeBrief(tour);
  emit({ type: "brief", brief: tour.brief });

  try {
    await mkdir(RUNS_DIR, { recursive: true });
    await writeFile(path.join(RUNS_DIR, `${tour.id}.json`), JSON.stringify(tour, null, 1));
  } catch (err) {
    console.warn("[plan] could not save tour:", err.message);
  }
  emit({ type: "done", id: tour.id, calls: tour.calls, mock: tour.mock, tour });
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

// Keep tags that describe taste (style, humour, genre, mood), drop the
// venue-attribute and payment tags Qloo also associates with audiences.
const NOISE_TAG = /:place\b|:brand\b|credit_card|hotel_rating|cost_description|inclusivity|residence|occupation|genre:person|price_level|accessibility|gender|nationality|ethnicity|religion|category:qloo/;
const GENERIC_TAG = /^(comedy|actor|music|film|movies|television|tv|entertainment|laughter|comedians|musicians)$/i;
function fanTags(list, { generic = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const type = String(t.subtype || t.type || t.tag_id || t.id || "");
    const name = String(t.name || "").trim();
    if (!name || NOISE_TAG.test(type) || NOISE_TAG.test(String(t.tag_id || t.id || ""))) continue;
    if (GENERIC_TAG.test(name)) continue;
    if (generic && typeof t.popularity === "number" && t.popularity > 0.9999) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: t.id || t.tag_id, name: name[0].toUpperCase() + name.slice(1), affinity: num(t.affinity), score: num(t.query?.score) });
  }
  return out.slice(0, 10);
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
  // Touring acts are people, artists or podcasts; prefer those types.
  const touring = cands.filter((c) => /person|artist|podcast/.test(String(c.type)));
  if (touring.length) cands = touring;
  if (hasLLM()) {
    try {
      const out = await completeJSON({
        system: "You resolve ambiguous entity names for a live-entertainment touring tool. Reply with JSON only.",
        prompt: `The user typed "${query}"${notes ? ` (context: ${notes})` : ""}. Qloo returned these candidates:\n${JSON.stringify(cands.slice(0, 8))}\nPick the one a touring performer most likely means. Comedians and speakers are "person" entities; musicians and bands are "artist" entities; shows are "podcast" entities. Reply {"index": <number>, "reason": "<short>"}.`,
        maxTokens: 200,
      });
      const c = cands[out.index];
      if (c) return { ...c, reason: out.reason };
    } catch {}
  }
  const byPop = [...cands].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  return { ...byPop[0], reason: "most popular touring entity with this name" };
}

async function decideRoute({ act, profile, cities, stopsWanted, input }) {
  const viable = cities.filter((c) => c.score !== null);
  const fallback = () => {
    const keep = viable.slice(0, stopsWanted).map((c) => c.name);
    const cutoff = viable[stopsWanted - 1]?.score;
    const dropped = cities
      .filter((c) => !keep.includes(c.name))
      .map((c) => ({ city: c.name, score: c.score, reason: c.score === null ? "Qloo has too little signal for this act here" : `Fan affinity ${c.score} is below the route's cut-off of ${cutoff}` }));
    return {
      keep,
      dropped,
      why: Object.fromEntries(viable.slice(0, stopsWanted).map((c) => [c.name, `Top heat cells around ${c.name} average ${c.affinity} affinity (${c.cells} cells within 50 km); scene density ${c.popularity}.`])),
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
Candidate markets scored from one Qloo heatmap of the whole region. score (0-100) = mean of the top-3 grid cells' affinity within 50 km of the city; affinity measures how strongly this act over-indexes there versus everything else locals engage with, ranked across the whole region, so scores are comparable. popularity = how dense the act's signal is there (a scene-size proxy; big cities are always high).
${JSON.stringify(cities.map((c) => ({ city: c.name, score: c.score, affinity: c.affinity, popularity: c.popularity, cells: c.cells, note: c.note })))}
Choose exactly ${stopsWanted} cities. Follow the scores; you may swap a borderline city (within ~2 points) for routing sense, scene size or the user's constraints, and say so. Note when a famous big city scores low: that is the insight the performer needs.
Reply: {"keep": [city names], "why": {"<city>": "<one line, cite the numbers>"}, "dropped": [{"city": "...", "reason": "<one line, cite the numbers>"}], "rationale": "<two sentences>"}`,
      maxTokens: 1200,
    });
    // Guardrail: the data decides. The LLM may swap a city only within 3
    // points of the cut-off, or one the user named in their notes.
    const cutoff = viable[stopsWanted - 1]?.score ?? 0;
    const notes = String(input.notes || "").toLowerCase();
    const eligible = new Set(viable.filter((c) => c.score >= cutoff - 3 || notes.includes(c.name.toLowerCase())).map((c) => c.name));
    let keep = (out.keep || []).filter((n) => eligible.has(n)).slice(0, stopsWanted);
    const rejected = (out.keep || []).filter((n) => !eligible.has(n));
    if (rejected.length) console.warn(`[route] overrode LLM picks outside the data: ${rejected.join(", ")}`);
    for (const c of viable) if (keep.length < stopsWanted && !keep.includes(c.name)) keep.push(c.name);
    if (keep.length < Math.min(3, stopsWanted)) {
      console.warn("[route] LLM kept too few known cities; using scores");
      return fallback();
    }
    const dropped = cities
      .filter((c) => !keep.includes(c.name))
      .map((c) => ({ city: c.name, score: c.score, reason: (out.dropped || []).find((d) => d.city === c.name)?.reason || "Lower fan affinity than the kept markets" }));
    return { keep, why: out.why || {}, dropped, rationale: out.rationale || fallback().rationale };
  } catch (err) {
    console.warn("[route] LLM failed, using scores:", err.status || "", err.message?.slice(0, 200));
    return fallback();
  }
}

export async function writeCopy(tour) {
  const stops = tour.stops.map((s) => ({
    city: s.name,
    opener: s.opener?.name,
    rooms: (s.rooms || []).slice(0, 3).map((p) => p.name),
    places: s.places.slice(0, 4).map((p) => p.name),
    brands: s.brands.slice(0, 3).map((b) => b.name),
    podcasts: s.podcasts.slice(0, 2).map((p) => p.name),
  }));
  const fallback = () => ({
    source: "template",
    stops: stops.map((s) => ({
      city: s.city,
      generic: `${tour.act.name} live in ${s.city}! Get your tickets now.`,
      hook: `${s.city}, ${tour.act.name} is coming${s.opener ? ` with ${s.opener} opening` : ""}.${s.places[0] ? ` Pre-show drinks at ${s.places[0]}.` : ""}`,
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
- "hook": a punchy local promo line (max 25 words) that weaves in 1-2 references from that city's evidence (the opener, a bar or restaurant for a pre-show meet-up, a sponsor brand).
- "caption": a social caption (max 20 words).
- "references": the exact evidence names you used.
Evidence per city: ${JSON.stringify(stops)}
Reply: {"stops": [{"city","generic","hook","caption","references"}]}`,
      maxTokens: 2500,
    });
    const allowed = new Map(stops.map((s) => [s.city, new Set([s.opener, ...s.rooms, ...s.places, ...s.brands, ...s.podcasts].filter(Boolean))]));
    // Guardrail: keep only references that really came from Qloo for that city.
    const cleaned = (out.stops || []).map((s) => ({ ...s, references: (s.references || []).filter((r) => allowed.get(s.city)?.has(r)) }));
    return { source: "llm", stops: cleaned.length ? cleaned : fallback().stops };
  } catch (err) {
    console.warn("[copy] LLM failed, using templates:", err.status || "", err.message?.slice(0, 200));
    return fallback();
  }
}

export async function writeBrief(tour) {
  const facts = {
    act: tour.act.name,
    region: tour.region.label,
    route_with_fan_affinity: tour.route.map((r) => `${r.name} (${r.score})`),
    routing_rationale: tour.rationale,
    dropped_with_fan_affinity_and_reason: tour.dropped.slice(0, 5).map((d) => `${d.city} (${d.score ?? "no data"}): ${d.reason}`),
    top_opener: tour.openers.board[0]?.name,
    shared_taste_with_opener: tour.compare?.shared?.slice(0, 4).map((t) => t.name),
  };
  if (!hasLLM())
    return `${facts.act}: ${facts.route_with_fan_affinity.length}-city run through ${facts.route_with_fan_affinity.join(", ")}.${facts.top_opener ? ` ${facts.top_opener} is the strongest opener across the route.` : ""}`;
  try {
    return (
      await complete({
        system: "You are a tour manager writing a 3-sentence executive summary for a promoter. Plain, specific, cite the fan-affinity scores (0-100, from Qloo's heatmap). Use only the facts given; never invent data sources, reasons or numbers. No hype.",
        prompt: JSON.stringify(facts),
        maxTokens: 300,
      })
    ).trim();
  } catch (err) {
    console.warn("[brief] LLM failed:", err.status || "", err.message?.slice(0, 200));
    return `${facts.act}: ${facts.route_with_fan_affinity.length}-city run through ${facts.route_with_fan_affinity.join(", ")}.${facts.top_opener ? ` ${facts.top_opener} is the strongest opener across the route.` : ""}`;
  }
}
