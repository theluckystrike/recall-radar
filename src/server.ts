import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { searchProducts } from "./sources/cpsc.js";
import { searchDrug, searchFood } from "./sources/fda.js";
import {
  isAmbiguousVehicleError,
  isUnknownVehicleError,
  isVehicleServiceError,
  searchVehicle,
  UNKNOWN_VEHICLE_MESSAGE,
  vehicleSearchNote,
  vpicModelName,
} from "./sources/nhtsa.js";
import { byRecency } from "./rank.js";
import { followUps, speak, speakMany } from "./speech.js";
import { CARD_MIME, CARD_NAME, CARD_URI, cardDocument } from "./card.js";
import { cleanDrugItem, cleanItem, singularPhrase } from "./query.js";
import { normalizeMake, normalizeModel, route } from "./router.js";
import {
  MemoryStorage,
  WatchStore,
  WATCH_KINDS,
  classifyWatchItem,
  type AddWatchOutcome,
  type RemoveWatchOutcome,
  type WatchCheck,
  type WatchDraft,
  type WatchEnv,
  type WatchItem,
  type WatchInput,
  type WatchLookup,
  type WatchLookupResult,
  type WatchStorage,
} from "./watchstore.js";
import { SourceError, type Recall, type SearchResult, type Source } from "./types.js";

export { WatchStore, classifyWatchItem } from "./watchstore.js";
export type { AddWatchOutcome, RemoveWatchOutcome, WatchCheck, WatchDraft, WatchEnv, WatchInput, WatchItem, WatchKind, WatchLookup, WatchLookupResult, WatchStorage } from "./watchstore.js";

export const NAME = "recall-radar";
export const VERSION = "1.0.0";

export interface ServerOptions {
  env?: WatchEnv;
  userId?: string | null;
}

const SOURCE_NAMES: Record<Source, string> = {
  nhtsa: "NHTSA vehicle database",
  cpsc: "Consumer Product Safety Commission",
  "fda-food": "FDA food recall list",
  "fda-drug": "FDA drug recall list",
};

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
const resultSchema = z.object({ query: z.string(), source: z.enum(["nhtsa", "cpsc", "fda-food", "fda-drug"]), total: z.number(), recalls: z.array(recallSchema), recall: recallSchema.optional(), followUps: z.array(z.string()).optional() });
const query = z.string().trim().min(2).max(60).describe("What to look up, in plain words, for example \"peanut butter\" or \"graco pack and play\".");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
// MCP Apps linkage: a tool that returns recalls points at the ui:// card resource, so a host with
// screen support renders the newest recall next to the spoken answer. A voice-only host ignores it.
const cardMeta = { ui: { resourceUri: CARD_URI } };

function sorry(err: unknown) {
  const message = err instanceof Error ? err.message : "";
  let text = "Sorry, something went wrong while checking recalls. Please try again.";
  if (err instanceof RangeError) text = `Sorry, ${message}`;
  else if (err instanceof SourceError && /could not be fully checked/.test(message)) text = message;
  else if (isAmbiguousVehicleError(err)) {
    // The prefix fits several real vPIC models: ask which one instead of refusing the car.
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { query: "", source: "nhtsa", total: 0, recalls: [] },
    };
  }
  else if (isUnknownVehicleError(err)) text = "I could not find that make and model in the NHTSA database. Please say the make and model the way they appear on the car, for example Ford F-150.";
  else if (isVehicleServiceError(err)) text = "The NHTSA vehicle service is unavailable right now, so I could not check that car. Please try again in a minute.";
  else if (err instanceof SourceError && /timeout|abort/i.test(message)) text = "The government recall service did not answer in time. Please try again in a minute.";
  else if (err instanceof SourceError) text = "The government recall service could not be reached. Please try again in a minute.";
  return { content: [{ type: "text" as const, text }], isError: true };
}

function answer(result: SearchResult) {
  return { content: [{ type: "text" as const, text: speak(result) }], structuredContent: { ...result, recall: result.recalls[0], followUps: followUps(result.recalls) } };
}

/** "accord ex" or "range rover sport" can be unknown to NHTSA: retry with fewer model words, at most twice. */
async function searchVehicleWithRetry(make: string, model: string, year: number, fetchFn?: typeof fetch): Promise<SearchResult> {
  const fixedMake = normalizeMake(make);
  const fixedModel = normalizeModel(model);
  const words = fixedModel.trim().split(/\s+/);
  const floor = Math.max(1, words.length - 2);
  for (let n = words.length; n >= floor; n--) {
    try {
      return await searchVehicle(fixedMake, words.slice(0, n).join(" "), year, fetchFn);
    } catch (err) {
      if (!isUnknownVehicleError(err) || n === floor) throw err;
    }
  }
  throw new SourceError(UNKNOWN_VEHICLE_MESSAGE);
}

const vehicleWithRetry = (make: string, model: string, year: number) => searchVehicleWithRetry(make, model, year);

/**
 * Clean the item words and search the plural and singular forms in parallel ("cantaloupes" and "cantaloupe"):
 * agencies file the same food under either form, and one form alone can miss the newest recalls.
 */
export async function itemSearch(search: (q: string) => Promise<SearchResult>, raw: string, clean: (query: string) => string = cleanItem): Promise<SearchResult> {
  const q = clean(raw);
  const single = singularPhrase(q);
  if (!single) {
    const only = await search(q);
    return { ...only, recalls: [...only.recalls].sort(byRecency) };
  }
  const [a, b] = await Promise.allSettled([search(q), search(single)]);
  const ok = [a, b].flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (ok.length === 0) throw (a as PromiseRejectedResult).reason;
  const total = Math.max(...ok.map((r) => r.total));
  const failed = [a, b].filter((r) => r.status === "rejected").length;
  // One form failed and the other found nothing: that is not "no recalls", it is a source only half checked.
  if (failed > 0 && total === 0) {
    const source = ok[0]?.source ?? "cpsc";
    throw new SourceError(`The ${SOURCE_NAMES[source]} could not be fully checked because one of its two searches failed. Please try again in a minute.`);
  }
  const seen = new Set<string>();
  const recalls = ok.flatMap((r) => r.recalls).filter((r) => !seen.has(r.id) && seen.add(r.id)).sort(byRecency).slice(0, 5);
  const best = ok.reduce((m, r) => (r.total > m.total ? r : m));
  return { ...best, query: q, total, recalls };
}

/** Accept the simulator header, an Alexa user id header or a session id. Unsafe characters are dropped. */
export function watchUserId(userId?: string | null): string {
  return (userId ?? "").trim().replace(/[^A-Za-z0-9._:@-]/g, "").slice(0, 100);
}

export const NEED_USER_ID = "I need a user id to keep a watch list.";

/** "Is my car recalled" names a vehicle but no make or model. Ask for all three instead of searching products. */
const VEHICLE_PROMPT = "Which vehicle? Tell me the year, make and model, for example 2018 Honda Accord.";

function isVehicleOnlyQuestion(text: string): boolean {
  try {
    const routed = route(text);
    return routed?.tool === "ask_vehicle" && routed.args.missing === "vehicle";
  } catch {
    return false;
  }
}

/**
 * The exact search each single tool runs. The tools and the watch check both call these, so a saved item is
 * checked along the same path as the matching single tool: search_food_recalls for food (with its all-words
 * retry), search_product_recalls for products, check_vehicle_recalls for vehicles and search_drug_recalls for drugs.
 */
export interface RecallSources {
  vehicle(make: string, model: string, year: number): Promise<SearchResult>;
  product(query: string): Promise<SearchResult>;
  food(query: string): Promise<SearchResult>;
  drug(query: string): Promise<SearchResult>;
}

export const SEARCH_SOURCES: RecallSources = {
  vehicle: (make, model, year) => vehicleWithRetry(make, model, year),
  product: (query) => itemSearch(searchProducts, query),
  food: (query) => itemSearch(searchFood, query),
  drug: (query) => itemSearch(searchDrug, query, cleanDrugItem),
};

function watchSearches(item: WatchItem, sources: RecallSources): Array<Promise<SearchResult>> {
  if (item.kind === "vehicle") return [sources.vehicle(item.make ?? "", item.model ?? "", item.year ?? 0)];
  if (item.kind === "product") return [sources.product(item.query)];
  if (item.kind === "food") return [sources.food(item.query)];
  if (item.kind === "drug") return [sources.drug(item.query)];
  return [sources.product(item.query), sources.food(item.query), sources.drug(item.query)];
}

export async function searchWatchItem(item: WatchItem, sources: RecallSources = SEARCH_SOURCES): Promise<WatchLookupResult> {
  const settled = await Promise.allSettled(watchSearches(item, sources));
  const results = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failed = settled.some((result) => result.status === "rejected");
  const seen = new Set<string>();
  const recalls = results.flatMap((result) => result.recalls)
    .filter((recall) => !seen.has(recall.id) && seen.add(recall.id))
    .sort(byRecency);
  return { recalls, failed };
}

/** The Durable Object as the worker sees it over RPC: one call per operation. */
interface WatchRpc {
  add(input: WatchInput): Promise<AddWatchOutcome>;
  remove(text: string): Promise<RemoveWatchOutcome>;
  list(): Promise<WatchItem[]>;
  check(): Promise<WatchCheck>;
}

interface WatchTarget {
  add(input: WatchInput): Promise<AddWatchOutcome>;
  remove(text: string): Promise<RemoveWatchOutcome>;
  list(): Promise<WatchItem[]>;
  check(lookup: WatchLookup): Promise<WatchCheck>;
}

/** One in-memory watch list per env and user id, so tests and local dev run without the WATCH binding. */
const fallbackStores = new WeakMap<WatchEnv, Map<string, WatchStorage>>();

function fallbackStorage(env: WatchEnv, userId?: string | null): WatchStorage {
  let perUser = fallbackStores.get(env);
  if (!perUser) {
    perUser = new Map();
    fallbackStores.set(env, perUser);
  }
  const key = watchUserId(userId);
  let storage = perUser.get(key);
  if (!storage) {
    storage = new MemoryStorage();
    perUser.set(key, storage);
  }
  return storage;
}

function watchTarget(env: WatchEnv, userId: string | null | undefined, lookup: WatchLookup = searchWatchItem): WatchTarget {
  const key = watchUserId(userId);
  if (!key) throw new Error(NEED_USER_ID);
  const namespace = env.WATCH;
  if (namespace) {
    // One object per sanitised user id: every operation is a single call, so the object applies it in order.
    const stub = namespace.get(namespace.idFromName(key)) as unknown as WatchRpc;
    return {
      add: (input) => stub.add(input),
      remove: (text) => stub.remove(text),
      list: () => stub.list(),
      check: () => stub.check(),
    };
  }
  const local = new WatchStore({ storage: fallbackStorage(env, key) });
  return {
    add: (input) => local.add(input),
    remove: (text) => local.remove(text),
    list: () => local.list(),
    check: (passed) => local.check(passed),
  };
}

export async function readWatchList(env: WatchEnv | undefined, userId?: string | null): Promise<WatchItem[]> {
  if (!env || !watchUserId(userId)) return [];
  return watchTarget(env, userId).list();
}

export type WatchVehicleVerification = "known" | "unknown" | "unverified" | "ambiguous";

export interface WatchVehicleCheck {
  status: WatchVehicleVerification;
  /** The vPIC spelling, so a misheard model is saved under the name NHTSA really lists. */
  model?: string;
  message?: string;
}

export type WatchVehicleVerifier = (make: string, model: string, year: number) => Promise<WatchVehicleVerification | WatchVehicleCheck>;

/**
 * One NHTSA check when a vehicle is added, with the same model-word retry the check tool uses, so a trim
 * such as "accord ex" is not refused at add time. A resolved search means the model is known, even when it
 * has no recalls. Only a model vPIC does not list is unknown. A vPIC failure is unverified, never unknown.
 * An ambiguous prefix returns the question naming the real vPIC models, and is never saved as a guess.
 */
export async function resolveWatchVehicle(make: string, model: string, year: number, fetchFn?: typeof fetch): Promise<WatchVehicleCheck> {
  try {
    const result = await searchVehicleWithRetry(make, model, year, fetchFn);
    const note = vehicleSearchNote(result)?.model;
    // A model that already has recalls never reaches vPIC in the search, so ask it here for the
    // spelling. A vPIC miss or failure falls back to the typed name, never to unknown.
    const canonical = note ?? await vpicModelName(make, model, year, fetchFn).catch(() => undefined);
    return { status: "known", model: canonical };
  } catch (err) {
    if (isAmbiguousVehicleError(err)) return { status: "ambiguous", message: err.message };
    if (isUnknownVehicleError(err)) return { status: "unknown" };
    return { status: "unverified" };
  }
}

export async function verifyWatchVehicle(make: string, model: string, year: number, fetchFn?: typeof fetch): Promise<WatchVehicleVerification> {
  return (await resolveWatchVehicle(make, model, year, fetchFn)).status;
}

const UNKNOWN_VEHICLE = "NHTSA does not list that make and model for that year. Check the spelling on the car and try again.";
const UNVERIFIED_VEHICLE = "I could not verify it with NHTSA yet, so I saved it anyway.";

export async function addWatchItem(
  env: WatchEnv | undefined,
  userId: string | null | undefined,
  input: WatchInput,
  verify: WatchVehicleVerifier = resolveWatchVehicle,
): Promise<AddWatchOutcome> {
  if (!env) return { ok: false, message: "The watch list is not available right now." };
  if (!watchUserId(userId)) return { ok: false, message: NEED_USER_ID };
  let draft: WatchDraft;
  try {
    draft = classifyWatchItem(input);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "I could not add that item." };
  }
  let note: string | undefined;
  let saveInput = input;
  if (draft.kind === "vehicle") {
    const verified = await verify(draft.make ?? "", draft.model ?? "", draft.year ?? 0);
    const status = typeof verified === "string" ? verified : verified.status;
    if (status === "unknown") return { ok: false, message: UNKNOWN_VEHICLE };
    if (status === "ambiguous") {
      return { ok: false, message: (typeof verified === "string" ? "" : verified.message) || "Which model do you mean?" };
    }
    if (status === "unverified") note = UNVERIFIED_VEHICLE;
    const canonical = typeof verified === "string" ? undefined : verified.model;
    if (canonical && canonical !== draft.model) {
      saveInput = { year: draft.year, make: draft.make, model: canonical };
    }
  }
  const result = await watchTarget(env, userId).add(saveInput);
  return result.ok && note ? { ...result, note } : result;
}

export async function removeWatchItem(env: WatchEnv | undefined, userId: string | null | undefined, text: string): Promise<RemoveWatchOutcome> {
  if (!env) return { removed: false, list: [], message: "The watch list is not available right now." };
  if (!watchUserId(userId)) return { removed: false, list: [], message: NEED_USER_ID };
  return watchTarget(env, userId).remove(text);
}

export async function checkWatchList(env: WatchEnv | undefined, userId: string | null | undefined, lookup: WatchLookup = searchWatchItem): Promise<WatchCheck> {
  if (!env) {
    return { totalItems: 0, newItems: 0, failedItems: 0, recalls: [], followUps: [], items: [], text: "The watch list is not available right now." };
  }
  if (!watchUserId(userId)) {
    return { totalItems: 0, newItems: 0, failedItems: 0, recalls: [], followUps: [], items: [], text: NEED_USER_ID };
  }
  return watchTarget(env, userId, lookup).check(lookup);
}

function watchView(item: WatchItem) {
  return { id: item.id, kind: item.kind, label: item.label, query: item.query };
}

function watchUnavailable() {
  return { content: [{ type: "text" as const, text: "The watch list is not available right now." }], isError: true };
}

function watchNoUser() {
  return { content: [{ type: "text" as const, text: NEED_USER_ID }], isError: true };
}

function registerWatch(server: McpServer, env: WatchEnv | undefined, userId: string | null | undefined) {
  const watchItemSchema = z.object({ id: z.string(), kind: z.enum(WATCH_KINDS), label: z.string(), query: z.string() });
  server.registerTool("add_to_watch_list", {
    title: "Add to watch list",
    description: "Add a vehicle, household product, food or medicine to the household watch list. Give a vehicle as year, make and model, or give an item phrase. The list holds up to 10 items.",
    inputSchema: z.object({
      item: z.string().trim().min(2).max(80).optional().describe("An item phrase, for example \"IKEA MALM dresser\" or \"peanut butter\"."),
      query: z.string().trim().min(2).max(80).optional().describe("The same item phrase, when a client sends query instead of item."),
      year: z.number().int().min(1950).max(2100).optional(),
      make: z.string().trim().min(2).max(30).optional(),
      model: z.string().trim().min(1).max(40).optional(),
    }).strict(),
    outputSchema: z.object({ item: watchItemSchema, items: z.array(watchItemSchema) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    if (!env) return watchUnavailable();
    if (!watchUserId(userId)) return watchNoUser();
    const result = await addWatchItem(env, userId, input);
    if (!result.ok) return { content: [{ type: "text" as const, text: result.message }], isError: true };
    const text = `Added ${result.item.label} to your watch list. It now holds ${result.list.length} item${result.list.length === 1 ? "" : "s"}.${result.note ? ` ${result.note}` : ""}`;
    return { content: [{ type: "text" as const, text }], structuredContent: { item: watchView(result.item), items: result.list.map(watchView) } };
  });

  server.registerTool("remove_from_watch_list", {
    title: "Remove from watch list",
    description: "Remove one saved item from the household watch list. Use for phrases like \"Remove the crib from my list\".",
    inputSchema: z.object({
      item: z.string().trim().min(2).max(80).optional().describe("The saved item to remove, for example \"crib\" or \"2018 Honda Accord\"."),
      query: z.string().trim().min(2).max(80).optional().describe("The same saved item, when a client sends query instead of item."),
    }).strict(),
    outputSchema: z.object({ removed: z.boolean(), items: z.array(watchItemSchema) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    if (!env) return watchUnavailable();
    if (!watchUserId(userId)) return watchNoUser();
    const result = await removeWatchItem(env, userId, input.item ?? input.query ?? "");
    return { content: [{ type: "text" as const, text: result.message }], structuredContent: { removed: result.removed, items: result.list.map(watchView) } };
  });

  server.registerTool("check_my_watch_list", {
    title: "Check my watch list",
    description: "Check every saved watch list item for recalls and report only recalls that were not reported before. Use for \"Check my watch list\" and \"Anything new on my list\".",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ totalItems: z.number(), newItems: z.number(), failedItems: z.number(), recalls: z.array(recallSchema), recall: recallSchema.optional(), followUps: z.array(z.string()) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: cardMeta,
  }, async () => {
    if (!env) return watchUnavailable();
    if (!watchUserId(userId)) return watchNoUser();
    const result = await checkWatchList(env, userId);
    return {
      content: [{ type: "text" as const, text: result.text }],
      structuredContent: { totalItems: result.totalItems, newItems: result.newItems, failedItems: result.failedItems, recalls: result.recalls, recall: result.recalls[0], followUps: result.followUps },
    };
  });
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
    _meta: cardMeta,
  }, async ({ year, make, model }) => {
    try { return answer(await SEARCH_SOURCES.vehicle(make, model, year)); } catch (err) { return sorry(err); }
  });
}

function registerSearches(server: McpServer) {
  const tools: Array<[string, string, string, (q: string) => Promise<SearchResult>]> = [
    ["search_product_recalls", "Search consumer product recalls", "Search U.S. Consumer Product Safety Commission recalls for household products: cribs, strollers, toys, appliances, furniture, heaters. Use for \"Is the Graco pack and play recalled?\".", SEARCH_SOURCES.product],
    ["search_food_recalls", "Search food recalls", "Search FDA food recalls and safety alerts, newest first. Use for \"Any recalls on peanut butter?\".", SEARCH_SOURCES.food],
    ["search_drug_recalls", "Search medicine recalls", "Search FDA drug recalls for medicines, newest first. Use for \"Was my ibuprofen recalled?\". Not medical advice.", SEARCH_SOURCES.drug],
  ];
  for (const [name, title, description, search] of tools) {
    server.registerTool(name, { title, description, inputSchema: z.object({ query }).strict(), outputSchema: resultSchema, annotations: readOnly, _meta: cardMeta },
      async ({ query: q }) => { try { return answer(await search(q)); } catch (err) { return sorry(err); } });
  }
}

/**
 * The MCP Apps UI resource. Tools point at it through their _meta.ui link, and the host reads
 * this document to render the newest recall beside the spoken answer. The text answers are not
 * changed, so a voice-only client behaves exactly as before.
 */
function registerCard(server: McpServer) {
  server.registerResource(CARD_NAME, CARD_URI, {
    title: CARD_NAME,
    description: "A visual card for the newest recall with the title, date, source, severity, hazard, remedy and the official link.",
    mimeType: CARD_MIME,
  }, (uri) => ({
    contents: [{ uri: uri.href, mimeType: CARD_MIME, text: cardDocument() }],
  }));
}

function registerAll(server: McpServer) {
  server.registerTool("check_all_recalls", {
    title: "Check all recall sources",
    description: "When it is not clear whether something is a product, a food or a medicine, search CPSC, FDA food and FDA drug recalls together.",
    inputSchema: z.object({ query }).strict(),
    outputSchema: z.object({ results: z.array(resultSchema), failed: z.array(z.enum(["cpsc", "fda-food", "fda-drug"])), recall: recallSchema.optional(), followUps: z.array(z.string()) }),
    annotations: readOnly,
    _meta: cardMeta,
  }, async ({ query: q }) => {
    // A query with no Latin letters is a bad input, not three unreachable sources.
    try { cleanItem(q); } catch (err) { return sorry(err); }
    // "Is my car recalled" belongs to the vehicle tool even when a client sends it here: ask for year, make and model.
    if (isVehicleOnlyQuestion(q)) {
      return {
        content: [{ type: "text" as const, text: VEHICLE_PROMPT }],
        structuredContent: { results: [], failed: [], followUps: [] },
      };
    }
    const sources = ["cpsc", "fda-food", "fda-drug"] as const;
    const settled = await Promise.allSettled([SEARCH_SOURCES.product(q), SEARCH_SOURCES.food(q), SEARCH_SOURCES.drug(q)]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    // One merged, newest-first list: the spoken answer reads the first, "more" reads the next four.
    const merged = results.flatMap((r) => r.recalls).sort(byRecency);
    const failed = sources.filter((_, i) => settled[i]?.status === "rejected");
    if (results.length === 0) return sorry(new SourceError("all sources failed"));
    return { content: [{ type: "text" as const, text: speakMany(results, [...failed]) }], structuredContent: { results, failed: [...failed], recall: merged[0], followUps: followUps(merged) } };
  });
}

/** One fresh server per request: the endpoint is stateless. */
export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });
  registerCard(server);
  registerVehicle(server);
  registerSearches(server);
  registerAll(server);
  registerWatch(server, options.env, options.userId);
  return server;
}
