# TourSmith

**An AI tour manager for comedians, musicians and creators.** Type a headliner and a region. TourSmith's agent uses Qloo's taste graph to decide which cities to play and which to cut, who should open in each city, which comedy clubs or music venues, bars, brands and podcasts the same fans love, and what to say to sell each night. The result is a shareable tour page a performer can send straight to a promoter.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/) (Sept 30 – Oct 30, 2026).

- **Live demo:** _add your deployed URL here_
- **License:** MIT

## What it finds that an LLM can't

Ask a chatbot to route a US tour for Nate Bargatze and you get New York, LA and Chicago. Qloo's heatmap says otherwise. Across 7,783 grid cells, his fans over-index most around Nashville (100), Salt Lake City (99), Denver (99), Austin (98) and Kansas City (98). New York (55) and Los Angeles (61) come last on affinity, even though they have the most raw activity. TourSmith routes Phoenix → Salt Lake City → Denver → Kansas City → Nashville → Austin.

In each city it then names real rooms (Comedy Works and Denver Improv in Denver; Esther's Follies and The Velveeta Room in Austin). It picks an opener the fans also love who won't outshine the headliner: Sam Morril ranks first in all six cities. It also suggests sponsor brands the audience over-indexes on (Faherty, Vuori) and the podcasts they listen to.

## The problem

Mid-tier performers (a comedian doing 30 theatres a year, an artist with a few hundred thousand monthly listeners) don't have a promoter's routing team. They pick cities by gut feel and streaming stats, book openers they happen to know, and run the same ad in every city. A bad city costs a venue deposit, travel and a half-empty room.

## What the agent does

Every step is a live Qloo call, streamed into the "What the agent is doing" log with the exact request it sent.

| Step | Question | Qloo call |
| --- | --- | --- |
| Identify the headliner | Which entity is this? Qloo often has a name as both `person` and `artist`; the LLM picks the right one, and the agent switches entries if the first has no heat data | `qloo_describe` (MCP) |
| Find the fans | One heatmap of the whole region (thousands of grid cells), then every candidate city scored from the same grid | Insights API `urn:heatmap` with a WKT boundary |
| Read the audience | What defines the fan base, who they are, whether they're trending | `qloo_entity_tags`, `qloo_audience_demographics`, `qloo_trends` (MCP) |
| Route decision | Keep the strongest markets, cut the rest with reasons that cite the numbers, order the route geographically | LLM over the heatmap evidence |
| Package each stop | Opener pool, comedy clubs or live music venues, bars and restaurants, sponsor-fit brands, podcasts | `qloo_recommend` ×5 per city, with `signal_location` / `filter_location` and Qloo category tags (MCP) |
| Choose openers | Shortlist peers less popular than the headliner, then rank the same shortlist against the headliner's audience in every city | `qloo_rank` per city (MCP) |
| Explain the pick | Which tastes do both fan bases share? | `qloo_compare_audiences` (MCP) |
| Sell each night | City copy that may only name things Qloo returned for that city, next to the generic copy an LLM writes without data | LLM with a reference whitelist |
| Ask your tour manager | Follow-ups ("which Chicago club for a seventh date?") answered by a tool-using agent with all nine Qloo tools | LLM tool loop over `qloo mcp` |

A six-city tour makes about 42 Qloo calls. Every result is cached on disk, so a repeated tour is instant and costs no quota.

### City score

`fan affinity = 100 × mean of the top 3 heatmap cells' affinity within 50 km of the city`

Qloo's heatmap `affinity` measures how strongly an act over-indexes in a cell compared with everything else people there engage with. Inside a single query it's ranked across the whole grid. That's why TourSmith pulls one heatmap for the whole region instead of one per city: per-city heatmaps are each ranked separately and can't be compared. `popularity` (signal density) is shown as scene size.

Rank scores from separate `qloo_rank` calls aren't comparable either, so the opener leaderboard uses average rank position across cities.

## Architecture

```
browser ──fetch (NDJSON stream)──▶ Express server ──stdio MCP──▶ qloo mcp (@qloo/qloo-harness) ──▶ Qloo API
                                        ├──HTTPS──▶ Qloo Insights API (region heatmap)
                                        └──▶ Gemini / Claude / any OpenAI-compatible LLM
```

- `server/pipeline.js`: the tour-planning agent run.
- `server/copilot.js`: the "Ask your tour manager" tool-using agent.
- `server/qloo.js`: starts `qloo mcp`, passes its tool schemas to the LLM, makes the region heatmap call, caches results and limits concurrency.
- `server/cities.js`: candidate markets and region boundaries, plus city scoring.
- `server/llm.js`: Gemini, Anthropic or OpenAI-compatible adapter with a tool-use loop. Falls back across Gemini models when one is overloaded.
- `server/mock.js`: clearly labelled sample data for development without a key.
- `public/`: the web app (vanilla JS + Leaflet, no build step). `/tour/:id` is the shareable tour page.

The Qloo key stays on the server; the browser never calls Qloo.

## Run it locally

Requires Node.js 22.19 or newer.

```sh
npm install --global @qloo/qloo-harness   # the official Qloo CLI + MCP server
git clone https://github.com/ShermaineYap/qloo-agentic-hack && cd qloo-agentic-hack
npm install
cp .env.example .env                       # add QLOO_API_KEY and GEMINI_API_KEY
npm run check                              # confirms the key works and the demo acts have heat data
npm start                                  # http://localhost:3000
```

Hackathon keys use Qloo's hackathon server, so `.env` sets `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` to `https://hackathon.api.qloo.com`.

No Qloo key? `npm run mock` runs the whole app on sample data, marked as such everywhere in the UI. No LLM key? Route decisions fall back to the scores, copy falls back to templates, and the chat panel says it needs a key.

## Deploy

`qloo mcp` is a long-running stdio process, so deploy to a container host, not serverless.

**Railway:** New project → Deploy from GitHub repo → it uses `Dockerfile` and `railway.json`. Add the variables `QLOO_API_KEY`, `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL` and `GEMINI_API_KEY`. Then generate a public domain under Settings → Networking.

**Render:** New → Blueprint → this repo (uses `render.yaml`). Set the two secret keys when prompted. Avoid the free plan for judging: it sleeps after 15 minutes.

The demo tours in `data/` were pre-run against live Qloo, so they load instantly and don't use quota. Refresh them with `npm run warm`.

## Responsible use

Qloo results describe aggregate audience affinities, not individuals, and the UI says so. No personal data is sent to Qloo: inputs are performer names, cities and Qloo tag IDs. The public demo rate-limits new tours per visitor to protect the event quota.

## Known limitations

- Candidate cities come from a curated list of touring markets per region (`server/cities.js`). TourSmith scores and cuts them but won't discover a market outside the list.
- Route order is geographic (nearest-neighbour), not calendar-aware; a promoter still sets dates and holds.
- Qloo publishes weekly trend data for artists but not for people, so comedians show no trend line.
- Coverage varies by act. Cities with too little signal are shown as such, never guessed.
