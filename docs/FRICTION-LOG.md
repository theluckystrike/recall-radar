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

## 6. Identifying a household from a self-hosted MCP server

| Field | Detail |
|---|---|
| Task | keep one private watch list per household across requests. |
| Steps | looked for a stable household id in the request that reaches the MCP server. |
| Expected | the platform sends an Alexa user id with every call, so the server can name the list after it. |
| Actual | the MCP request carries no Alexa user id this repo can rely on. The server accepts an `X-Alexa-User-Id` header, but no code here receives one, so a self-hosted server had to mint its own list id. |
| Severity | high, because the watch list is private and must never be shared between households. |
| Workaround | the watch list is keyed by the server's own id, taken from `X-User-Id`, `X-Alexa-User-Id`, `X-Amazon-User-Id`, `mcp-session-id` or a `user_id` query parameter. The simulator makes one random id, keeps it in browser local storage and sends it as `X-User-Id` with every request. When no id arrives the watch tools refuse the request instead of using one shared list. |
| Suggestion | document the user id header a self-hosted MCP server can expect from Alexa, so the server does not have to invent its own identifier. |

## 7. Proving an MCP Apps card renders on an Alexa+ screen

| Field | Detail |
|---|---|
| Task | show the newest recall as a visual card beside the spoken answer. |
| Steps | built the card as an MCP Apps UI resource at `ui://recall-radar/card` with the `text/html;profile=mcp-app` media type, registered it on the server, and linked it from the search tools and `check_my_watch_list` through the tool `_meta.ui` resource link. |
| Expected | a host with a screen loads the resource and renders the card when the tool runs. |
| Actual | the repo shows the resource, the media type and the tool links, but it holds no proof that any Alexa+ screen renders the card. |
| Severity | medium, because the card is an extra view and the answer must not depend on it. |
| Workaround | the spoken answer is complete on its own and is unchanged, and the newest recall also travels in `structuredContent` so a host that renders the card can draw it, while a voice only client simply speaks the answer. |
| Suggestion | a way to see which MCP App resources an Alexa+ screen will render, and a clear statement of when, so a builder knows whether the card will ever be seen. |

## 8. The NHTSA recalls API answering HTTP 400 for a model with no recalls

| Field | Detail |
|---|---|
| Task | answer whether a car has recalls, from a spoken model year, make and model. |
| Steps | called `https://api.nhtsa.gov/recalls/recallsByVehicle?make=...&model=...&modelYear=...`, and when it returned no recalls, asked `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/{make}/modelyear/{year}?format=json` for that year's model names from that make. |
| Expected | HTTP 200 with a `Count` of 0 when a real model has no recalls, and the same model name the person said. |
| Actual | the recalls API answers HTTP 400 for a real model that has no recalls, such as a 2026 Toyota Camry, and the code reads that 400 as an empty list, `Count` 0, so a 400 alone can never be read as an unknown model. The two APIs also name models differently. vPIC lists `Mazda3` where the person said `3`, and in some families the recalls sit only under a trim, `C300` for a `C-Class`, so an empty result under the spoken name is not proof that the car is unknown or free of recalls. |
| Severity | high, because a false "not found" or "no recalls" on a safety product is the worst answer this tool can give. |
| Workaround | on a 400 or an empty list, confirm the model with vPIC. When vPIC lists the model, accept it. When the vPIC name differs from the spoken one, search the recalls API again under the vPIC name, so `3` finds the recalls filed under `Mazda3`, and the answer names the model that was searched. When vPIC does not list the model, say it is not listed. When vPIC fails, say the vehicle service is unavailable, never unknown and never no recalls. |
| Suggestion | return HTTP 200 with a `Count` of 0 for a valid model that has no recalls, and document that recalls are filed under the vPIC model name, or let a family name be answered with its listed sub-models. |

Built by Michael Lip, github.com/theluckystrike.
