# TourSmith

**An AI tour manager for comedians, musicians and creators.** Type a headliner and a region; TourSmith's agent uses Qloo's taste graph to decide which cities to play, which to cut, who should open in each city, which local venues, brands and podcasts the same fans love, and what to say to sell each night. The result is a shareable tour page a performer can send straight to a promoter.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/) (Sept 30 – Oct 30, 2026).

- **Live demo:** _add your deployed URL here_
- **License:** MIT

## The problem

Mid-tier performers (a comedian doing 30 theatres a year, an artist with a few hundred thousand monthly listeners) don't have a promoter's routing team. They pick cities by gut feel and streaming stats, book openers they happen to know, and run the same ad in every city. A bad city costs a venue deposit, travel and a half-empty room; generic marketing leaves tickets unsold.

An LLM on its own can't fix this. "Where do this comedian's fans actually over-index, and what else do they love in Nashville versus Manchester?" isn't in any model's training data. It is exactly what Qloo's taste graph measures.

## What the agent does

Each step below is a live Qloo call, streamed into the "What the agent is doing" log with the exact request it sent.

| Step | Question | Qloo workflow (via `qloo mcp`) |
| --- | --- | --- |
| Identify the headliner | Which entity is this? (asks the LLM to disambiguate if Qloo returns several) | `qloo_describe` |
| Read the audience | What defines the fan base? Who are they? Rising or cooling? | `qloo_entity_tags`, `qloo_audience_demographics`, `qloo_trends` |
| Find the fans on the map | Where in the region does this act over-index? Score every candidate city | `qloo_where_popular` (region heatmap + one per city) |
| Route decision | Keep the strongest markets, cut the rest with reasons, order the route | agent decision over the heatmap evidence |
| Package each stop | Local opener candidates, pre-show venues and restaurants, sponsor-fit brands, podcasts for PR | `qloo_recommend` with `signal_location` / `filter_location`, 4 per city |
| Choose openers | Rank one shortlist (plus the user's own picks) against the headliner's audience in every city | `qloo_rank` per city |
| Explain the pick | What taste do both fan bases share? | `qloo_compare_audiences` |
| Sell each night | City-specific copy that may only use names Qloo returned for that city, shown next to the generic copy an LLM writes without data | LLM with a reference guardrail |
| Ask your tour manager | Follow-up questions answered by a tool-using agent with all nine Qloo tools | LLM tool loop over `qloo mcp` |

A typical six-city tour makes about 45 Qloo calls. Every result is cached on disk, so a repeated tour is instant and costs no quota.

### Why it doesn't work without Qloo

Remove Qloo and every one of those decisions becomes an LLM guess: invented cities, invented openers, invented venues. The copy guardrail drops any reference that didn't come from Qloo for that city, and the agent prompt forbids naming anything Qloo didn't return.

### City score

`score = 100 × (0.75 × mean affinity of the city's top 5 heatmap cells + 0.25 × mean popularity)`

Qloo's heatmap `affinity` compares the act with everything else people in that place engage with, so it is comparable across cities. `popularity` is the act's signal density there. Rank scores from separate `qloo_rank` calls aren't comparable, so the opener leaderboard uses average rank position across cities instead.

## Architecture

```
browser ──fetch (NDJSON stream)──▶ Express server ──stdio MCP──▶ qloo mcp (@qloo/qloo-harness) ──▶ Qloo API
                                        │
                                        └──▶ Claude (or any OpenAI-compatible LLM) for decisions, copy and chat
```

- `server/pipeline.js`: the tour-planning agent run and scoring.
- `server/copilot.js`: the "Ask your tour manager" tool-using agent.
- `server/qloo.js`: starts `qloo mcp`, passes its tool schemas to the LLM, caches results, limits concurrency.
- `server/llm.js`: Anthropic or OpenAI-compatible adapter with a tool-use loop.
- `server/mock.js`: clearly labelled sample data for development before a key arrives.
- `public/`: the web app (vanilla JS + Leaflet, no build step). `/tour/:id` is the shareable tour page.

The Qloo key stays on the server; the browser never calls Qloo.

## Run it locally

Requires Node.js 22.19 or newer.

```sh
npm install --global @qloo/qloo-harness   # the official Qloo CLI + MCP server
qloo setup --qloo                          # paste the event credential (or set QLOO_API_KEY)
git clone https://github.com/ShermaineYap/qloo-agentic-hack && cd qloo-agentic-hack
npm install
cp .env.example .env                       # add ANTHROPIC_API_KEY (or an OpenAI-compatible key)
npm run check                              # confirms the key works and the demo acts have Qloo coverage
npm start                                  # http://localhost:3000
```

No Qloo key yet? `npm run mock` runs the whole app on sample data, marked as such everywhere in the UI.

Without an LLM key TourSmith still works: route decisions fall back to the scores, copy falls back to templates, and the chat panel says it needs a key.

## Deploy

`qloo mcp` is a long-running stdio process, so deploy to a container host, not serverless.

**Railway:** New project → Deploy from GitHub repo → it picks up `Dockerfile` and `railway.json`. Add `QLOO_API_KEY` and `ANTHROPIC_API_KEY` as variables. Generate a public domain.

**Render:** New → Blueprint → this repo (uses `render.yaml`). Set the two secrets when prompted. Avoid the free plan for judging: it sleeps after 15 minutes.

Before submitting, run `npm run warm` locally with the key set, then commit `data/`. That pre-runs the demo tours, so judges see them instantly and the public demo never burns quota on them.

## Responsible use

Qloo results describe aggregate audience affinities, not individuals, and TourSmith says so in the UI. No personal data is sent to Qloo: inputs are performer names, cities and taste concepts. The public demo rate-limits new tours per visitor to protect the event quota.

## Known limitations

- Candidate cities come from a fixed list of touring markets per region (`server/cities.js`); TourSmith scores and cuts them but won't discover a market outside the list.
- Route order is geographic (nearest-neighbour), not calendar-aware; a promoter still sets dates and holds.
- Data coverage varies by act and city. Thin results are shown as "not enough Qloo signal" rather than guessed.
