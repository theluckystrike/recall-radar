# Recall Radar Devpost submission text

## Project name
Recall Radar

## Elevator pitch (200 characters)
Ask Alexa+ "is my car, crib, food or medicine recalled?" and get one short spoken answer from NHTSA, CPSC and FDA data, through a self-hosted MCP server.

## Track
Primary track: Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP, plus an Agent Skill). Mini challenge: none.

## About the project

### Inspiration
Recalls reach people by mail, on agency websites and in press releases. Most people never connect a notice to the car in their driveway or the crib in the nursery. "Is this recalled?" is a question you can ask out loud in a few seconds, but the answer sits in four government databases with four different formats. That gap fits a voice assistant well.

### What it does
Recall Radar is an MCP server with five tools: vehicle recalls (NHTSA, by year, make and model), consumer product recalls (CPSC), food recalls and drug recalls (FDA enforcement reports), and one tool that checks product, food and drug lists together. Each tool returns a spoken answer of at most 70 words and the full structured details: title, date, hazard, remedy, severity and the official link.

### How we built it
The server uses the MCP TypeScript SDK 2.3.1 with stateless Streamable HTTP on Cloudflare Workers. One server factory serves 2025-11-25 clients and the 2026-07-28 revision. Each government source has its own normaliser with a 4-second timeout. A voice layer rewrites agency text for the ear: one recall in full, plain titles, safety sentences cut at a natural point, and a fixed 70-word budget. An Agent Skill (SKILL.md) tells an agent which tool to choose and how to read the answer.

The Alexa+ simulator at the root URL takes speech or text. A language model (Llama 3.3 on Workers AI) reads the MCP tool descriptions and picks the tool, the way the Alexa+ model would, and the page calls /mcp itself as a real MCP client. Its MCP log shows the routing step and each MCP call with its latency.

### Challenges we ran into
The four sources disagree on almost everything: date formats (DD/MM/YYYY, YYYYMMDD, ISO), what "no results" means (an empty list or HTTP 404), and how much text a title holds. CPSC title search is literal, so "ikea malm dresser" finds nothing while the recall is titled "IKEA Recalls MALM and Other Chests and Dressers". The server now searches the distinctive words in parallel and keeps only titles that contain them.

The hardest part was safety. Two independent adversarial reviews showed that a phrase router sent "cucumbers" to the product database and answered "no recalls" while the FDA lists 60. That is the worst possible failure for this product, so routing moved to a language model reading the tool descriptions (0 wrong on 44 fresh test phrasings), and the server never reports a failed source as "no recalls". The first voice answers ran past 150 words and read agency abbreviations aloud; a separate voice layer with its own tests fixed that.

### Accomplishments we are proud of
The server never says a product is safe. When nothing is found it says that nothing is listed. Every answer comes from live government data. The test suite has 66 tests and runs without network access.

### What we learned
Writing for the ear is a separate skill from writing for a screen. A good spoken answer chooses what to leave out.

### What is next
A "watch list": a household names its car and products once, and Recall Radar tells them when a new recall appears.

## Product feedback (required)

| Tool or API | What I used it for | What worked | What needs work | Build with it again |
|---|---|---|---|---|
| MCP TypeScript SDK 2.3.1 (`@modelcontextprotocol/server`) | Stateless Streamable HTTP server on Workers | `createMcpHandler` serves 2025-era and 2026 clients from one factory; zod schemas give clean tool definitions | The package exports two transport families; the docs for picking one on a fetch runtime are thin | Yes |
| Alexa+ (simulated path) | Target experience and tool design | The MCP route means one server works for Alexa+ and any other agent | No public way to test against real Alexa+ outside the preview, so voice behaviour is simulated | Yes |
| Cloudflare Workers and Workers AI | Hosting the MCP endpoint and the simulator; Llama 3.3 picks the tool in the simulator | Fast deploys, static assets next to the endpoint; tool choice from descriptions was accurate | Local dev failed once because another process held the default port 8787; a 100 ms CPU limit silently failed a 700 KB CPSC parse | Yes |
| NHTSA, CPSC and FDA APIs | Recall data | Keyless, fast (0.3 to 1.4 s), current | CPSC title search is literal; FDA returns 404 for "no match"; CPSC can return 600 KB | Yes |

## Friction log

1. Task: list tools from the server with a 2025-11-25 client. Expected: the SDK default to serve it. Actual: it does, but only after reading the handler source to learn that the default "legacy" mode is stateless and answers GET and DELETE with 405. Severity: low. Suggestion: one table in the docs of which methods each mode answers.
2. Task: search CPSC for a product by brand and type. Expected: a keyword search. Actual: a literal title match, so a brand plus a product type often returns nothing. Severity: high for a safety use case, because "no results" can be misread. Workaround: narrow the phrase and tell the user which phrase matched. Suggestion: document the match rules on the CPSC API page.
3. Task: treat an FDA search with no matches. Expected: an empty result list. Actual: HTTP 404 with an error body. Severity: medium. Workaround: map 404 NOT_FOUND to zero results.
4. Task: run the Worker locally. Expected: dev server on port 8787. Actual: "Address already in use". Severity: low. Workaround: pass a different port to wrangler dev. Suggestion: wrangler could offer the next free port.

## Built with
TypeScript, Model Context Protocol, Cloudflare Workers, Workers AI (Llama 3.3), NHTSA API, CPSC Recalls API, openFDA, Web Speech API.

## Links
- Live server and simulator: https://recall-radar.lipmichal.workers.dev (MCP endpoint: /mcp)
- Code: https://github.com/theluckystrike/recall-radar
- Demo video: (YouTube link, to add)

Built by Michael Lip, github.com/theluckystrike.
