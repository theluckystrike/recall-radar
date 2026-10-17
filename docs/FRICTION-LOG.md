# Recall Radar friction log

Build Ship Shape Amazon Developer hackathon, Alexa+ track. Each entry follows the format the organisers asked for.

## 1. Serving a 2025-11-25 MCP client with the TypeScript SDK

| Field | Detail |
|---|---|
| Task | list tools from the server with a client that speaks MCP 2025-11-25. |
| Steps | built the server with `createMcpHandler` from `@modelcontextprotocol/server` 2.3.1 on Cloudflare Workers, then sent `initialize` and `tools/list`. |
| Expected | the default mode serves the client, with the supported HTTP methods documented. |
| Actual | it works, but only after reading the handler source did it become clear that the default mode is stateless and answers GET and DELETE with 405. |
| Severity | low. |
| Workaround | read the source; send only POST requests. |
| Suggestion | one table in the docs that lists which HTTP methods each transport mode answers. |

## 2. Searching CPSC recalls by brand and product type

| Field | Detail |
|---|---|
| Task | find a recall from a spoken phrase such as "ikea malm dresser". |
| Steps | called the CPSC Recalls API with the phrase as `RecallTitle`. |
| Expected | a keyword search that finds the IKEA MALM recall. |
| Actual | a literal title match, so the phrase returns nothing while the recall is titled "IKEA Recalls MALM and Other Chests and Dressers". |
| Severity | high for a safety product, because "no results" can be misread as "not recalled". |
| Workaround | search the distinctive words in parallel and keep only titles that contain them; never report a failed or empty search as "safe". |
| Suggestion | document the match rules on the CPSC API page, or offer a keyword mode. |

## 3. An FDA search with no matches

| Field | Detail |
|---|---|
| Task | handle a food or drug search that finds nothing. |
| Steps | called openFDA enforcement reports with a rare term. |
| Expected | HTTP 200 with an empty result list. |
| Actual | HTTP 404 with an error body. |
| Severity | medium. |
| Workaround | map 404 NOT_FOUND to zero results, and treat every other error as a failed source. |
| Suggestion | return 200 with an empty list, or document the 404 clearly next to the query examples. |

## 4. Running the Worker locally

| Field | Detail |
|---|---|
| Task | start the local dev server. |
| Steps | ran `wrangler dev`. |
| Expected | the server on port 8787. |
| Actual | "Address already in use", because another process held the default port. |
| Severity | low. |
| Workaround | pass a different port. |
| Suggestion | offer the next free port automatically. |

## 5. Testing voice behaviour on real Alexa+

| Field | Detail |
|---|---|
| Task | hear the spoken answers on a real Alexa+ device. |
| Steps | looked for a way to connect a self-hosted MCP server to Alexa+ outside the preview. |
| Expected | a developer test path. |
| Actual | none available, so the voice behaviour is simulated in the browser with the same MCP calls. |
| Severity | medium. |
| Workaround | an Alexa+ simulator page that routes speech to the MCP tools the way the Alexa+ model would, with system text-to-speech. |
| Suggestion | a public test endpoint or sandbox for self-hosted MCP servers on Alexa+. |

Built by Michael Lip, github.com/theluckystrike.
