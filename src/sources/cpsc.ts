import { Recall, SearchResult, SourceError, FETCH_TIMEOUT_MS } from "../types";

type FetchFn = typeof fetch;

const CPSC_URL = "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallTitle=";
const MAX_TITLE = 120;
const MAX_TEXT = 300;
const MAX_RESULTS = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clean(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function cap(s: string, n: number): string {
  const t = clean(s);
  if (t.length <= n) return t;
  // Cut at a word boundary and mark the cut, so no word is read half.
  const head = t.slice(0, n - 2);
  const space = head.lastIndexOf(" ");
  return (space > n * 0.6 ? head.slice(0, space) : t.slice(0, n - 3)).replace(/[\s,;:.-]+$/, "") + "...";
}

function isoDate(raw: unknown): string {
  const s = str(raw).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

function firstName(raw: unknown): string {
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (isRecord(first)) return str(first.Name);
  }
  return "";
}

function toRecall(raw: unknown): Recall | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.RecallNumber);
  const date = isoDate(raw.RecallDate);
  if (!id || !date) return null;
  const title = cap(str(raw.Title), MAX_TITLE) || cap(firstName(raw.Products), MAX_TITLE);
  return {
    source: "cpsc",
    id,
    date,
    title,
    hazard: cap(firstName(raw.Hazards), MAX_TEXT),
    remedy: cap(firstName(raw.Remedies), MAX_TEXT),
    url: clean(str(raw.URL)),
  };
}

/** Words too common to search CPSC titles by alone. */
const GENERIC = new Set(["baby", "kids", "children", "child", "product", "products", "recall", "recalls", "with", "from", "model", "brand",
  "new", "old", "small", "large", "home", "kitchen", "black", "white", "pack", "and", "the", "for", "set", "kit", "type"]);

function distinctiveWords(words: string[]): string[] {
  return words.filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w)).sort((a, b) => b.length - a.length).slice(0, 2);
}

/**
 * CPSC title search is literal: "ikea malm dresser" finds nothing, while the IKEA MALM recall is titled
 * "IKEA Recalls MALM and Other Chests and Dressers". Search the phrase and the 2 most distinctive words in parallel
 * (one round trip), then keep recalls whose title holds the most of the person's words. The result says which phrase
 * matched when it is not the exact phrase, so the answer stays honest.
 */
export async function searchProducts(query: string, fetchFn: FetchFn = fetch): Promise<SearchResult> {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const singles = words.length > 1 ? distinctiveWords(words) : [];
  const settled = await Promise.allSettled([searchProductsExact(query, fetchFn), ...singles.map((w) => searchProductsExact(w, fetchFn, 60))]);
  const exact = settled[0]!;
  if (exact.status === "fulfilled" && exact.value.total > 0) return exact.value;
  const pool = settled.flatMap((r) => (r.status === "fulfilled" ? r.value.recalls : []));
  // A failed search must not turn into "no recalls": say the search could not finish.
  if (settled.some((r) => r.status === "rejected") && pool.length === 0) throw new SourceError("cpsc: search incomplete");
  if (pool.length === 0) return { query, source: "cpsc", total: 0, recalls: [] };
  // Every distinctive word (the brand and model words searched alone) must appear as a whole word in the title;
  // the other meaningful words only rank. So "uppababy high chair" never returns another brand's high chair.
  const whole = (title: string, w: string) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}(e?s)?\\b`, "i").test(title);
  const scoring = words.filter((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
  const score = (title: string) => scoring.filter((w) => whole(title, w.replace(/s$/, ""))).length;
  const required = (title: string) => singles.every((w) => whole(title, w.replace(/s$/, "")));
  const seen = new Set<string>();
  const ranked = pool.filter((r) => !seen.has(r.id) && seen.add(r.id) && required(r.title))
    .sort((a, b) => score(b.title) - score(a.title) || b.date.localeCompare(a.date)).slice(0, 5);
  return { query: ranked.length ? `${query} (matched by ${singles.join(" and ")})` : query, source: "cpsc", total: ranked.length, recalls: ranked };
}

async function searchProductsExact(
  query: string,
  fetchFn: FetchFn = fetch,
  limit = MAX_RESULTS,
): Promise<SearchResult> {
  const url = CPSC_URL + encodeURIComponent(query);
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new SourceError(`cpsc: ${e instanceof Error ? e.message : "request failed"}`);
  }
  if (res.status !== 200) {
    throw new SourceError(`cpsc: HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SourceError("cpsc: non-JSON response");
  }
  if (!Array.isArray(body)) {
    throw new SourceError("cpsc: expected a JSON array");
  }
  const recalls = body
    .map(toRecall)
    .filter((r): r is Recall => r !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit);
  return { query, source: "cpsc", total: body.length, recalls };
}
