// Qloo access layer.
//
// TourSmith talks to Qloo through the official `qloo mcp` server from
// @qloo/qloo-harness (the supported surface for the hackathon). This module
// starts that stdio server once, exposes its tool list to the LLM agents, and
// wraps every call with: a disk cache (protects the event quota and makes the
// judges' demo instant), a small concurrency limit, and an explicit mock mode
// for local development before a key is issued.
//
// One call goes to the Insights API directly: the region-wide heatmap. The
// harness caps heatmaps at 20 cells and takes only a place name, while the
// API returns the full grid (thousands of cells) for a WKT boundary. That is
// what makes city scores comparable across a whole tour region.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockCall } from "./mock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, "data", "cache");

const API_BASE = (process.env.QLOO_BASE_URL || "https://api.qloo.com").replace(/\/+$/, "");

export const QLOO_TOOL_NAMES = [
  "qloo_describe",
  "qloo_find_tags",
  "qloo_recommend",
  "qloo_rank",
  "qloo_where_popular",
  "qloo_compare_audiences",
  "qloo_entity_tags",
  "qloo_audience_demographics",
  "qloo_trends",
];

let client = null;
let tools = [];
let ready = false;
let mode = "starting"; // live | mock | cache-only
let startError = null;

// --- concurrency limiter -------------------------------------------------
const MAX_CONCURRENT = Number(process.env.QLOO_CONCURRENCY || 3);
let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active++;
      resolve();
    } else queue.push(resolve);
  });
}
function release() {
  const next = queue.shift();
  if (next) next();
  else active--;
}

// --- cache ----------------------------------------------------------------
function cacheKey(name, args) {
  const stable = JSON.stringify(sortKeys(args ?? {}));
  return createHash("sha256").update(`${name}:${stable}`).digest("hex").slice(0, 32);
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
async function cacheGet(name, args) {
  const file = path.join(CACHE_DIR, `${cacheKey(name, args)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function cachePut(name, args, envelope) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${cacheKey(name, args)}.json`);
  // Store only the envelope fields the app uses; never credentials.
  const { execution, ...rest } = envelope;
  await writeFile(file, JSON.stringify({ tool: name, args, envelope: rest, cached_at: new Date().toISOString() }));
}

// --- lifecycle ------------------------------------------------------------
export async function startQloo() {
  if (process.env.QLOO_MOCK === "1") {
    mode = "mock";
    ready = true;
    tools = await loadToolSchemasOffline();
    return status();
  }
  try {
    client = new Client({ name: "toursmith", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.env.QLOO_BIN || "qloo",
      args: ["mcp"],
      env: process.env, // forwards QLOO_API_KEY to the harness
      stderr: "pipe",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    tools = listed.tools.filter((t) => QLOO_TOOL_NAMES.includes(t.name));
    const cap = await client.callTool({ name: "qloo_capabilities", arguments: {} });
    const adapterReady = Boolean(cap.structuredContent?.adapter?.ready);
    ready = true;
    // No credential: serve from the warmed cache, and fall back to clearly
    // labelled sample data for anything not cached.
    mode = adapterReady ? "live" : "cache-only";
  } catch (err) {
    startError = err.code === "ENOENT"
      ? "Cannot start `qloo`. Install it with: npm install --global @qloo/qloo-harness"
      : err.message;
    mode = "cache-only";
    ready = true;
    tools = await loadToolSchemasOffline();
  }
  return status();
}

async function loadToolSchemasOffline() {
  const file = path.join(ROOT, "server", "qloo-tools.schema.json");
  try {
    const all = JSON.parse(await readFile(file, "utf8"));
    return all.filter((t) => QLOO_TOOL_NAMES.includes(t.name));
  } catch {
    return [];
  }
}

export function status() {
  return { mode, ready, tools: tools.map((t) => t.name), error: startError };
}

export function toolSchemas() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// --- the call -------------------------------------------------------------
// Returns { envelope, cached, mock, ms }. Never throws for Qloo-level errors:
// those come back as status "error" envelopes the agent can reason about.
export async function callQloo(name, args = {}) {
  const t0 = Date.now();
  const hit = await cacheGet(name, args);
  if (hit) return { envelope: hit.envelope, cached: true, mock: Boolean(hit.envelope.mock), ms: Date.now() - t0 };

  if (mode !== "live") {
    const envelope = mockCall(name, args);
    return { envelope, cached: false, mock: true, ms: Date.now() - t0 };
  }

  await acquire();
  try {
    let envelope;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
      envelope = res.structuredContent ?? safeParse(res.content?.[0]?.text) ?? {};
      if (envelope.status === undefined) envelope = { status: "error", summary: "Unparseable Qloo result", error: { code: "UNKNOWN", retryable: false } };
      if (envelope.status === "error" && envelope.error?.retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break;
    }
    if (["ok", "empty", "partial", "degraded"].includes(envelope.status)) await cachePut(name, args, envelope);
    return { envelope, cached: false, mock: false, ms: Date.now() - t0 };
  } catch (err) {
    return {
      envelope: { status: "error", summary: err.message, error: { code: "TRANSPORT", retryable: false, recovery: "Check that the qloo harness is running and QLOO_API_KEY is set." }, results: [] },
      cached: false,
      mock: false,
      ms: Date.now() - t0,
    };
  } finally {
    release();
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- helpers for reading envelopes ----------------------------------------
export function entityTypeShort(urn) {
  if (!urn) return undefined;
  return String(urn).replace("urn:entity:", "");
}

// Pull candidates out of a needs_input envelope so the agent (or the user)
// can pick the intended entity.
export function candidatesOf(envelope) {
  const issues = envelope?.resolution?.issues ?? [];
  return issues.flatMap((i) => (i.candidates ?? []).map((c) => ({ input: i.input, ...c })));
}

// --- region heatmap (Insights API, urn:heatmap) ---------------------------
// Returns { points: [{lat,lng,affinity,affinity_rank,popularity}], cached, mock, ms, status, summary }.
export async function regionHeatmap(entityId, wkt) {
  const t0 = Date.now();
  const args = { entity: entityId, wkt };
  const hit = await cacheGet("insights_heatmap", args);
  if (hit) return { ...hit.envelope, cached: true, ms: Date.now() - t0 };
  if (mode !== "live" || !process.env.QLOO_API_KEY) {
    const env = mockCall("region_heatmap", args);
    return { ...env, cached: false, mock: true, ms: Date.now() - t0 };
  }
  const params = new URLSearchParams({
    "filter.type": "urn:heatmap",
    "signal.interests.entities": entityId,
    "filter.location": wkt,
    take: "50",
  });
  await acquire();
  try {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${API_BASE}/v2/insights?${params}`, {
        headers: { "x-api-key": process.env.QLOO_API_KEY, accept: "application/json" },
        signal: AbortSignal.timeout(90000),
      });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (!res.ok) {
      return { status: "error", summary: `Qloo heatmap request failed (HTTP ${res.status})`, points: [], cached: false, mock: false, ms: Date.now() - t0 };
    }
    const body = await res.json();
    const cells = Array.isArray(body?.results?.heatmap) ? body.results.heatmap : [];
    const points = cells
      .map((c) => ({
        lat: c.location?.latitude,
        lng: c.location?.longitude,
        affinity: c.query?.affinity,
        affinity_rank: c.query?.affinity_rank,
        popularity: c.query?.popularity,
      }))
      .filter((p) => typeof p.lat === "number" && typeof p.lng === "number" && typeof p.affinity === "number");
    const envelope = {
      status: points.length ? "ok" : "empty",
      summary: `${points.length} heatmap cells`,
      points,
      provenance: { endpoint: "/v2/insights", query: Object.fromEntries(params) },
    };
    if (points.length) await cachePut("insights_heatmap", args, envelope);
    return { ...envelope, cached: false, mock: false, ms: Date.now() - t0 };
  } catch (err) {
    return { status: "error", summary: err.message, points: [], cached: false, mock: false, ms: Date.now() - t0 };
  } finally {
    release();
  }
}
