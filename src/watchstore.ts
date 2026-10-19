import { cleanItem, stripAccents } from "./query.js";
import { byImportance } from "./rank.js";
import { normalizeMake, normalizeModel, route } from "./router.js";
import { followUps, speakWatch } from "./speech.js";
import type { Recall } from "./types.js";

// Watch list logic with no Cloudflare imports: the Durable Object in watchdo.ts delegates to WatchStore,
// and the plain class runs unchanged under Node in the tests and as the in-memory fallback.

/** The part of Durable Object storage the watch list uses: key value, single-threaded, strongly consistent. */
export interface WatchStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

/** The slice of a Durable Object namespace the watch list needs, so tests can pass a small fake. */
export interface WatchNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

export interface WatchEnv {
  LIMITS?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  WATCH?: WatchNamespace;
}

export const WATCH_LIMIT = 10;
export const WATCH_KINDS = ["vehicle", "product", "food", "drug", "all"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export interface WatchItem {
  id: string;
  kind: WatchKind;
  label: string;
  query: string;
  year?: number;
  make?: string;
  model?: string;
  seen: string[];
}

export interface WatchLookupResult {
  recalls: Recall[];
  failed: boolean;
}

export type WatchLookup = (item: WatchItem) => Promise<WatchLookupResult>;
export type WatchDraft = Omit<WatchItem, "id" | "seen">;

/** The tool input for adding an item, before validation. */
export interface WatchInput {
  item?: string;
  query?: string;
  year?: number;
  make?: string;
  model?: string;
}

export type AddWatchOutcome = { ok: true; item: WatchItem; list: WatchItem[]; note?: string } | { ok: false; message: string };
export type RemoveWatchOutcome = { removed: boolean; item?: WatchItem; list: WatchItem[]; message: string };

export interface WatchCheck {
  totalItems: number;
  newItems: number;
  failedItems: number;
  recalls: Recall[];
  followUps: string[];
  text: string;
  items: WatchItem[];
}

const WATCH_STORAGE_KEY = "items";

function isWatchItem(value: unknown): value is WatchItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WatchItem>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.query === "string"
    && typeof item.kind === "string" && (WATCH_KINDS as readonly string[]).includes(item.kind)
    && Array.isArray(item.seen) && item.seen.every((id) => typeof id === "string");
}

const titleCase = (text: string) => text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function classifyWatchItem(input: WatchInput): WatchDraft {
  const make = input.make?.trim() ?? "";
  const model = input.model?.trim() ?? "";
  if (input.year !== undefined || make || model) {
    const maxYear = new Date().getUTCFullYear() + 1;
    if (!Number.isInteger(input.year) || (input.year as number) < 1950 || (input.year as number) > maxYear || !make || !model) {
      throw new TypeError("Give a vehicle with a model year between 1950 and next year, a make and a model.");
    }
    const year = input.year as number;
    const fixedMake = normalizeMake(make);
    const fixedModel = normalizeModel(model);
    const label = `${year} ${titleCase(fixedMake)} ${titleCase(fixedModel)}`;
    return { kind: "vehicle", label, query: label, year, make: fixedMake, model: fixedModel };
  }
  const text = stripAccents((input.item ?? input.query ?? "").trim()).replace(/\s+/g, " ").slice(0, 80);
  if (text.length < 2) throw new TypeError("Give an item phrase between 2 and 80 characters.");
  const routed = route(text);
  if (routed?.tool === "check_vehicle_recalls") {
    const { year, make: routedMake, model: routedModel } = routed.args;
    const label = `${year} ${titleCase(routedMake)} ${titleCase(routedModel)}`;
    return { kind: "vehicle", label, query: label, year, make: routedMake, model: routedModel };
  }
  if (routed?.tool === "ask_vehicle") throw new TypeError("That looks like a vehicle. Give the year, make and model so it can be checked.");
  if (routed?.tool === "search_food_recalls") return { kind: "food", label: text, query: cleanItem(routed.args.query) };
  if (routed?.tool === "search_drug_recalls") return { kind: "drug", label: text, query: cleanItem(routed.args.query) };
  if (routed?.tool === "search_product_recalls") return { kind: "product", label: text, query: cleanItem(routed.args.query) };
  if (routed?.tool === "check_all_recalls") return { kind: "all", label: text, query: cleanItem(routed.args.query) };
  return { kind: "all", label: text, query: cleanItem(text) || text };
}

function watchId(draft: WatchDraft): string {
  const base = draft.kind === "vehicle" ? `v|${draft.year}|${draft.make}|${draft.model}` : `q|${draft.query}`;
  return base.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

const REMOVE_WORDS = /\b(?:remove|delete|take|drop|from|off|list|my|the)\b/gi;

/** "Remove the crib from my list" -> "crib". */
function removalPhrase(text: string): string {
  const stripped = text.replace(REMOVE_WORDS, " ");
  try {
    return cleanItem(stripped);
  } catch {
    return "";
  }
}

function wordTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whole words only, so "ice" never matches inside "Fisher-Price". */
function wholeWordMatch(item: WatchItem, needle: string): boolean {
  const wanted = wordTokens(needle);
  if (wanted.length === 0) return false;
  const have = new Set([...wordTokens(item.label), ...wordTokens(item.query)]);
  return wanted.every((word) => have.has(word));
}

/**
 * The watch list as a plain object over WatchStorage. The Durable Object in watchdo.ts is a thin RPC layer over
 * this class, so the same logic runs in production, in the in-memory fallback and in the unit tests.
 */
export class WatchStore {
  private readonly storage: WatchStorage;
  private readonly lookup?: WatchLookup;

  constructor(ctx: { storage: WatchStorage }, lookup?: WatchLookup) {
    this.storage = ctx.storage;
    this.lookup = lookup;
  }

  private async items(): Promise<WatchItem[]> {
    const raw = await this.storage.get<unknown>(WATCH_STORAGE_KEY);
    return Array.isArray(raw) ? raw.filter(isWatchItem) : [];
  }

  private async save(list: WatchItem[]): Promise<void> {
    await this.storage.put(WATCH_STORAGE_KEY, list.map((item) => ({ ...item, seen: item.seen.slice(-100) })));
  }

  async list(): Promise<WatchItem[]> {
    return this.items();
  }

  async add(input: WatchInput): Promise<AddWatchOutcome> {
    let draft: WatchDraft;
    try {
      draft = classifyWatchItem(input);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "I could not add that item." };
    }
    const id = watchId(draft);
    const list = await this.items();
    if (list.some((item) => item.id === id)) return { ok: false, message: "That item is already on your watch list." };
    if (list.length >= WATCH_LIMIT) return { ok: false, message: `Your watch list is full. It holds ${WATCH_LIMIT} items. Remove one before adding another.` };
    const item: WatchItem = { id, ...draft, seen: [] };
    const next = [...list, item];
    await this.save(next);
    return { ok: true, item, list: next };
  }

  async remove(text: string): Promise<RemoveWatchOutcome> {
    const needle = removalPhrase(text).toLowerCase();
    const list = await this.items();
    if (!needle) return { removed: false, list, message: "Tell me the item to remove." };
    const exact = list.filter((item) => item.id.toLowerCase() === needle || item.label.toLowerCase() === needle);
    const matches = exact.length > 0 ? exact : list.filter((item) => wholeWordMatch(item, needle));
    if (matches.length === 0) return { removed: false, list, message: `I could not find ${text.trim()} on your watch list.` };
    if (matches.length > 1) {
      const names = matches.map((item) => item.label);
      const listText = names.length === 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
      return { removed: false, list, message: `Which one do you want me to remove, ${listText}?` };
    }
    const item = matches[0]!;
    const next = list.filter((entry) => entry.id !== item.id);
    await this.save(next);
    return { removed: true, item, list: next, message: `I removed ${item.label} from your watch list. It now holds ${next.length} item${next.length === 1 ? "" : "s"}.` };
  }

  /** Check every saved item in parallel and remember each recall id already reported for that item. */
  async check(lookup?: WatchLookup): Promise<WatchCheck> {
    const run = lookup ?? this.lookup;
    if (!run) throw new Error("A recall lookup is required to check the watch list.");
    const items = await this.items();
    const firstCheck = items.every((item) => item.seen.length === 0);
    const checked = await Promise.all(items.map(async (item) => {
      try {
        return { item, ...(await run(item)) };
      } catch {
        return { item, recalls: [] as Recall[], failed: true };
      }
    }));
    const checkedById = new Map<string, WatchItem>();
    for (const { item, recalls } of checked) {
      const seen = [...new Set([...item.seen, ...recalls.map((recall) => recall.id)])].slice(-100);
      checkedById.set(item.id, { ...item, seen });
    }
    // Re-read after the slow lookups: an add or a remove made while the check ran must survive.
    const current = await this.items();
    const currentById = new Map(current.map((item) => [item.id, item]));
    const fresh: Array<{ item: WatchItem; recall: Recall }> = [];
    const emptyLabels: string[] = [];
    let failedItems = 0;
    let checkedItems = 0;
    for (const { item, recalls, failed } of checked) {
      const now = currentById.get(item.id);
      if (!now) continue;
      // A partial failure that still produced a recall was reached, so it counts as checked for the lead.
      if (failed) failedItems++;
      if (!failed || recalls.length > 0) checkedItems++;
      if (!failed && recalls.length === 0) emptyLabels.push(item.label);
      for (const recall of recalls) {
        if (!item.seen.includes(recall.id) && !now.seen.includes(recall.id)) fresh.push({ item, recall });
      }
    }
    const merged = current.map((item) => {
      const done = checkedById.get(item.id);
      if (!done) return item;
      const seen = [...new Set([...item.seen, ...done.seen])].slice(-100);
      return { ...item, seen };
    });
    await this.save(merged);
    fresh.sort((a, b) => byImportance(a.recall, b.recall));
    const recalls = fresh.map((entry) => entry.recall);
    const newItems = new Set(fresh.map((entry) => entry.item.id)).size;
    const text = speakWatch({ totalItems: merged.length, newItems, failedItems, checkedItems, recall: recalls[0], newRecallCount: recalls.length, query: fresh[0]?.item.query, label: fresh[0]?.item.label, firstCheck, emptyLabels });
    return { totalItems: merged.length, newItems, failedItems, recalls, followUps: followUps(recalls), text, items: merged };
  }
}

/** In-memory storage for the fallback, and for the Durable Object tests. */
export class MemoryStorage implements WatchStorage {
  private readonly data = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}
