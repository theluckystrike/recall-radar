# Recall Radar: specification (Amazon Developer Hackathon, Alexa+ track)

Recall Radar is a self-hosted MCP server (Streamable HTTP, protocol 2025-11-25 and later) for Alexa+. A household asks by voice
"Is my 2018 Honda Accord recalled?", "Is the Graco crib recalled?", "Any recalls on peanut butter?", "Was my ibuprofen recalled?".
Recall Radar searches 4 official, keyless US government sources and returns a short spoken answer plus structured details.

Runtime: Cloudflare Workers (TypeScript, ESM). No database. No paid API. No API keys. Node 24 toolchain for tests.
Run tests: `PATH=$HOME/paybox-hackathon-2026-10-17/.node/node-v24.21.0-darwin-arm64/bin:$PATH npx tsx --test test/<file>.test.ts`.
Type check: `npx tsc --noEmit`. Tests use `node:test` + `node:assert/strict` and NEVER hit the network: inject a fake fetch.

## Shared contract (src/types.ts, owned by the orchestrator, do not edit)

```ts
export type Source = "nhtsa" | "cpsc" | "fda-food" | "fda-drug";
export interface Recall {
  source: Source;
  id: string;            // campaign / recall number from the source
  date: string;          // ISO date YYYY-MM-DD (recall or report date)
  title: string;         // short product name, max 120 chars
  hazard: string;        // what can go wrong, plain text, max 300 chars
  remedy: string;        // what to do, plain text, max 300 chars ("" if unknown)
  url: string;           // official page for this recall
  severity?: "high" | "medium" | "low"; // FDA Class I = high, II = medium, III = low; NHTSA parkIt/parkOutSide = high
}
export interface SearchResult { query: string; source: Source; total: number; recalls: Recall[] } // newest first, max 5
export class SourceError extends Error {}   // network failure, timeout, bad response
export const FETCH_TIMEOUT_MS = 4000;
```

## Sources (exact endpoints, all GET, all keyless)

- NHTSA vehicles: `https://api.nhtsa.gov/recalls/recallsByVehicle?make=<make>&model=<model>&modelYear=<year>`.
  Response `{Count, results:[{NHTSACampaignNumber, ReportReceivedDate "DD/MM/YYYY", Component, Summary, Consequence, Remedy, parkIt, parkOutSide}]}`.
  url = `https://www.nhtsa.gov/recalls?nhtsaId=<NHTSACampaignNumber>`. title = `<Component> (<year> <Make> <Model>)`. hazard = Consequence (fallback Summary).
- CPSC consumer products: `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallTitle=<query>`.
  Response: array of `{RecallNumber, RecallDate "YYYY-MM-DDT00:00:00", Title, Description, URL, Hazards:[{Name}], Remedies:[{Name}], Products:[{Name}]}`.
  The response can be 600 KB. Sort by RecallDate desc, keep 5. hazard = Hazards[0].Name, remedy = Remedies[0].Name.
- FDA food: `https://api.fda.gov/food/enforcement.json?search=product_description:"<query>"&sort=report_date:desc&limit=5`.
  FDA drug: same with `/drug/enforcement.json`. Response `{meta:{results:{total}}, results:[{recall_number, report_date "YYYYMMDD", product_description, reason_for_recall, classification "Class I|II|III", status, recalling_firm}]}`.
  A search with no match returns HTTP 404 with `{error:{code:"NOT_FOUND"}}`: that is total 0, not an error. url = `https://www.accessdata.fda.gov/scripts/ires/index.cfm` (FDA has no per-recall page; also return recall_number as id).
  Encode the query with encodeURIComponent and keep the double quotes. Strip characters other than letters, digits, spaces, hyphens and apostrophes from user queries first (max 60 chars).

All sources: every fetch uses AbortSignal.timeout(FETCH_TIMEOUT_MS); throw SourceError on network failure, timeout, non-JSON or HTTP status other than 200 (and 404 for FDA). Trim text fields, collapse whitespace, cap lengths.

## Modules and owners

| File | Owner | Exports |
|---|---|---|
| src/sources/nhtsa.ts + test/nhtsa.test.ts | W1 | `searchVehicle(make, model, year, fetchFn?): Promise<SearchResult>`; year must be 1950..(current year + 1), else throw RangeError |
| src/sources/cpsc.ts, src/sources/fda.ts + tests | W2 | `searchProducts(query, fetchFn?)`, `searchFood(query, fetchFn?)`, `searchDrug(query, fetchFn?)` |
| src/speech.ts + test/speech.test.ts | W3 | `speak(result: SearchResult): string` and `speakMany(results: SearchResult[]): string` (see Voice rules) |
| src/router.ts + test/router.test.ts | W3 | `route(utterance: string): {tool: string, args: Record<string,string|number>} | null` (see Router) |
| web/index.html, web/app.js, web/styles.css | W4 | Alexa+ simulator page (see Simulator) |
| src/types.ts, src/server.ts, src/worker.ts, skills/ | orchestrator | MCP tools, HTTP routing, Agent Skill |

## Voice rules (speech.ts)

The answer is read aloud by Alexa+. Max 2 sentences per recall, max 3 recalls spoken, about 60 words in total.
- 0 recalls: "I found no recalls for <query> in <source name>." Never claim the product is safe.
- 1 or more: "I found <total> recall(s) for <query>. The most recent, from <Month YYYY>: <title>. <hazard, first sentence>. <remedy, first sentence if any>."
- When total > 1, end with "Say 'more' to hear the others." Source names: NHTSA = "the NHTSA vehicle database", CPSC = "the Consumer Product Safety Commission", FDA = "the FDA".
- High severity first word: "Important." before the recall sentence. No abbreviations a voice cannot read: write "Class 1" as "the most serious class".
Test exact strings for 0, 1, 3 and 6 recalls, missing remedy, very long hazard (cut at a sentence end before 200 chars).

## Router (router.ts)

Turns a spoken sentence into one tool call, no LLM. Examples that must work:
- "is my 2018 honda accord recalled" -> check_vehicle_recalls {year:2018, make:"honda", model:"accord"}
- "any recalls on my 2021 ford f-150" -> vehicle {year:2021, make:"ford", model:"f-150"}
- "is the graco pack and play recalled" / "check recalls for baby cribs" -> search_product_recalls {query:"graco pack and play"} / {query:"baby cribs"}
- "any recalls on peanut butter" / "is there a food recall for spinach" -> search_food_recalls {query:"peanut butter"}
- "was my ibuprofen recalled" / "drug recall for metformin" -> search_drug_recalls {query:"ibuprofen"}
Food words list (at least 60 common foods) and drug words list (at least 60 common medicines) decide food vs drug vs product; a 4-digit year 1950..2027 followed by 2 words means vehicle. Strip fillers ("is", "my", "the", "any", "recalled", "recall(s)", "for", "on", "check", "was", "there", "a").
Return null when nothing matches. At least 30 test utterances.

## MCP tools (server.ts, orchestrator)

check_vehicle_recalls{make, model, year}, search_product_recalls{query}, search_food_recalls{query}, search_drug_recalls{query}, check_all_recalls{query} (CPSC + FDA food + FDA drug in parallel).
Each returns content text = speak(...) and structuredContent = SearchResult (or {results: SearchResult[]}). readOnlyHint true, openWorldHint true.

## Simulator (web/, W4)

One static page served at `/` that simulates an Alexa+ device for the demo and for judges.
- Dark, calm, device-like look: a round "light ring" that animates while listening (blue) and speaking (cyan); large transcript; cards for each recall (title, date, hazard, remedy, source link).
- Input: microphone button using webkitSpeechRecognition / SpeechRecognition (en-US) and a text box fallback. Output: speechSynthesis reads the `text` reply.
- Flow: utterance -> POST `/route` (JSON {utterance}) returns {tool, args} or 404 -> the page calls the MCP endpoint `/mcp` itself as a real MCP client over Streamable HTTP: POST JSON-RPC `initialize` (protocolVersion "2025-11-25", headers `content-type: application/json`, `accept: application/json, text/event-stream`), then `notifications/initialized`, then `tools/call`. Handle both JSON and `text/event-stream` responses. Show a small "MCP" log panel listing each JSON-RPC method and latency, so viewers see MCP in action.
- Five example chips the user can tap. Footer: "Recall Radar by Michael Lip, github.com/theluckystrike. Data: NHTSA, CPSC, FDA. Not affiliated with Amazon."
- No frameworks, no external scripts or fonts, no emojis, no tracking. Works at 375 px width. Accessible labels on buttons.

## Hard rules

No paid API, no API keys, no login, no tracking. Never claim a product is safe: "no recalls found" only. Plain English. No emojis.
Functions under 60 lines, no while(true), no empty catch blocks. Edit only the files you own.
