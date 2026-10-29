# Devpost submission text

Paste each section into the matching Devpost field. Replace [DEMO URL] once deployed.

## Project name

TourSmith

## Tagline

An AI tour manager that tells performers which cities to play, who should open, and how to sell each night, grounded in Qloo's taste graph.

## Inspiration

Arena-level artists have routing teams, talent buyers and marketers. The long tail of live entertainment doesn't: comedians doing 30 theatres a year, artists with a few hundred thousand listeners, podcasts taking the show on the road. They route by gut feel and streaming stats, book openers they happen to know, and run the same ad in every city. A wrong city costs a venue deposit and a half-empty room.

The core question is "where do this act's fans over-index, and what else do they love there?". That isn't in any LLM's training data. It's what Qloo measures.

## What it does

Type a headliner and a region. TourSmith's agent:

1. Resolves the act in Qloo. Many performers exist as both a `person` and an `artist`; the agent picks the right entry, and switches if that entry has no data.
2. Pulls one Qloo heatmap across the whole region (7,783 grid cells for the US) and scores every candidate city from the same grid, so scores are comparable.
3. Keeps the strongest markets and cuts the rest, with a reason for each that cites the numbers.
4. Packages every stop with five location-aware Qloo recommendations: an opener pool, comedy clubs or live music venues, bars and restaurants for a pre-show, sponsor-fit brands, and podcasts for local PR.
5. Shortlists openers less popular than the headliner, ranks the same shortlist against the headliner's audience in every city, and shows the tastes both fan bases share.
6. Writes city copy that may only name things Qloo returned for that city, shown next to the generic copy an LLM writes without data.
7. Publishes a shareable, printable tour page with an "Ask your tour manager" chat, where a tool-using agent answers follow-ups by calling Qloo live.

Example, Nate Bargatze across the US: a chatbot says New York, LA, Chicago. Qloo says his fans over-index most around Nashville (100), Salt Lake City (99), Denver (99), Austin (98) and Kansas City (98); New York (55) and LA (61) come last despite the most raw activity. TourSmith routes Phoenix → Salt Lake City → Denver → Kansas City → Nashville → Austin. It names real rooms (Comedy Works and Denver Improv in Denver; Esther's Follies and The Velveeta Room in Austin) and picks Sam Morril as the opener, ranked first in all six cities.

## How we built it

- Qloo through the official `@qloo/qloo-harness` MCP server (`qloo mcp`), started by a Node backend over stdio. All nine Qloo workflows are passed to the chat agent as tools; the planning run uses describe, entity tags, demographics, trends, recommend, rank and compare.
- The region heatmap goes straight to the Insights API (`urn:heatmap` with a WKT boundary). That returns the full grid, which makes cross-city scores comparable.
- Gemini for entity disambiguation, route decisions, copy and the chat agent. Claude or any OpenAI-compatible model also works, and it falls back across Gemini models when one is overloaded.
- Express streaming agent events as NDJSON, a vanilla JS + Leaflet front end, Docker on [Railway/Render].
- A disk cache in front of Qloo, so the demo tours load instantly and spend no quota.

## What makes it Qloo-powered

Remove Qloo and every decision becomes a guess: which cities, which opener, which rooms, which brands. TourSmith uses:

- Location as a signal (`signal_location`), to bias toward the local audience.
- Location as a filter (`filter_location`), for places that physically exist in the city.
- Qloo category tags (`comedy_club`, `live_music_venue`, `bar`, `restaurant`), to find the right kind of place.
- Popularity, to keep openers below the headliner's draw.
- Rank positions rather than raw scores, because scores from separate calls aren't comparable.

## Challenges we ran into

- **Ambiguous names.** Nate Bargatze is both a `person` and an `artist` in Qloo, and only the `person` entry has heatmap data. The agent now detects that and switches entries.
- **City scores weren't comparable.** Heatmap affinity is ranked within each query, so per-city heatmaps can't be compared; a single region-wide grid fixed it.
- **Noisy fan-base tags.** Fan-base tags include venue attributes ("Salad", "Three Star"), so we filter tag types to taste concepts.
- **Keeping the LLM honest.** The copy step whitelists references to Qloo's results for that city and drops anything else.

## What's next

Calendar-aware routing with venue capacities, and a two-sided marketplace: performers plan for free, while promoters, venues and brands pay to be matched with the audiences Qloo says they fit.

## Try it

- Demo: [DEMO URL] (no login; three tours are pre-planned on the home page, and you can plan a new one)
- Code: https://github.com/ShermaineYap/qloo-agentic-hack (MIT)

## Limits we're upfront about

- Qloo results are aggregate audience affinities, not facts about individuals.
- Candidate cities come from a curated list of touring markets per region.
- Qloo has no weekly trend data for people, so comedians show no trend line.
