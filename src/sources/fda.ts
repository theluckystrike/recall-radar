import { Recall, SearchResult, SourceError, Source, FETCH_TIMEOUT_MS } from "../types";

type FetchFn = typeof fetch;

const FDA_BASE = "https://api.fda.gov";
const FDA_URL = "https://www.accessdata.fda.gov/scripts/ires/index.cfm";
const MAX_TITLE = 120;
const MAX_TEXT = 300;
const MAX_QUERY = 60;

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

function sanitizeQuery(query: string): string {
  return clean(query.replace(/[^a-zA-Z0-9 \-'&]/g, "")).slice(0, MAX_QUERY);
}

function isoDate(raw: unknown): string {
  const s = str(raw).trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function severityFrom(raw: unknown): Recall["severity"] {
  const c = str(raw).toUpperCase();
  if (c === "CLASS I") return "high";
  if (c === "CLASS II") return "medium";
  if (c === "CLASS III") return "low";
  return undefined;
}

async function readJson(res: Response, source: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new SourceError(`${source}: non-JSON response`);
  }
}

function totalFrom(body: unknown, source: string): number {
  if (!isRecord(body) || !isRecord(body.meta) || !isRecord(body.meta.results)) {
    throw new SourceError(`${source}: unexpected response shape`);
  }
  const total = body.meta.results.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : 0;
}

function resultsFrom(body: unknown, source: string): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new SourceError(`${source}: unexpected response shape`);
  }
  return body.results;
}

function toRecall(raw: unknown, source: Source): Recall | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.recall_number);
  const date = isoDate(raw.report_date);
  if (!id || !date) return null;
  return {
    source,
    id,
    date,
    title: cap(str(raw.product_description), MAX_TITLE),
    hazard: cap(str(raw.reason_for_recall), MAX_TEXT),
    remedy: "",
    url: FDA_URL,
    severity: severityFrom(raw.classification),
  };
}

async function searchFda(
  productType: "food" | "drug",
  source: Source,
  query: string,
  fetchFn: FetchFn,
): Promise<SearchResult> {
  const url =
    `${FDA_BASE}/${productType}/enforcement.json` +
    `?search=product_description:"${encodeURIComponent(sanitizeQuery(query))}"` +
    `&sort=report_date:desc&limit=5`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new SourceError(`${source}: ${e instanceof Error ? e.message : "request failed"}`);
  }
  if (res.status === 404) {
    const body = await readJson(res, source);
    if (isRecord(body) && isRecord(body.error) && body.error.code === "NOT_FOUND") {
      return { query, source, total: 0, recalls: [] };
    }
    throw new SourceError(`${source}: unexpected 404 response`);
  }
  if (res.status !== 200) {
    throw new SourceError(`${source}: HTTP ${res.status}`);
  }
  const body = await readJson(res, source);
  const total = totalFrom(body, source);
  const recalls = resultsFrom(body, source)
    .map((r) => toRecall(r, source))
    .filter((r): r is Recall => r !== null)
    .slice(0, 5);
  return { query, source, total, recalls };
}

export async function searchFood(
  query: string,
  fetchFn: FetchFn = fetch,
): Promise<SearchResult> {
  return searchFda("food", "fda-food", query, fetchFn);
}

export async function searchDrug(
  query: string,
  fetchFn: FetchFn = fetch,
): Promise<SearchResult> {
  return searchFda("drug", "fda-drug", query, fetchFn);
}
