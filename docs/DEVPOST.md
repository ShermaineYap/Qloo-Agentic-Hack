# Devpost submission text

Paste each section into the matching Devpost field. Replace the bracketed items.

## Tagline

An AI tour manager that tells performers which cities to play, who should open, and how to sell each night, grounded in Qloo's taste graph.

## Inspiration

Live Nation-scale artists have routing teams, talent buyers and marketers. The long tail of live entertainment doesn't: comedians doing 30 theatres a year, artists with a few hundred thousand listeners, creators taking a podcast on the road. They route by gut feel, book openers they happen to know, and run the same ad in every city. A wrong city costs a venue deposit and a half-empty room.

The core question is "where are this act's fans, and what else do they love there?". That isn't in any LLM's training data. It's what Qloo measures.

## What it does

Type a headliner and a region. TourSmith's agent:

1. Resolves the act in Qloo (and asks the LLM to disambiguate when Qloo returns several matches).
2. Reads the audience: defining concepts, age and gender skew, 20-week momentum.
3. Scores every candidate city with Qloo's heatmap (`affinity` and `popularity` per map cell), plots them live, keeps the strongest markets and cuts the rest with a reason that cites the numbers.
4. Packages every stop with four location-aware Qloo recommendations: local opener candidates, venues and restaurants for pre-show events, brands for sponsorship, podcasts for PR.
5. Ranks one opener shortlist (including the user's own picks) against the headliner's audience in every city, then uses Qloo's audience comparison to show what both fan bases share.
6. Writes city-specific promo copy that may only use names Qloo returned for that city, shown next to the generic copy an LLM writes without data.
7. Publishes a shareable, printable tour page, with an "Ask your tour manager" chat where a tool-using agent answers follow-ups by calling Qloo live.

Every Qloo call appears in the agent log with the exact request it sent.

## How we built it

- Qloo through the official `@qloo/qloo-harness` MCP server (`qloo mcp`), started by our Node backend over stdio. All nine workflows are passed to the LLM as tools; the planning run uses eight of them.
- Claude for disambiguation, route decisions, copy and the chat agent (any OpenAI-compatible model also works).
- Express backend streaming agent events as NDJSON; vanilla JS + Leaflet front end; Docker on [Railway/Render].
- A disk cache in front of Qloo so repeated tours are instant and quota-free, plus a clearly labelled sample-data mode for development.

## What makes it Qloo-powered

Remove Qloo and every decision becomes a guess: which cities, which opener, which venues, which brands. TourSmith uses location as a signal (`signal_location`) to bias recommendations to the local audience and as a filter (`filter_location`) for places that physically exist in the city, ranks a fixed shortlist per city with `qloo_rank` (and compares average positions, since scores from separate calls aren't comparable), and turns heatmap cells into a city score: 75% top-cell affinity plus 25% popularity.

## Challenges

- Heatmaps return geohash cells, not cities, so we score each candidate market with its own heatmap and plot region-wide heat separately.
- Rank scores aren't comparable across calls; we built the opener leaderboard on rank positions instead.
- Keeping the LLM honest: the copy step whitelists references to Qloo's results for that city and drops anything else.

## What's next

Calendar-aware routing with venue capacities, and a two-sided marketplace: performers plan for free, while promoters, venues and brands pay to be matched with the audiences Qloo says they fit.

## Try it

- Demo: [URL] (no login; three tours are pre-planned on the home page, and you can plan a new one)
- Code: https://github.com/ShermaineYap/qloo-agentic-hack (MIT)

## Limits we're upfront about

Qloo results are aggregate audience affinities, not facts about individuals. Candidate cities come from a curated list of touring markets per region. Coverage varies by act; thin results are shown as "not enough Qloo signal", never guessed.
