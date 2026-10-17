import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { searchProducts } from "./sources/cpsc.js";
import { searchDrug, searchFood } from "./sources/fda.js";
import { searchVehicle } from "./sources/nhtsa.js";
import { followUps, speak, speakMany } from "./speech.js";
import { cleanItem, singularPhrase } from "./query.js";
import { SourceError, type SearchResult } from "./types.js";

export const NAME = "recall-radar";
export const VERSION = "1.0.0";

const recallSchema = z.object({
  source: z.enum(["nhtsa", "cpsc", "fda-food", "fda-drug"]),
  id: z.string(),
  date: z.string(),
  title: z.string(),
  hazard: z.string(),
  remedy: z.string(),
  url: z.string(),
  severity: z.enum(["high", "medium", "low"]).optional(),
});
const resultSchema = z.object({ query: z.string(), source: z.enum(["nhtsa", "cpsc", "fda-food", "fda-drug"]), total: z.number(), recalls: z.array(recallSchema), followUps: z.array(z.string()).optional() });
const query = z.string().trim().min(2).max(60).describe("What to look up, in plain words, for example \"peanut butter\" or \"graco pack and play\".");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function sorry(err: unknown) {
  const message = err instanceof Error ? err.message : "";
  let text = "Sorry, something went wrong while checking recalls. Please try again.";
  if (err instanceof RangeError) text = `Sorry, ${message}`;
  else if (err instanceof SourceError && /NHTSA request returned HTTP 400|nhtsa: HTTP 400/i.test(message)) text = "I could not find that make and model in the NHTSA database. Please say the make and model the way they appear on the car, for example Ford F-150.";
  else if (err instanceof SourceError && /timeout|abort/i.test(message)) text = "The government recall service did not answer in time. Please try again in a minute.";
  else if (err instanceof SourceError) text = "The government recall service could not be reached. Please try again in a minute.";
  return { content: [{ type: "text" as const, text }], isError: true };
}

function answer(result: SearchResult) {
  return { content: [{ type: "text" as const, text: speak(result) }], structuredContent: { ...result, followUps: followUps(result.recalls) } };
}

/** "accord ex" or "range rover sport" can be unknown to NHTSA: retry with fewer model words, at most twice. */
async function vehicleWithRetry(make: string, model: string, year: number): Promise<SearchResult> {
  const words = model.trim().split(/\s+/);
  for (let n = words.length; n >= Math.max(1, words.length - 2); n--) {
    try {
      return await searchVehicle(make, words.slice(0, n).join(" "), year);
    } catch (err) {
      const notFound = err instanceof SourceError && /HTTP 400/.test(err.message);
      if (!notFound || n === Math.max(1, words.length - 2)) throw err;
    }
  }
  throw new SourceError("NHTSA request returned HTTP 400");
}

/**
 * Clean the item words and search the plural and singular forms in parallel ("cantaloupes" and "cantaloupe"):
 * agencies file the same food under either form, and one form alone can miss the newest recalls.
 */
async function itemSearch(search: (q: string) => Promise<SearchResult>, raw: string): Promise<SearchResult> {
  const q = cleanItem(raw);
  const single = singularPhrase(q);
  if (!single) return search(q);
  const [a, b] = await Promise.allSettled([search(q), search(single)]);
  const ok = [a, b].flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (ok.length === 0) throw (a as PromiseRejectedResult).reason;
  const seen = new Set<string>();
  const recalls = ok.flatMap((r) => r.recalls).filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 5);
  const best = ok.reduce((m, r) => (r.total > m.total ? r : m));
  return { ...best, query: q, total: Math.max(...ok.map((r) => r.total)), recalls };
}

function registerVehicle(server: McpServer) {
  server.registerTool("check_vehicle_recalls", {
    title: "Check vehicle recalls",
    description: "Check the NHTSA database for safety recalls on a car, truck or motorcycle by model year, make and model. Use for questions like \"Is my 2018 Honda Accord recalled?\". Returns a short spoken answer and the recall details.",
    inputSchema: z.object({
      year: z.number().int().min(1950).max(2100).describe("Model year, for example 2018."),
      make: z.string().trim().min(2).max(30).describe("Manufacturer, for example \"Honda\"."),
      model: z.string().trim().min(1).max(40).describe("Model, for example \"Accord\"."),
    }).strict(),
    outputSchema: resultSchema,
    annotations: readOnly,
  }, async ({ year, make, model }) => {
    try { return answer(await vehicleWithRetry(make, model, year)); } catch (err) { return sorry(err); }
  });
}

function registerSearches(server: McpServer) {
  const tools: Array<[string, string, string, (q: string) => Promise<SearchResult>]> = [
    ["search_product_recalls", "Search consumer product recalls", "Search U.S. Consumer Product Safety Commission recalls for household products: cribs, strollers, toys, appliances, furniture, heaters. Use for \"Is the Graco pack and play recalled?\".", searchProducts],
    ["search_food_recalls", "Search food recalls", "Search FDA food recalls and safety alerts, newest first. Use for \"Any recalls on peanut butter?\".", searchFood],
    ["search_drug_recalls", "Search medicine recalls", "Search FDA drug recalls for medicines, newest first. Use for \"Was my ibuprofen recalled?\". Not medical advice.", searchDrug],
  ];
  for (const [name, title, description, search] of tools) {
    server.registerTool(name, { title, description, inputSchema: z.object({ query }).strict(), outputSchema: resultSchema, annotations: readOnly },
      async ({ query: q }) => { try { return answer(await itemSearch(search, q)); } catch (err) { return sorry(err); } });
  }
}

function registerAll(server: McpServer) {
  server.registerTool("check_all_recalls", {
    title: "Check all recall sources",
    description: "When it is not clear whether something is a product, a food or a medicine, search CPSC, FDA food and FDA drug recalls together.",
    inputSchema: z.object({ query }).strict(),
    outputSchema: z.object({ results: z.array(resultSchema), failed: z.array(z.enum(["cpsc", "fda-food", "fda-drug"])), followUps: z.array(z.string()) }),
    annotations: readOnly,
  }, async ({ query: q }) => {
    const sources = ["cpsc", "fda-food", "fda-drug"] as const;
    const settled = await Promise.allSettled([itemSearch(searchProducts, q), itemSearch(searchFood, q), itemSearch(searchDrug, q)]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    // One merged, newest-first list: the spoken answer reads the first, "more" reads the next four.
    const merged = results.flatMap((r) => r.recalls).sort((a, b) => b.date.localeCompare(a.date));
    const failed = sources.filter((_, i) => settled[i]?.status === "rejected");
    if (results.length === 0) return sorry(new SourceError("all sources failed"));
    return { content: [{ type: "text" as const, text: speakMany(results, [...failed]) }], structuredContent: { results, failed: [...failed], followUps: followUps(merged) } };
  });
}

/** One fresh server per request: the endpoint is stateless. */
export function createServer(): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });
  registerVehicle(server);
  registerSearches(server);
  registerAll(server);
  return server;
}
