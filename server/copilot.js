// "Ask the tour manager": a tool-using agent wired to the full Qloo MCP tool
// set, primed with the finished tour. Promoters ask follow-ups ("swap Denver
// for somewhere in Texas", "a late-night food spot in Chicago fans love", "who
// else could open in Glasgow?") and the agent answers by calling Qloo, never
// from its own guesses.

import { callQloo, toolSchemas } from "./qloo.js";
import { toolLoop, hasLLM } from "./llm.js";

function compact(envelope) {
  const results = Array.isArray(envelope.results)
    ? envelope.results.slice(0, 10).map((r) =>
        r.location
          ? { lat: r.location.latitude, lng: r.location.longitude, affinity: r.query?.affinity, popularity: r.query?.popularity }
          : { name: r.name, id: r.entity_id ?? r.id, affinity: r.affinity, popularity: r.popularity, address: r.properties?.address },
      )
    : envelope.results?.tags
      ? envelope.results.tags.slice(0, 10).map((t) => ({ tag: t.name, score: t.query?.score }))
      : envelope.series ?? envelope.results;
  return {
    status: envelope.status,
    summary: envelope.summary,
    ...(envelope.resolution?.issues ? { needs_input: envelope.resolution.issues.map((i) => ({ input: i.input, candidates: (i.candidates || []).slice(0, 5) })) } : {}),
    ...(envelope.error ? { error: envelope.error } : {}),
    results,
    mock: envelope.mock || undefined,
  };
}

function tourContext(tour) {
  return {
    act: { name: tour.act.name, qloo_entity_id: tour.act.id, kind: tour.act.kind },
    region: tour.region.label,
    route: tour.route.map((r) => ({ city: r.name, location_query: r.query, score: r.score })),
    dropped: tour.dropped.map((d) => ({ city: d.city, score: d.score })),
    openers: tour.stops.map((s) => ({ city: s.name, opener: s.opener?.name })),
    fan_concepts: tour.profile.tags.slice(0, 8).map((t) => t.name),
  };
}

export async function askCopilot({ tour, question, history = [], emit }) {
  if (!hasLLM()) {
    emit({ type: "answer", text: "The tour-manager chat needs an LLM key (ANTHROPIC_API_KEY or OPENAI_API_KEY) on the server. The tour plan itself is fully available above." });
    return;
  }
  const system = `You are TourSmith, an AI tour manager for live performers. You help a performer or promoter refine a tour plan.
Ground every factual claim about tastes, fans, places, brands or popularity in Qloo tool results from this conversation. If Qloo returns nothing, say so; never invent venues, brands or people.
Qloo results are aggregate audience affinities, not facts about any individual. Phrase them as "fans of X over-index on Y".
Use the act's Qloo entity id as the signal to avoid re-resolving the name. Use the city's location_query string for signal_location or filter_location; use filter_location when you need results physically located in that city (venues, restaurants), and signal_location to bias toward the local audience.
If a tool returns needs_input, pick the obvious candidate or ask the user.
Answer in under 150 words, plain text, short lines. End with the key numbers you relied on.
Current tour: ${JSON.stringify(tourContext(tour))}`;
  const tools = toolSchemas();
  const text = await toolLoop({
    system,
    user: question,
    history: history.slice(-6).map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content).slice(0, 2000) })),
    tools,
    maxTurns: 6,
    exec: async (name, input) => {
      if (!tools.find((t) => t.name === name)) return { status: "error", summary: `Unknown tool ${name}` };
      const { envelope } = await callQloo(name, input);
      return compact(envelope);
    },
    onStep: (s) => {
      if (s.type === "tool_call") emit({ type: "tool", name: s.name, input: s.input });
      if (s.type === "tool_result") emit({ type: "tool_done", name: s.name, status: s.output?.status, summary: s.output?.summary });
    },
  });
  emit({ type: "answer", text });
}
