// Thin LLM adapter: Anthropic (Claude), Google Gemini, or any
// OpenAI-compatible endpoint (OpenAI, OpenRouter...). Gemini is reached
// through its OpenAI-compatible API. If no key is set, TourSmith still runs:
// the reasoning steps fall back to deterministic rules and templated copy,
// and the UI says so.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

let anthropic = null;
let openai = null;
let OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
let provider = "none";
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  provider = "anthropic";
} else if (process.env.GEMINI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: GEMINI_BASE_URL, maxRetries: 0, timeout: 45000 });
  OPENAI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  provider = "gemini";
} else if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}), maxRetries: 3 });
  provider = "openai-compatible";
}

// Models to try in order when one is overloaded (503), rate limited (429) or
// retired (404). Gemini's busy periods are common, and a judge's click must
// not stall on one model.
function modelChain() {
  const extra = provider === "gemini" ? ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"] : [];
  const fromEnv = (process.env.LLM_FALLBACK_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return [...new Set([OPENAI_MODEL, ...fromEnv, ...extra])];
}
async function chat(params) {
  let lastErr;
  for (const model of modelChain()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await openai.chat.completions.create({ ...params, model });
      } catch (err) {
        lastErr = err;
        const st = err?.status;
        if (st === 404 || st === 400) break; // try next model
        const timedOut = /timeout|timed out|abort/i.test(`${err?.constructor?.name} ${err?.message}`);
        if (st === 503 || st === 429 || st === 500 || timedOut) {
          console.warn(`[llm] ${model} ${st || "timeout"}; ${attempt === 0 && !timedOut ? "retrying" : "trying next model"}`);
          if (timedOut) break; // a slow model rarely recovers on retry; move on
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastErr;
}

export function llmInfo() {
  if (anthropic) return { provider, model: ANTHROPIC_MODEL };
  if (openai) return { provider, model: OPENAI_MODEL };
  return { provider: "none", model: null };
}

// Gemini's function calling accepts a subset of JSON Schema. Keep only the
// keywords every provider understands.
const SCHEMA_KEYS = new Set(["type", "description", "enum", "properties", "items", "required", "minimum", "maximum", "minItems", "maxItems"]);
export function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)]));
    else if (k === "items") out[k] = cleanSchema(v);
    else out[k] = v;
  }
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}
export const hasLLM = () => Boolean(anthropic || openai);

// One-shot completion returning text.
export async function complete({ system, prompt, maxTokens = 1500 }) {
  if (anthropic) {
    const res = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (openai) {
    const res = await chat({
      max_tokens: maxTokens + 2000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    return stripThinking(res.choices[0]?.message?.content ?? "");
  }
  throw new Error("No LLM configured");
}

function stripThinking(text) {
  return String(text).replace(/<thought>[\s\S]*?<\/thought>/g, "").trim();
}

// Completion that must return JSON. Tolerates code fences and prose around it.
export async function completeJSON(opts) {
  const text = await complete(opts);
  return extractJSON(text);
}

export function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("No JSON in model output");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}

// Agentic tool-use loop. `tools` = [{name, description, input_schema}];
// `exec(name, input)` returns a string (or object) result. `onStep` receives
// {type: "tool_call" | "tool_result" | "text", ...} so the UI can show the
// agent's work as it happens.
export async function toolLoop({ system, user, history = [], tools, exec, maxTurns = 8, onStep = () => {} }) {
  if (anthropic) return anthropicLoop({ system, user, history, tools, exec, maxTurns, onStep });
  if (openai) return openaiLoop({ system, user, history, tools, exec, maxTurns, onStep });
  throw new Error("No LLM configured");
}

async function anthropicLoop({ system, user, history, tools, exec, maxTurns, onStep }) {
  const messages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: user }];
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    const calls = res.content.filter((b) => b.type === "tool_use");
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text) onStep({ type: "text", text });
    if (res.stop_reason !== "tool_use" || calls.length === 0) return text;
    const results = [];
    for (const call of calls) {
      onStep({ type: "tool_call", id: call.id, name: call.name, input: call.input });
      const out = await exec(call.name, call.input);
      const content = typeof out === "string" ? out : JSON.stringify(out);
      onStep({ type: "tool_result", id: call.id, name: call.name, output: out });
      results.push({ type: "tool_result", tool_use_id: call.id, content });
    }
    messages.push({ role: "user", content: results });
  }
  return "I stopped after reaching the step limit. Here is what I found so far.";
}

async function openaiLoop({ system, user, history, tools, exec, maxTurns, onStep }) {
  const messages = [
    { role: "system", content: system },
    ...history.map((h) => ({ role: h.role, content: typeof h.content === "string" ? h.content : JSON.stringify(h.content) })),
    { role: "user", content: user },
  ];
  const oaTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: cleanSchema(t.input_schema) } }));
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await chat({ messages, tools: oaTools, max_tokens: 4000 });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.content) onStep({ type: "text", text: stripThinking(msg.content) });
    if (!msg.tool_calls?.length) return stripThinking(msg.content ?? "");
    for (const call of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {}
      onStep({ type: "tool_call", id: call.id, name: call.function.name, input });
      const out = await exec(call.function.name, input);
      onStep({ type: "tool_result", id: call.id, name: call.function.name, output: out });
      messages.push({ role: "tool", tool_call_id: call.id, content: typeof out === "string" ? out : JSON.stringify(out) });
    }
  }
  return "I stopped after reaching the step limit. Here is what I found so far.";
}
