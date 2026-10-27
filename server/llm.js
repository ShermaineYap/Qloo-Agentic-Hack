// Thin LLM adapter: Anthropic (Claude) or any OpenAI-compatible endpoint
// (OpenAI, Gemini's OpenAI-compatible API, OpenRouter...). If neither key is
// set, TourSmith still runs: the reasoning steps fall back to deterministic
// rules and templated copy, and the UI says so.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

let anthropic = null;
let openai = null;
if (process.env.ANTHROPIC_API_KEY) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
else if (process.env.OPENAI_API_KEY)
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });

export function llmInfo() {
  if (anthropic) return { provider: "anthropic", model: ANTHROPIC_MODEL };
  if (openai) return { provider: "openai-compatible", model: OPENAI_MODEL };
  return { provider: "none", model: null };
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
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }
  throw new Error("No LLM configured");
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
  const oaTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await openai.chat.completions.create({ model: OPENAI_MODEL, messages, tools: oaTools, max_tokens: 2000 });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.content) onStep({ type: "text", text: msg.content });
    if (!msg.tool_calls?.length) return msg.content ?? "";
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
