import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { startQloo, status as qlooStatus } from "./qloo.js";
import { regionList, REGIONS } from "./cities.js";
import { planTour, UserError, RUNS_DIR } from "./pipeline.js";
import { askCopilot } from "./copilot.js";
import { llmInfo } from "./llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);

import { PRESETS } from "./presets.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.static(PUBLIC, { extensions: ["html"], maxAge: "5m" }));

// --- light abuse protection for the public demo (protects the Qloo quota) --
const hits = new Map();
function limited(req, max, windowMs) {
  const key = `${req.path}:${req.headers["x-forwarded-for"]?.split(",")[0] || req.ip}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

function ndjson(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (event) => res.write(JSON.stringify(event) + "\n");
}

async function loadTour(id) {
  if (!/^[a-z0-9-]{4,40}$/i.test(id)) return null;
  const file = path.join(RUNS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8"));
}

async function featured() {
  const file = path.join(ROOT, "data", "featured.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

app.get("/api/status", async (_req, res) => {
  res.json({ qloo: qlooStatus(), llm: llmInfo(), regions: regionList(), presets: PRESETS, featured: await featured() });
});

app.post("/api/plan", async (req, res) => {
  const b = req.body || {};
  const act = String(b.act || "").trim().slice(0, 80);
  if (!act) return res.status(400).json({ error: "Enter an artist, comedian or creator." });
  if (b.region && !REGIONS[b.region]) return res.status(400).json({ error: "Unknown region." });
  if (limited(req, Number(process.env.PLAN_LIMIT_PER_HOUR || 12), 3600e3))
    return res.status(429).json({ error: "This public demo allows a few new tours per hour. Open one of the saved tours below, or try again later." });
  const input = {
    act,
    actType: ["artist", "person", "podcast"].includes(b.actType) ? b.actType : undefined,
    region: b.region || "us",
    stops: Number(b.stops) || 5,
    month: String(b.month || "").slice(0, 20) || undefined,
    notes: String(b.notes || "").slice(0, 240) || undefined,
    openers: Array.isArray(b.openers) ? b.openers.map((o) => String(o).slice(0, 60)).filter(Boolean).slice(0, 4) : [],
  };
  const emit = ndjson(res);
  let closed = false;
  res.on("close", () => (closed = true));
  try {
    await planTour(input, (e) => !closed && emit(e));
  } catch (err) {
    console.error("[plan]", err);
    emit({ type: "error", message: err instanceof UserError ? err.message : "Something went wrong while planning. Please try again." });
  }
  res.end();
});

app.get("/api/tour/:id", async (req, res) => {
  const tour = await loadTour(req.params.id);
  if (!tour) return res.status(404).json({ error: "Tour not found" });
  res.json(tour);
});

app.get("/api/tours", async (_req, res) => {
  try {
    const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith(".json"));
    const rows = await Promise.all(
      files.map(async (f) => {
        const s = await stat(path.join(RUNS_DIR, f));
        return { f, t: s.mtimeMs };
      }),
    );
    rows.sort((a, b) => b.t - a.t);
    const list = [];
    for (const { f } of rows.slice(0, 12)) {
      const t = JSON.parse(await readFile(path.join(RUNS_DIR, f), "utf8"));
      list.push({ id: t.id, act: t.act?.name, region: t.region?.label, stops: t.route?.length, created_at: t.created_at, mock: t.mock });
    }
    res.json(list);
  } catch {
    res.json([]);
  }
});

app.post("/api/tour/:id/ask", async (req, res) => {
  const tour = await loadTour(req.params.id);
  if (!tour) return res.status(404).json({ error: "Tour not found" });
  const question = String(req.body?.question || "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "Ask a question." });
  if (limited(req, Number(process.env.ASK_LIMIT_PER_HOUR || 40), 3600e3)) return res.status(429).json({ error: "Too many questions for now; try again later." });
  const emit = ndjson(res);
  try {
    await askCopilot({ tour, question, history: Array.isArray(req.body?.history) ? req.body.history : [], emit });
  } catch (err) {
    console.error("[ask]", err);
    emit({ type: "answer", text: "Sorry, I couldn't finish that. Please try again." });
  }
  res.end();
});

app.get("/tour/:id", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.get("/healthz", (_req, res) => res.json({ ok: true, ...qlooStatus() }));

const s = await startQloo();
console.log(`[qloo] mode=${s.mode} tools=${s.tools.length}${s.error ? ` error=${s.error}` : ""}`);
console.log(`[llm] ${JSON.stringify(llmInfo())}`);
app.listen(PORT, () => console.log(`TourSmith on http://localhost:${PORT}`));
