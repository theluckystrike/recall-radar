# Recall Radar

Ask Alexa+ whether something in your home was recalled. Recall Radar is a self-hosted MCP server that checks four official U.S. government recall sources and answers in one short spoken reply. Built by Michael Lip, [github.com/theluckystrike](https://github.com/theluckystrike), for the Amazon Developer Hackathon (Alexa+ track).

"Alexa, is my 2018 Honda Accord recalled?"

> I found 6 recalls for the 2018 Honda Accord. The newest is from May 2026. It affects the air bags. Air bags that deploy unintentionally during a crash increase the risk of injury. Dealers will replace the seat weight sensors, free of charge. There are 5 more. Say "more" to hear the next 4.

## Why

Most people never hear about the recalls that apply to them. Recall notices go out by mail, on agency websites and in press releases, and the products stay in kitchens, nurseries and driveways. The question "is this recalled?" is easy to ask out loud and hard to answer, because the data sits in four different databases with four different formats. A voice assistant is the right place to ask it.

## What it does

| Tool | Source | Ask |
|---|---|---|
| `check_vehicle_recalls` | NHTSA | "Is my 2021 Ford F-150 recalled?" |
| `search_product_recalls` | Consumer Product Safety Commission | "Is the Graco pack and play recalled?" |
| `search_food_recalls` | FDA food enforcement reports | "Any recalls on peanut butter?" |
| `search_drug_recalls` | FDA drug enforcement reports | "Was my ibuprofen recalled?" |
| `check_all_recalls` | CPSC and both FDA lists in parallel | "Any recalls on baby formula?" |

Every tool returns a spoken answer of at most 70 words and the full structured result (title, date, hazard, remedy, official link, severity) for a screen or a follow-up.

## Voice design

- One recall is read in full, the newest one. Then the count of the others and an offer to hear the next few.
- Titles are rewritten for the ear. An NHTSA component such as `AIR BAGS:SENSOR:OCCUPANT CLASSIFICATION` is read as "the air bags". An FDA product description loses its UPC code, net weight and ingredient list.
- Long safety sentences are cut at a natural point ("because", "posing", "which"), never mid-word.
- The answer never says a product is safe. When nothing is found, it says "That does not prove it is safe, only that nothing is listed."
- Medicine answers end with "Ask a pharmacist before you stop taking a medicine."

Serious recalls (FDA Class I, or NHTSA "park it outside") start with the word "Important."

## How it works

```
Alexa+ (or any MCP client) --Streamable HTTP--> /mcp on Cloudflare Workers
                                                  |-- api.nhtsa.gov
                                                  |-- saferproducts.gov (CPSC)
                                                  '-- api.fda.gov (food, drug)
```

- The MCP server is `@modelcontextprotocol/server` 2.3.1 over stateless Streamable HTTP. It serves the 2025-11-25 protocol and the 2026-07-28 revision from one server factory.
- It runs on Cloudflare Workers, with no database, no API keys and no tracking.
- Each source call has a 4-second timeout. CPSC title search is literal, so the server also searches the most distinctive words ("ikea", "malm") in the same parallel round, and keeps only recalls whose title contains those words. "ikea malm dresser" finds the MALM recall, and "uppababy high chair" never returns another brand's high chair.
- The Agent Skill at `skills/recall-radar/SKILL.md` tells an agent which tool to pick and how to read the answer aloud.

Queries are cleaned on the server, so any client can send a whole phrase. The query "is zyrtec safe to take" searches "zyrtec", and an unknown vehicle trim ("accord ex") retries with the model name. A failed source is never reported as "no recalls". The answer names the source it could not reach.

## Alexa+ simulator

The page at `/` simulates an Alexa+ device for judges. You speak (browser speech recognition) or type. A language model (Llama 3.3 70B on Workers AI) reads the MCP tool descriptions and picks the tool and its arguments, the way the Alexa+ model would. The page then calls `/mcp` itself as a real MCP client, sending `initialize`, `notifications/initialized` and `tools/call`. The MCP log on the page shows the routing step and each MCP call with its latency. The reply is read aloud with the browser's speech synthesis.

The model's output is validated before use. If it is invalid, or the demo reaches its daily cap of 200 routing calls, a rule-based router takes over. The simulator also keeps a short conversation. It asks for a missing model year, and "more" reads the next recalls from `structuredContent.followUps`.

## Run it

```bash
npm install
npx wrangler dev          # http://127.0.0.1:8787
npx tsx --test test/*.test.ts             # 66 tests, no network
node test/live-mcp.mjs http://127.0.0.1:8787   # live MCP check against the real sources
```

Deploy with `npx wrangler deploy`. Connect any MCP client to `https://<your-worker>/mcp`.

## Limits

The data covers U.S. recalls only. NHTSA needs a model year. CPSC and FDA searches match words in titles and product descriptions, so a brand name alone can miss a recall listed under a parent company. FDA enforcement reports have no page per recall, so the link goes to the FDA recall search. Recall Radar gives no medical or legal advice.

## License

MIT. Data from NHTSA, the U.S. Consumer Product Safety Commission and the U.S. Food and Drug Administration (public domain). Not affiliated with Amazon, NHTSA, CPSC or FDA.
