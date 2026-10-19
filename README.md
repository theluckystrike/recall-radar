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
| `search_product_recalls` | Consumer Product Safety Commission | "Is the IKEA MALM dresser recalled?" |
| `search_food_recalls` | FDA food enforcement reports | "Any recalls on peanut butter?" |
| `search_drug_recalls` | FDA drug enforcement reports | "Was my ibuprofen recalled?" |
| `check_all_recalls` | CPSC and both FDA lists in parallel | "Any recalls on infant formula?" |
| `add_to_watch_list` | Saves a vehicle, product, food or medicine for later checks | "Add my 2018 Honda Accord to my watch list" |
| `remove_from_watch_list` | Removes one saved item | "Remove the crib from my list" |
| `check_my_watch_list` | Checks every saved item and reports only new recalls | "Check my watch list" |

Every tool returns a spoken answer of at most 70 words and the full structured result (title, date, hazard, remedy, official link, severity) for a screen or a follow-up.

The newest recall is also offered as a visual recall card, an MCP Apps UI resource at `ui://recall-radar/card` with the `text/html;profile=mcp-app` media type. The search tools and `check_my_watch_list` point at it through their tool metadata, and each result carries the newest recall in `structuredContent`, so a screen or an MCP App host can show the title, date, source, severity, hazard, remedy and the official link beside the spoken answer. The card is one small self-contained HTML document with inline styles only, no network scripts and no tracking, and the spoken answers are unchanged.

## Voice design

- One recall is read in full, the newest one. Then the count of the others and an offer to hear the next few.
- Titles are rewritten for the ear. An NHTSA component such as `AIR BAGS:SENSOR:OCCUPANT CLASSIFICATION` is read as "the air bags". An FDA product description loses its UPC code, net weight and ingredient list.
- Long safety sentences are cut at a natural point ("because", "posing", "which"), never mid-word.
- The answer never says a product is safe. When nothing is found, it says "That does not prove it is safe, only that nothing is listed."
- Medicine answers end with "Ask a pharmacist before you stop taking a medicine."

Serious recalls (FDA Class I, or NHTSA "park it outside") start with the word "Important."

## Watch list

A household can save up to 10 vehicles, products, foods or medicines. Each user id has its own Durable Object, a small SQLite-backed store on Cloudflare Workers, found by `idFromName` of the sanitised user id. Each add and each remove is one call, so it sees the list as it stands when that call runs. A check re-reads the list after its slow lookups and merges the seen recall ids by item id, so an add or a remove made while a check was running is kept. The simulator creates a random id once, keeps it in the browser local storage and sends it with every request. An Alexa client can send `X-Alexa-User-Id`, and an MCP client can send `X-User-Id` or a `user_id` query parameter. When the `WATCH` binding is absent, for example in tests or local dev without it, an in-memory store per user id stands in.

`check_my_watch_list` checks every saved item in parallel, reports only recall ids it has not reported for that item before, and answers in the same short spoken style. If a source fails, the answer says that source was unavailable and never reports it as no recalls.

## How it works

```
Alexa+ (or any MCP client) --Streamable HTTP--> /mcp on Cloudflare Workers
                                                  |-- api.nhtsa.gov
                                                  |-- saferproducts.gov (CPSC)
                                                  '-- api.fda.gov (food, drug)
```

- The MCP server is `@modelcontextprotocol/server` 2.3.1 over stateless Streamable HTTP. It serves the 2025-11-25 protocol and the 2026-07-28 revision from one server factory.
- It runs on Cloudflare Workers, with a Durable Object per user for the watch list, a small KV namespace for the routing limit, no API keys and no tracking.
- Each request runs inside the 300 ms CPU limit set in `wrangler.jsonc`. A source response is reduced to at most 5 recalls, with a 120 character title and 300 character hazard and remedy, so the large CPSC response is parsed well inside that limit.
- Each source call has a 4-second timeout. CPSC title search is literal, so the server also searches the most distinctive words ("ikea", "malm") in the same parallel round, and keeps only recalls whose title contains those words. "ikea malm dresser" finds the MALM recall, and "uppababy high chair" never returns another brand's high chair.
- The Agent Skill at `skills/recall-radar/SKILL.md` tells an agent which tool to pick and how to read the answer aloud.

Queries are cleaned on the server, so any client can send a whole phrase. The query "is zyrtec safe to take" searches "zyrtec", and an unknown vehicle trim ("accord ex") retries with the model name. A failed source is never reported as "no recalls". The answer names the source it could not reach.

## Alexa+ simulator

The page at `/` simulates an Alexa+ device for judges. You speak (browser speech recognition) or type. A language model (Llama 3.3 70B on Workers AI) reads the MCP tool descriptions and picks the tool and its arguments, the way the Alexa+ model would. The page then calls `/mcp` itself as a real MCP client, sending `initialize`, `notifications/initialized` and `tools/call`. The MCP log on the page shows the routing step and each MCP call with its latency. The reply is read aloud with the browser's speech synthesis.

The model's output is validated before use. If it is invalid, or the demo reaches its daily cap of 200 routing calls, a rule-based router takes over. The simulator also keeps a short conversation. It asks for a missing model year, and "more" reads the next four recalls from `structuredContent.followUps`. Built with Llama.

## Run it

Install the dependencies with `npm install`. Sign in to Cloudflare once with `npx wrangler login`. Create the KV namespace with `npx wrangler kv namespace create LIMITS`, then put the printed id in the `kv_namespaces` entry in `wrangler.jsonc`. The routing limit uses that binding. The watch list uses the `WATCH` Durable Object declared under `durable_objects` and `migrations` in `wrangler.jsonc`, and Wrangler creates it on the first deploy. Start the local server with `npx wrangler dev` and open http://127.0.0.1:8787. If the `AI` binding is not configured, the simulator uses the rule router.

```bash
npm install
npx wrangler kv namespace create LIMITS
npx wrangler dev          # http://127.0.0.1:8787
npx tsx --test test/*.test.ts             # 143 tests, no network
node test/live-mcp.mjs http://127.0.0.1:8787   # live MCP check against the real sources
```

Deploy with `npx wrangler deploy`. Connect any MCP client to `https://<your-worker>/mcp`.

## Limits

The data covers U.S. recalls only. NHTSA needs a model year. CPSC and FDA searches match words in titles and product descriptions, so a brand name alone can miss a recall listed under a parent company. FDA enforcement reports have no page per recall, so the link goes to the FDA recall search. Recall Radar gives no medical or legal advice.

The user id acts like a bearer secret. Anyone who knows a user id can read and change that watch list, so treat it like a password and do not share it. When no user id arrives, the watch tools refuse the request instead of falling back to a shared list.

## License

MIT. Data from NHTSA, the U.S. Consumer Product Safety Commission and the U.S. Food and Drug Administration (public domain). Not affiliated with Amazon, NHTSA, CPSC or FDA.
