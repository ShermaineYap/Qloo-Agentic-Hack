// TourSmith front end: streams the agent's run from /api/plan (NDJSON) and
// renders the tour as it is built. The same renderers draw a saved tour at
// /tour/:id, which is the shareable page a performer sends to a promoter.

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "–");

const PHASES = {
  act: "Identify the headliner",
  audience: "Read the audience",
  route: "Find the fans on the map",
  stops: "Package each stop",
  openers: "Choose openers",
};
const AGE_LABELS = { "24_and_younger": "Under 25", "25_to_29": "25–29", "30_to_34": "30–34", "35_to_44": "35–44", "45_to_54": "45–54", "55_and_older": "55 and over" };

let status = null;
let region = "us";
let actType = "";
let T = null; // the tour being built or viewed
let map, heatLayer, cityLayer, routeLayer;
const cityMarkers = new Map();
let lastPhase = null;
let chatHistory = [];

// ---------------------------------------------------------------- boot
init();

async function init() {
  initMap();
  status = await fetch("/api/status").then((r) => r.json()).catch(() => null);
  if (status) {
    renderMode();
    renderRegions();
    renderPresets();
  }
  const m = location.pathname.match(/^\/tour\/([a-z0-9-]+)/i);
  if (m) return openSaved(m[1]);
  renderSaved();
}

function renderMode() {
  const el = $("#mode");
  const q = status.qloo;
  el.hidden = false;
  if (q.mode === "live") {
    el.textContent = "Live Qloo data";
    el.className = "mode live";
  } else if (q.mode === "cache-only") {
    el.textContent = "Saved Qloo results only";
    el.className = "mode";
    el.title = "No Qloo key on this server: tours already run are served from cache; anything new uses sample data.";
  } else {
    el.textContent = "Sample data, not from Qloo";
    el.className = "mode sample";
  }
}

function renderRegions() {
  const box = $("#regions");
  box.innerHTML = "";
  for (const r of status.regions) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.textContent = r.label;
    b.setAttribute("aria-checked", String(r.id === region));
    b.onclick = () => {
      region = r.id;
      [...box.children].forEach((c) => c.setAttribute("aria-checked", String(c === b)));
      map.setView(r.center, r.zoom);
    };
    box.appendChild(b);
  }
}

function renderPresets() {
  const box = $("#presets");
  box.innerHTML = "Try: ";
  status.presets.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${p.act} (${p.label})`;
    b.onclick = () => {
      $("#act").value = p.act;
      setKind(p.actType);
      $("#notes").value = p.notes || "";
      $("#stops").value = p.stops;
      $("#stopsOut").textContent = p.stops;
      region = p.region;
      renderRegions();
      const r = status.regions.find((x) => x.id === p.region);
      if (r) map.setView(r.center, r.zoom);
    };
    box.appendChild(b);
    if (i < status.presets.length - 1) box.append(", ");
  });
}

async function renderSaved() {
  const tours = await fetch("/api/tours").then((r) => r.json()).catch(() => []);
  const featured = status?.featured || [];
  const box = $("#saved");
  const items = [...featured.map((f) => ({ ...f, featured: true })), ...tours.filter((t) => !featured.find((f) => f.id === t.id))].slice(0, 8);
  if (!items.length) return;
  box.innerHTML = `<h3>Tours already planned</h3><ul>${items
    .map((t) => `<li><a href="/tour/${esc(t.id)}">${esc(t.act)}</a> · ${esc(t.region)}${t.stops ? `, ${t.stops} stops` : ""}${t.mock ? " <small>(sample data)</small>" : ""}</li>`)
    .join("")}</ul>`;
}

$("#stops").addEventListener("input", (e) => ($("#stopsOut").textContent = e.target.value));
function setKind(kind) {
  actType = kind || "";
  document.querySelectorAll("#kinds button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.kind === actType)));
}
document.querySelectorAll("#kinds button").forEach((b) => (b.onclick = () => setKind(b.dataset.kind)));

// ---------------------------------------------------------------- map
function initMap() {
  map = L.map("map", { zoomControl: true, scrollWheelZoom: false, worldCopyJump: true }).setView([39.5, -98.35], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, heat data: Qloo',
    maxZoom: 12,
  }).addTo(map);
  heatLayer = L.layerGroup().addTo(map);
  cityLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

function drawCandidates(cities) {
  cityLayer.clearLayers();
  cityMarkers.clear();
  for (const c of cities) {
    const m = L.circleMarker([c.lat, c.lng], { radius: 5, color: "#6a7088", weight: 1.5, fillColor: "#ffffff", fillOpacity: 1 }).addTo(cityLayer);
    m.bindTooltip(`${esc(c.name)}: scoring…`, { className: "citytip" });
    cityMarkers.set(c.name, m);
  }
}

function drawCity(c) {
  let m = cityMarkers.get(c.name);
  if (!m) {
    m = L.circleMarker([c.lat, c.lng]).addTo(cityLayer);
    cityMarkers.set(c.name, m);
  }
  const r = c.score == null ? 4 : 4 + (c.score / 100) * 14;
  m.setStyle({ radius: r, color: "#1c1f3f", weight: 1.5, fillColor: c.score == null ? "#cfd3de" : "#1c1f3f", fillOpacity: c.score == null ? 1 : 0.85 });
  m.setTooltipContent(
    c.score == null
      ? `${esc(c.name)}: ${esc(c.note || "no Qloo signal")}`
      : `<b>${esc(c.name)}</b>: fan affinity ${c.score}<br>${c.cells} Qloo grid cells within 50 km, scene density ${fmt(c.popularity)}`,
  );
}

function drawHeat(points) {
  heatLayer.clearLayers();
  // Affinity is a 0–1 rank across the region; stretch the top band for contrast.
  const vals = points.map((p) => p.affinity ?? 0);
  const lo = Math.min(...vals), hi = Math.max(...vals, lo + 0.0001);
  for (const p of points) {
    const a = ((p.affinity ?? 0) - lo) / (hi - lo);
    L.circle([p.lat, p.lng], { radius: 14000, stroke: false, fillColor: "#c42a79", fillOpacity: Math.max(0.04, 0.55 * a * a), interactive: false }).addTo(heatLayer);
  }
}

function drawRoute(route) {
  routeLayer.clearLayers();
  if (!route.length) return;
  const pts = route.map((s) => [s.lat, s.lng]);
  L.polyline(pts, { color: "#1c1f3f", weight: 7, opacity: 0.9 }).addTo(routeLayer);
  L.polyline(pts, { color: "#f4c21b", weight: 4, opacity: 1 }).addTo(routeLayer);
  route.forEach((s, i) => {
    L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: "", html: `<div style="font:800 15px/22px 'Big Shoulders Display',sans-serif;width:24px;height:24px;border-radius:50%;background:#f4c21b;color:#1c1f3f;border:2px solid #1c1f3f;text-align:center">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      keyboard: false,
    })
      .bindTooltip(`${i + 1}. ${esc(s.name)} (score ${s.score ?? "–"})`, { className: "citytip" })
      .addTo(routeLayer);
  });
  map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 6 });
}

// ---------------------------------------------------------------- run
$("#plan").addEventListener("submit", async (e) => {
  e.preventDefault();
  const act = $("#act").value.trim();
  if (!act) return $("#act").focus();
  resetRun();
  const body = {
    act,
    ...(actType ? { actType } : {}),
    region,
    stops: Number($("#stops").value),
    notes: $("#notes").value.trim(),
    openers: $("#openers").value.split(",").map((s) => s.trim()).filter(Boolean),
  };
  $("#go").disabled = true;
  $("#go").textContent = "Planning…";
  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Request failed (${res.status})`);
    }
    await readStream(res, onEvent);
  } catch (err) {
    logError(err.message);
  } finally {
    $("#go").disabled = false;
    $("#go").textContent = "Plan the tour";
  }
});

async function readStream(res, handler) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          handler(JSON.parse(line));
        } catch (err) {
          console.error(err, line);
        }
      }
    }
  }
}

function resetRun() {
  T = { stops: [], route: [], copy: null, openers: null, steps: [] };
  lastPhase = null;
  chatHistory = [];
  $("#steps").innerHTML = "";
  $("#logEmpty").hidden = true;
  $("#chat").innerHTML = "";
  $("#tour").hidden = true;
  $("#empty").hidden = true;
  $("#actions").hidden = true;
  $("#askPanel").hidden = true;
  $("#openersPanel").hidden = true;
  $("#route").innerHTML = "";
  $("#dropped").innerHTML = "";
  $("#brief").textContent = "";
  heatLayer.clearLayers();
  routeLayer.clearLayers();
  cityLayer.clearLayers();
  if (location.pathname !== "/") history.replaceState(null, "", "/");
}

function onEvent(e) {
  switch (e.type) {
    case "start":
      T.region = e.region;
      map.setView(e.region.center, e.region.zoom);
      drawCandidates(e.candidates);
      break;
    case "step":
      logStep(e);
      break;
    case "act":
      T.act = e.act;
      renderAct();
      break;
    case "profile":
      T.profile = e.profile;
      renderProfile();
      break;
    case "heat":
      drawHeat(e.points);
      break;
    case "city":
      drawCity(e.city);
      break;
    case "route":
      Object.assign(T, { route: e.route, dropped: e.dropped, rationale: e.rationale });
      renderRoute();
      drawRoute(e.route);
      break;
    case "stop": {
      const i = T.route.findIndex((r) => r.name === e.stop.name);
      T.stops[i] = e.stop;
      renderStopBody(i);
      break;
    }
    case "openers":
      T.openers = e.openers;
      e.stops.forEach((s) => {
        const i = T.route.findIndex((r) => r.name === s.name);
        if (T.stops[i]) T.stops[i].opener = s.opener;
      });
      renderOpeners();
      renderRouteOpeners();
      T.route.forEach((_, i) => renderStopBody(i));
      break;
    case "compare":
      T.compare = e.compare;
      renderCompare();
      break;
    case "copy":
      T.copy = e.copy;
      T.route.forEach((_, i) => renderStopBody(i));
      break;
    case "brief":
      T.brief = e.brief;
      $("#brief").textContent = e.brief;
      break;
    case "done":
      T.id = e.id;
      T.mock = e.mock;
      history.replaceState(null, "", `/tour/${e.id}`);
      $("#actions").hidden = false;
      $("#askPanel").hidden = false;
      logPhase(`Done: ${e.calls} Qloo calls${e.mock ? " (sample data)" : ""}`);
      break;
    case "error":
      logError(e.message);
      break;
  }
}

// ---------------------------------------------------------------- agent log
function logPhase(text) {
  const li = document.createElement("li");
  li.className = "phase";
  li.textContent = text;
  $("#steps").appendChild(li);
}

function logStep(s) {
  if (s.phase !== lastPhase) {
    lastPhase = s.phase;
    logPhase(PHASES[s.phase] || s.phase);
  }
  let li = document.getElementById(`step-${s.id}`);
  if (!li) {
    li = document.createElement("li");
    li.id = `step-${s.id}`;
    $("#steps").appendChild(li);
    const box = $("#steps");
    box.scrollTop = box.scrollHeight;
  }
  const isAgent = s.tool === "agent";
  li.className = isAgent ? "agent" : s.status;
  if (isAgent) {
    li.innerHTML = `<span class="tool">agent decision</span><br>${esc(s.label)}`;
    return;
  }
  const meta = s.status === "running" ? "asking Qloo…" : `${esc(s.summary || s.status)}${s.cached ? " · cached" : ""}${s.mock ? " · sample" : ""}${s.ms != null ? ` · ${s.ms} ms` : ""}`;
  li.innerHTML = `<span class="tool">${esc(s.tool)}</span><br>${esc(s.label)}<span class="res">${meta}</span>${
    s.request ? `<details><summary>Request</summary><pre>${esc(JSON.stringify(s.request, null, 1))}</pre></details>` : ""
  }`;
}

function logError(msg) {
  const li = document.createElement("li");
  li.className = "error";
  li.textContent = msg;
  $("#steps").appendChild(li);
  $("#logEmpty").hidden = true;
}

// ---------------------------------------------------------------- renderers
function renderAct() {
  $("#tour").hidden = false;
  $("#empty").hidden = true;
  const a = T.act;
  $("#actName").textContent = a.name;
  const kind = { artist: "Musician", person: "Comedian / personality", podcast: "Podcast" }[a.kind] || a.kind;
  $("#actKind").textContent = `${kind}, touring ${T.region?.label || ""}`;
  const img = $("#actImg");
  if (a.image) {
    img.src = a.image;
    img.hidden = false;
  } else img.hidden = true;
  document.title = `${a.name} · TourSmith`;
}

function renderProfile() {
  const p = T.profile;
  const tags = p.tags.slice(0, 8);
  const maxA = Math.max(...tags.map((t) => t.affinity ?? 0), 0.0001);
  $("#tags").innerHTML = tags.length
    ? tags.map((t) => `<li><span>${esc(t.name)}</span><span class="bar"><i style="width:${Math.max(6, ((t.affinity ?? maxA) / maxA) * 100)}%"></i></span></li>`).join("")
    : `<li class="muted">Qloo returned no concepts for this act.</li>`;

  const d = p.demographics;
  if (d && (Object.keys(d.age).length || Object.keys(d.gender).length)) {
    const rows = [
      ...Object.entries(d.age).map(([k, v]) => [AGE_LABELS[k] || k, v]),
      ...Object.entries(d.gender).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v]),
    ];
    $("#demo").innerHTML =
      rows
        .map(([label, v]) => {
          const w = Math.min(50, Math.abs(v) * 50);
          const style = v >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
          return `<div class="row"><span>${esc(label)}</span><span class="axis" title="${fmt(v)}"><i class="${v >= 0 ? "pos" : "neg"}" style="${style}"></i></span></div>`;
        })
        .join("") + `<p class="note">Bars right of centre: this group over-indexes for the act.</p>`;
  } else $("#demo").innerHTML = `<p class="muted">No demographic signal from Qloo.</p>`;

  const pts = p.trend.filter((x) => typeof x.percentile === "number");
  if (pts.length > 2) {
    const min = Math.min(...pts.map((x) => x.percentile));
    const max = Math.max(...pts.map((x) => x.percentile));
    const span = Math.max(max - min, 1);
    const coords = pts.map((x, i) => `${(i / (pts.length - 1)) * 300},${80 - ((x.percentile - min) / span) * 70}`).join(" ");
    const label = p.momentum ? `${p.momentum.label[0].toUpperCase() + p.momentum.label.slice(1)} (${p.momentum.delta > 0 ? "+" : ""}${p.momentum.delta} percentile points)` : "";
    const flat = max - min < 0.01;
    $("#trend").innerHTML = `<svg viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="Popularity percentile trend"><polyline points="${coords}" fill="none" stroke="#1c1f3f" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg><p class="label">${esc(flat ? `Steady around the ${Math.round(max)}th percentile` : label)}</p><p class="muted" style="font-size:12px;margin:0">Population percentile, ${esc(pts[0].date)} to ${esc(pts[pts.length - 1].date)}</p>`;
  } else $("#trend").innerHTML = `<p class="muted">Qloo doesn't publish weekly trend data for this kind of entity.</p>`;
}

function renderRoute() {
  const ol = $("#route");
  ol.innerHTML = "";
  T.route.forEach((s, i) => {
    const li = $("#stopTpl").content.firstElementChild.cloneNode(true);
    li.classList.add("new");
    li.dataset.city = s.name;
    li.querySelector(".n").textContent = i + 1;
    li.querySelector(".city").textContent = s.name;
    li.querySelector(".score").textContent = s.score ?? "–";
    li.querySelector(".score").title = `Fan affinity ${s.score}: mean of the top 3 Qloo heatmap cells within 50 km (scene density ${fmt(s.popularity)})`;
    const btn = li.querySelector(".stop-row");
    const body = li.querySelector(".stop-body");
    btn.onclick = () => {
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
    };
    if (i === 0) {
      btn.setAttribute("aria-expanded", "true");
      body.hidden = false;
    }
    ol.appendChild(li);
  });
  const dropped = T.dropped || [];
  $("#dropped").innerHTML =
    (T.rationale ? `<p class="rationale">${esc(T.rationale)}</p>` : "") +
    (dropped.length ? `<h4>Cut from the route</h4><ul>${dropped.map((d) => `<li><b>${esc(d.city)}</b>${d.score != null ? ` (${d.score})` : ""}: ${esc(d.reason)}</li>`).join("")}</ul>` : "");
}

function renderRouteOpeners() {
  T.route.forEach((s, i) => {
    const el = document.querySelector(`.stop[data-city="${CSS.escape(s.name)}"] .opener`);
    const op = T.stops[i]?.opener;
    if (el) el.textContent = op ? `with ${op.name}` : "";
  });
}

function list(items, n, empty) {
  if (!items?.length) return `<p class="muted" style="color:#9ea3c4;margin:0;font-size:14px">${empty}</p>`;
  return `<ul>${items
    .slice(0, n)
    .map((e) => `<li><span>${esc(e.name)}</span><span title="Qloo affinity">${typeof e.affinity === "number" ? e.affinity.toFixed(2) : ""}</span></li>`)
    .join("")}</ul>`;
}

function renderStopBody(i) {
  const s = T.stops[i];
  const r = T.route[i];
  if (!r) return;
  const li = document.querySelector(`.stop[data-city="${CSS.escape(r.name)}"]`);
  if (!li) return;
  const body = li.querySelector(".stop-body");
  if (!s) {
    body.innerHTML = `<p class="why">Packaging this stop…</p>`;
    return;
  }
  const c = T.copy?.stops?.find((x) => x.city === r.name);
  const ranked = T.openers?.perCity?.[r.name];
  body.innerHTML = `
    ${r.why ? `<p class="why">${esc(r.why)}</p>` : ""}
    <div><h4>Opener</h4>${
      s.opener ? `<ul><li><span><b>${esc(s.opener.name)}</b></span><span>${ranked ? "ranked 1st here" : ""}</span></li></ul>` : ""
    }${ranked && ranked.length > 1 ? `<p style="font-size:13px;color:#9ea3c4;margin:6px 0 0">Then: ${ranked.slice(1, 4).map(esc).join(", ")}</p>` : list(s.peers.slice(1), 3, "No local peers found.")}</div>
    <div><h4>Rooms to play</h4>${list(s.rooms, 4, "No rooms with enough Qloo signal here.")}</div>
    <div><h4>Pre-show and after-party</h4>${list(s.places, 4, "No bars or restaurants with enough signal here.")}</div>
    <div><h4>Sponsor fit</h4>${list(s.brands, 4, "No brand signal here.")}</div>
    <div><h4>Local PR</h4>${list(s.podcasts, 3, "No podcast signal here.")}</div>
    ${
      c
        ? `<div class="copy">
            <div class="generic"><span class="who">What a generic AI writes</span><p>${esc(c.generic)}</p></div>
            <div class="ours"><span class="who">TourSmith, grounded in Qloo</span><p>${esc(c.hook)}</p><p>${esc(c.caption)}</p>${
              c.references?.length ? `<p class="refs">Uses: ${c.references.map(esc).join(", ")}</p>` : ""
            }</div>
          </div>`
        : ""
    }`;
}

function renderOpeners() {
  const o = T.openers;
  if (!o?.board?.length) return;
  $("#openersPanel").hidden = false;
  const cities = T.route.map((r) => r.name);
  const pos = (name, city) => {
    const idx = (o.perCity[city] || []).indexOf(name);
    return idx < 0 ? "–" : idx + 1;
  };
  $("#openerTable").innerHTML = `
    <thead><tr><th scope="col">Opener</th><th scope="col">Avg. position</th>${cities.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${o.board
      .map(
        (b) =>
          `<tr><td>${esc(b.name)}${b.user ? ` <span class="you">your pick</span>` : ""}</td><td>${fmt(b.avg_rank, 1)}</td>${cities
            .map((c) => {
              const p = pos(b.name, c);
              return `<td class="${p === 1 ? "first" : ""}">${p}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("")}</tbody>`;
}

function renderCompare() {
  const c = T.compare;
  if (!c?.shared?.length) return;
  $("#compare").innerHTML = `<p><b>Why ${esc(c.with)} works with ${esc(T.act.name)}:</b> Qloo finds these shared tastes across both fan bases.</p><ul>${c.shared
    .slice(0, 8)
    .map((t) => `<li>${esc(t.name)}</li>`)
    .join("")}</ul>`;
}

// ---------------------------------------------------------------- saved tour view
async function openSaved(id) {
  document.body.classList.add("view");
  const tour = await fetch(`/api/tour/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null));
  if (!tour) {
    $("#empty").innerHTML = `<p class="big">That tour isn't here.</p><p>It may have been planned on another server. <a href="/">Plan a new tour</a>.</p>`;
    return;
  }
  T = tour;
  map.invalidateSize();
  map.setView(tour.region.center, tour.region.zoom);
  renderAct();
  renderProfile();
  drawHeat(tour.heat || []);
  (tour.cities || []).forEach(drawCity);
  renderRoute();
  drawRoute(tour.route);
  renderOpeners();
  renderRouteOpeners();
  tour.route.forEach((_, i) => renderStopBody(i));
  renderCompare();
  $("#brief").textContent = tour.brief || "";
  $("#actions").hidden = false;
  $("#askPanel").hidden = false;
  const top = document.createElement("p");
  top.innerHTML = `<a href="/" class="presets" style="font-weight:700">Plan your own tour</a>${tour.mock ? ` · <small>This tour was built from sample data, not live Qloo results.</small>` : ""}`;
  $("#tour").prepend(top);
}

$("#share").addEventListener("click", async () => {
  const url = `${location.origin}/tour/${T.id}`;
  try {
    await navigator.clipboard.writeText(url);
    $("#share").textContent = "Link copied";
  } catch {
    prompt("Copy this link", url);
  }
  setTimeout(() => ($("#share").textContent = "Copy share link"), 2000);
});
$("#print").addEventListener("click", () => {
  document.querySelectorAll(".stop-body").forEach((b) => (b.hidden = false));
  window.print();
});

// ---------------------------------------------------------------- chat
$("#ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#question").value.trim();
  if (!q || !T?.id) return;
  $("#question").value = "";
  const chat = $("#chat");
  chat.insertAdjacentHTML("beforeend", `<div class="q">${esc(q)}</div>`);
  const a = document.createElement("div");
  a.className = "a";
  a.innerHTML = `<span class="t">Thinking…</span>`;
  chat.appendChild(a);
  const trail = [];
  try {
    const res = await fetch(`/api/tour/${T.id}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, history: chatHistory }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
    await readStream(res, (ev) => {
      if (ev.type === "tool") {
        trail.push(`${ev.name}(${Object.entries(ev.input || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ")})`);
        a.innerHTML = `<span class="t">${trail.map(esc).join("<br>")}</span>`;
      }
      if (ev.type === "answer") {
        a.innerHTML = `${trail.length ? `<span class="t">Qloo calls: ${trail.map(esc).join("<br>")}</span>\n\n` : ""}${esc(ev.text)}`;
        chatHistory.push({ role: "user", content: q }, { role: "assistant", content: ev.text });
      }
    });
  } catch (err) {
    a.textContent = err.message;
  }
});
