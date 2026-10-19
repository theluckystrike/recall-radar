import { FETCH_TIMEOUT_MS, Recall, SearchResult, SourceError } from "../types";
import { byRecency } from "../rank.js";

const NHTSA_ENDPOINT = "https://api.nhtsa.gov/recalls/recallsByVehicle";
const NHTSA_MODELS_ENDPOINT = "https://api.nhtsa.gov/products/vehicle/models";
const VPIC_ENDPOINT = "https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make";
const NHTSA_PAGE = "https://www.nhtsa.gov/recalls?nhtsaId=";
const MIN_YEAR = 1950;
const MAX_RESULTS = 5;
// Six numbers, each tried joined and spaced ("GLC300" and "GLC 300"), so twelve calls at most.
const MAX_SUBMODEL_CALLS = 12;
const MAX_MODEL_OPTIONS = 5;
const MAX_TITLE = 120;
const MAX_HAZARD = 300;
const MAX_REMEDY = 300;

// Two distinct failures a caller must never mix up. An unknown model is a real answer from vPIC that
// the vehicle is not listed. A service error means vPIC could not be reached, so nothing is known.
const UNKNOWN_VEHICLE = "nhtsa: does not list that make and model for that year";
const VEHICLE_SERVICE = "nhtsa: vehicle service is unavailable";

export const UNKNOWN_VEHICLE_MESSAGE = UNKNOWN_VEHICLE;

/** The prefix fits several vPIC models, so the answer is a question naming the real choices. */
export class AmbiguousVehicleError extends SourceError {
  readonly options: string[];
  /** True when vPIC listed more models than the question could name, so the list is not complete. */
  readonly truncated: boolean;
  constructor(options: string[], truncated = false) {
    super(modelQuestion(options, truncated));
    this.name = "AmbiguousVehicleError";
    this.options = options;
    this.truncated = truncated;
  }
}

export function isAmbiguousVehicleError(error: unknown): error is AmbiguousVehicleError {
  return error instanceof AmbiguousVehicleError;
}

function modelQuestion(options: string[], truncated = false): string {
  // A cut list is never presented as complete: the open choice lets the person name a model it omitted.
  const list = truncated ? [...options, "another model"] : options;
  const choices = list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
  return choices ? `Which one, ${choices}?` : "Which model do you mean?";
}

export function isUnknownVehicleError(error: unknown): boolean {
  return error instanceof SourceError && error.message.startsWith(UNKNOWN_VEHICLE);
}

export function isVehicleServiceError(error: unknown): boolean {
  return error instanceof SourceError && error.message.startsWith(VEHICLE_SERVICE);
}

type FetchFn = typeof fetch;

interface NhtsaRecord {
  NHTSACampaignNumber?: unknown;
  ReportReceivedDate?: unknown;
  Model?: unknown;
  Component?: unknown;
  Summary?: unknown;
  Consequence?: unknown;
  Remedy?: unknown;
  parkIt?: unknown;
  parkOutSide?: unknown;
}

interface NhtsaResponse {
  Count?: unknown;
  results?: unknown;
}

interface VpicModel {
  Model_Name?: unknown;
}

interface VpicResponse {
  Results?: unknown;
  Errors?: unknown;
}

interface NhtsaModelEntry {
  model?: unknown;
  Model_Name?: unknown;
}

interface NhtsaModelsResponse {
  results?: unknown;
  Results?: unknown;
}

/** A different car that shares the spoken name, with the recalls it has: never added to the user's total. */
export interface RelatedModelRecall {
  model: string;
  count: number;
}

/** What the answer should say about a family name and the related models searched under it. */
export interface VehicleSearchNote {
  model: string;
  relatedModels: string[];
  searchedModels: string[];
  /** The searched sub-models that actually had recalls, so the answer can say what they were filed under. */
  filedUnder: string[];
  /** Related models that are a different car and have recalls: named separately, never merged into the total. */
  relatedRecalls: RelatedModelRecall[];
  example?: string;
}

// A note belongs to one result object and is read by the speech layer. A WeakMap keeps it out of the
// structured tool output, whose schema the orchestrator owns.
const vehicleNotes = new WeakMap<SearchResult, VehicleSearchNote>();

export function vehicleSearchNote(result: SearchResult): VehicleSearchNote | undefined {
  return vehicleNotes.get(result);
}

/** "F-150", "F150" and "F 150" all become "f150", so a spoken model matches the vPIC spelling. */
function modelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The vPIC model list changes rarely, so a short in-process cache by make and year keeps a watch check
// of several no-recall vehicles from doubling its outbound requests. Cached values expire after 6 hours.
const VPIC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface VpicCacheEntry {
  names: string[];
  expires: number;
}

const vpicCache = new WeakMap<FetchFn, Map<string, VpicCacheEntry>>();

function vpicCacheFor(fetchFn: FetchFn): Map<string, VpicCacheEntry> {
  let cache = vpicCache.get(fetchFn);
  if (!cache) {
    cache = new Map();
    vpicCache.set(fetchFn, cache);
  }
  return cache;
}

interface ModelLookup {
  match: string | null;
  options: string[];
  truncated: boolean;
}

/** "Model 3" sorts before "Model S" and "Model 10" after "Model 3", not before "Model 2". */
const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * A vPIC name matches the wanted model when its key is the wanted key, the make key followed by the
 * wanted key ("Mazda3" for make mazda and model 3), or when one key is a prefix of the other so a
 * name that adds or drops a trim ("Camry Hybrid", "Corolla Cross") still matches.
 * A prefix that fits several vPIC models returns those models as choices instead of guessing one.
 */
function modelLookup(names: string[], make: string, model: string): ModelLookup {
  const wanted = modelKey(model);
  if (!wanted) return { match: null, options: [], truncated: false };
  const makeKey = modelKey(make);
  const exact = names.find((name) => modelKey(name) === wanted);
  if (exact) return { match: exact, options: [], truncated: false };
  const prefixed = names.find((name) => makeKey && modelKey(name) === `${makeKey}${wanted}`);
  if (prefixed) return { match: prefixed, options: [], truncated: false };
  // "3 Series" is how a person says a BMW family, but vPIC lists the numbered cars (320i, 330i, 340i).
  // The choices always end with another model, since a series has trims the list may not name.
  const seriesDigit = /^([1-9])\s*series$/.exec(model.trim().toLowerCase())?.[1];
  if (seriesDigit) {
    const seen = new Set<string>();
    const numbered = names.filter((name) => {
      const key = modelKey(name);
      if (seen.has(key)) return false;
      if (!new RegExp(`^${seriesDigit}\\d{2}[a-z]*$`).test(key)) return false;
      seen.add(key);
      return true;
    });
    if (numbered.length > 0) {
      const sorted = numbered.sort((a, b) => naturalOrder.compare(a, b));
      return {
        match: null,
        options: sorted.slice(0, MAX_MODEL_OPTIONS),
        truncated: true,
      };
    }
  }
  // A prefix match counts only when exactly one vPIC model fits, so "Model" never stands for "Model S".
  const prefix: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = modelKey(name);
    if (key.length < 3 || wanted.length < 3) continue;
    if (!key.startsWith(wanted) && !wanted.startsWith(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    prefix.push(name);
  }
  if (prefix.length === 1) return { match: prefix[0]!, options: [], truncated: false };
  if (prefix.length > 1) {
    const sorted = prefix.sort((a, b) => naturalOrder.compare(a, b));
    return {
      match: null,
      options: sorted.slice(0, MAX_MODEL_OPTIONS),
      truncated: sorted.length > MAX_MODEL_OPTIONS,
    };
  }
  return { match: null, options: [], truncated: false };
}

function maxAllowedYear(): number {
  return new Date().getFullYear() + 1;
}

function validateYear(year: number): void {
  if (
    typeof year !== "number" ||
    !Number.isInteger(year) ||
    year < MIN_YEAR ||
    year > maxAllowedYear()
  ) {
    throw new RangeError(
      `year must be an integer between ${MIN_YEAR} and ${maxAllowedYear()}`
    );
  }
}

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const dayStr = match[1];
  const monthStr = match[2];
  const yearStr = match[3];
  if (!dayStr || !monthStr || !yearStr) return null;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return (
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  );
}

function clean(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  // Cut at a word boundary and mark the cut, so no word is read half.
  const head = collapsed.slice(0, maxLength - 2);
  const space = head.lastIndexOf(" ");
  return (space > maxLength * 0.6 ? head.slice(0, space) : collapsed.slice(0, maxLength - 3)).replace(/[\s,;:.-]+$/, "") + "...";
}

/** "AIR BAGS:SENSOR:OCCUPANT CLASSIFICATION" -> "Air bags: sensor, occupant classification". */
function readableComponent(component: string): string {
  const parts = component.split(":").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return component;
  const [head = "", ...rest] = parts;
  const first = head.charAt(0).toUpperCase() + head.slice(1);
  return rest.length ? `${first}: ${rest.join(", ")}` : first;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join("-")
    )
    .join(" ");
}

/**
 * One model token as it should be written: a token the speaker gave in capitals ("RX", "RX350",
 * "F-150") stays as it is, and a token a maker spells in capitals stays in capitals when it is four
 * characters or fewer or carries a digit ("CX-5"). Anything else is title cased ("Accord").
 */
function displayModelToken(token: string, known?: string): string {
  // vPIC spells a family "GLC-Class": keep the agency's capitals instead of title casing to "Glc-Class".
  const family = /^([A-Za-z]+)-class$/i.exec(token);
  const familyStem = family?.[1];
  if (familyStem && familyStem === familyStem.toUpperCase()) {
    return `${familyStem}-Class`;
  }
  const letters = token.replace(/[^A-Za-z]/g, "");
  if (letters && letters === letters.toUpperCase()) return token;
  const knownText = (known ?? "").trim();
  const knownLetters = knownText.replace(/[^A-Za-z]/g, "");
  const compact = token.replace(/[^A-Za-z0-9]/g, "");
  if (knownLetters && knownLetters === knownLetters.toUpperCase() && (compact.length <= 4 || /\d/.test(token))) {
    return knownText.toUpperCase();
  }
  return titleCase(token);
}

/**
 * The display spelling of a model on its own: tokens the speaker wrote in capitals stay ("RX") and a
 * short alphanumeric name keeps its digits ("C300", "F-150"). Shared with the watch list so a saved
 * vehicle reads the way the nhtsa module writes it.
 */
export function displayVehicleModel(model: string): string {
  return model
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => displayModelToken(token))
    .join(" ");
}

/**
 * The model spelling for the answer, keeping the capitals the speaker or the agency used ("2021 Lexus
 * RX"). When the agency names the model, its full spelling wins, so "RX 350" is never cut to "RX", but
 * each agency token is still cased the way the speaker wrote it when the two line up ("ACCORD" -> "Accord").
 */
function displayModelName(spoken: string, known?: unknown): string {
  const spokenTokens = spoken.trim().split(/\s+/).filter(Boolean);
  const knownText = (typeof known === "string" ? known : "").trim();
  if (!knownText) return spokenTokens.map((token) => displayModelToken(token)).join(" ");
  const used = new Set<number>();
  return knownText
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const key = modelKey(token);
      const at = spokenTokens.findIndex((candidate, i) => !used.has(i) && modelKey(candidate) === key);
      if (at >= 0) {
        used.add(at);
        return displayModelToken(spokenTokens[at]!, token);
      }
      return displayModelToken(token, token);
    })
    .join(" ");
}

/** The model NHTSA filed the newest record under, spelled the way the agency writes it. */
function agencyModel(raw: unknown[]): string | undefined {
  for (const entry of raw) {
    if (!isNhtsaRecord(entry) || !isValidRecord(entry)) continue;
    if (typeof entry.Model === "string" && entry.Model.trim()) return entry.Model.trim();
  }
  return undefined;
}

/** The numbers a Mercedes-style "-Class" family is filed under: 300, 250, 350, 400, 450 and 43. */
const CLASS_NUMBERS = ["300", "250", "350", "400", "450", "43"];

/** The letter stem of a "-Class"/" Class" family ("C", "GLC"), or null. "CLA"/"CLS" stay their own models. */
function classStem(family: string): string | null {
  return /^([a-z]+)class$/.exec(modelKey(family))?.[1] ?? null;
}

/**
 * C-Class -> C300 and C 300, C250 and C 250, and so on. NHTSA files a numbered class model
 * sometimes joined and sometimes spaced, so both spellings of each number are tried.
 */
function classVariants(family: string): string[] {
  const stem = classStem(family);
  if (!stem) return [];
  const upper = stem.toUpperCase();
  return CLASS_NUMBERS.flatMap((n) => [`${upper}${n}`, `${upper} ${n}`]);
}

/** Body and drivetrain variants are not a model to point at: "C-CLASS PHEV" is not a different car. */
const VARIANT_WORD = /\b(?:PHEV|HYBRID|COUPE|CABRIO|CONVERTIBLE)\b/i;

/** A model the hint may name: not the family itself, not already searched, not a variant such as PHEV. */
function hintExample(related: string[], searched: string[], family: string): string | undefined {
  const familyKey = modelKey(family);
  const searchedKeys = new Set(searched.map(modelKey));
  return related.find((name) => {
    const key = modelKey(name);
    return key !== familyKey && !searchedKeys.has(key) && !VARIANT_WORD.test(name);
  });
}

function isNhtsaRecord(value: unknown): value is NhtsaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRecord(record: NhtsaRecord): boolean {
  return (
    typeof record.NHTSACampaignNumber === "string" &&
    record.NHTSACampaignNumber.trim().length > 0 &&
    parseDate(record.ReportReceivedDate) !== null
  );
}

function toRecall(record: NhtsaRecord, make: string, model: string, year: number): Recall {
  const id = clean(record.NHTSACampaignNumber, 64);
  const component = readableComponent(clean(record.Component, MAX_TITLE));
  const hazard = clean(record.Consequence, MAX_HAZARD) || clean(record.Summary, MAX_HAZARD);
  const remedy = clean(record.Remedy, MAX_REMEDY);
  const recall: Recall = {
    source: "nhtsa",
    id,
    date: parseDate(record.ReportReceivedDate) ?? "",
    title: clean(
      `${component} (${year} ${titleCase(make)} ${displayModelName(model, record.Model)})`,
      MAX_TITLE
    ),
    hazard,
    remedy,
    url: `${NHTSA_PAGE}${id}`,
  };
  if (record.parkIt === true || record.parkOutSide === true) {
    recall.severity = "high";
  }
  return recall;
}

async function requestJson<T>(url: string, fetchFn: FetchFn): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new SourceError(
      `NHTSA request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new SourceError(`NHTSA request returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new SourceError("NHTSA response was not valid JSON");
  }
}

/**
 * The vPIC model list for a make and year. Any failure here is a service failure, never an unknown
 * model: the caller must not turn a network problem into "your car is not listed".
 */
async function requestVpicModels(
  make: string,
  year: number,
  fetchFn: FetchFn
): Promise<string[]> {
  const cache = vpicCacheFor(fetchFn);
  const cacheKey = `${make.trim().toLowerCase()}|${year}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.names;
  const url = `${VPIC_ENDPOINT}/${encodeURIComponent(make)}/modelyear/${year}?format=json`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new SourceError(
      `${VEHICLE_SERVICE}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new SourceError(`${VEHICLE_SERVICE}: HTTP ${response.status}`);
  }
  let data: VpicResponse;
  try {
    data = (await response.json()) as VpicResponse;
  } catch {
    throw new SourceError(`${VEHICLE_SERVICE}: response was not valid JSON`);
  }
  // A 200 with an error body or no Results array is a service failure, never "the model is not listed".
  if (Array.isArray(data.Errors) && data.Errors.length > 0) {
    throw new SourceError(`${VEHICLE_SERVICE}: vPIC reported an error`);
  }
  if (!Array.isArray(data.Results)) {
    throw new SourceError(`${VEHICLE_SERVICE}: response had no model list`);
  }
  const names = (data.Results as unknown[])
    .filter((entry): entry is VpicModel => typeof entry === "object" && entry !== null)
    .map((entry) => entry.Model_Name)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  cache.set(cacheKey, { names, expires: Date.now() + VPIC_CACHE_TTL_MS });
  return names;
}

/**
 * When NHTSA answers a 400 or an empty list, ask vPIC whether the make and model exist for that year.
 * A listed model means "no recalls listed". An unlisted model is the only case called unknown. A vPIC
 * failure throws a service error so a real car is never reported as unknown or as having no recalls.
 */
async function confirmModel(
  make: string,
  model: string,
  year: number,
  fetchFn: FetchFn
): Promise<string> {
  const names = await requestVpicModels(make, year, fetchFn);
  const lookup = modelLookup(names, make, model);
  if (lookup.match) return lookup.match;
  if (lookup.options.length > 1) throw new AmbiguousVehicleError(lookup.options, lookup.truncated);
  throw new SourceError(`${UNKNOWN_VEHICLE}: ${make} ${model} ${year}`);
}

/**
 * The vPIC spelling of a model for a make and year, or undefined when vPIC names no single match.
 * The direct search only asks vPIC when NHTSA returns no recalls, so the watch add path calls this
 * for a model that already has recalls and saves the agency spelling instead of the typed one.
 */
export async function vpicModelName(make: string, model: string, year: number, fetchFn?: FetchFn): Promise<string | undefined> {
  const names = await requestVpicModels(make, year, fetchFn ?? fetch);
  return modelLookup(names, make, model).match ?? undefined;
}

/** The model name to put in the answer: a make-prefixed vPIC name keeps the spoken model ("Mazda 3"). */
function displayModel(make: string, spoken: string, match: string): string {
  const makeKey = modelKey(make);
  return makeKey && modelKey(match) === `${makeKey}${modelKey(spoken)}` ? spoken : match;
}

function vehicleQuery(make: string, model: string, year: number): string {
  // A vPIC name is already spelled the way the agency writes it ("GLC-Class"), so it is not recased.
  return `${year} ${titleCase(make)} ${model}`;
}

function withQuery(result: SearchResult, query: string): SearchResult {
  if (result.query === query) return result;
  const copy = { ...result, query };
  const note = vehicleNotes.get(result);
  if (note) vehicleNotes.set(copy, note);
  return copy;
}

/**
 * The related models NHTSA lists for this make and year. This is an optional enrichment, so a failure
 * here leaves the family answer intact instead of turning it into an unreachable source.
 */
async function requestRelatedModels(make: string, year: number, fetchFn: FetchFn): Promise<string[]> {
  const url =
    `${NHTSA_MODELS_ENDPOINT}?` +
    new URLSearchParams({ modelYear: String(year), make, issueType: "r" }).toString();
  try {
    const data = await requestJson<NhtsaModelsResponse>(url, fetchFn);
    const raw = Array.isArray(data.results) ? data.results : Array.isArray(data.Results) ? data.Results : [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as NhtsaModelEntry;
      const name = typeof record.model === "string" ? record.model : record.Model_Name;
      if (typeof name !== "string") continue;
      const trimmed = name.trim();
      const key = modelKey(trimmed);
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      names.push(trimmed);
    }
    return names;
  } catch {
    return [];
  }
}

interface RecallFetch {
  raw: unknown[];
  total: number;
}

/** One NHTSA recall request. A 400 is the API's way of saying this model has no recalls listed. */
async function fetchRecalls(make: string, model: string, year: number, fetchFn: FetchFn): Promise<RecallFetch> {
  const url =
    `${NHTSA_ENDPOINT}?` +
    new URLSearchParams({ make, model, modelYear: String(year) }).toString();
  let data: NhtsaResponse | null = null;
  try {
    data = await requestJson<NhtsaResponse>(url, fetchFn);
  } catch (error) {
    if (!(error instanceof SourceError) || !/HTTP 400/.test(error.message)) throw error;
  }
  const raw: unknown[] = data && Array.isArray(data.results) ? (data.results as unknown[]) : [];
  const total =
    data && typeof data.Count === "number" && data.Count >= 0
      ? data.Count
      : raw.length;
  return { raw, total };
}

function toRecalls(raw: unknown[], make: string, model: string, year: number): Recall[] {
  return raw
    .filter(isNhtsaRecord)
    .filter(isValidRecord)
    .map((record) => toRecall(record, make, model, year));
}

/**
 * A listed model belongs to the family when its key continues the family key (RX covers RX 350). A
 * "-Class" family also covers its numbered variants (C-Class covers C300, C43 and AMG C43), while
 * CLA and CLS stay separate models.
 */
function relatedModel(name: string, familyKey: string): boolean {
  const key = modelKey(name);
  if (key.startsWith(familyKey)) return true;
  const letter = /^([a-z])class$/.exec(familyKey)?.[1];
  if (!letter) return false;
  const compact = key.startsWith("amg") ? key.slice(3) : key;
  return compact.startsWith(letter) && /^\d/.test(compact.slice(1));
}

/** A model whose recalls may be merged into the user's total: only the numbered version of a "-Class" car. */
function isNumberedClassModel(name: string, mergeKeys: Set<string>): boolean {
  const key = modelKey(name);
  if (mergeKeys.has(key)) return true;
  return key.startsWith("amg") && mergeKeys.has(key.slice(3));
}

/**
 * RX350, RX350L and RX450h are the numbered versions of an RX, so they are the same car. The family key
 * must be followed directly by digits and optional letters. A name that adds a separate word, such as
 * Corolla Cross or F-150 Lightning, is a different vehicle and is never merged.
 */
function isNumberedFamilyModel(name: string, familyKey: string): boolean {
  const key = modelKey(name);
  if (!key.startsWith(familyKey)) return false;
  return /^\d+[a-z]*$/.test(key.slice(familyKey.length));
}

/**
 * Search the models listed under a family name (RX gives RX 350, RX 350L and so on). A "-Class"
 * family also tries the numbered models NHTSA really files it under (C300, C450, ...), which neither
 * list names. Only the numbered "-Class" models are the same car sold under a number, so only their
 * recalls are merged. A plain prefix relative such as Corolla Cross or F-150 Lightning is a different
 * vehicle: its recalls are never added to the user's total, only named separately. The number of
 * outbound sub-model calls is capped, and merged recalls are deduped by campaign.
 */
async function searchRelatedModels(
  make: string,
  family: string,
  year: number,
  fetchFn: FetchFn
): Promise<{ related: string[]; searched: string[]; filedUnder: string[]; relatedRecalls: RelatedModelRecall[]; recalls: Recall[] }> {
  const key = modelKey(family);
  // The products list names the versions NHTSA files recalls under. vPIC adds any family name it
  // lists separately, so the hint reflects every related model either list knows.
  const [listed, vpic] = await Promise.all([
    requestRelatedModels(make, year, fetchFn),
    requestVpicModels(make, year, fetchFn).catch(() => [] as string[]),
  ]);
  const names: string[] = [];
  const seenNames = new Set<string>();
  for (const name of [...listed, ...vpic]) {
    const nameKey = modelKey(name);
    if (!nameKey || seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    names.push(name);
  }
  const related = names.filter((name) => relatedModel(name, key));
  const synthesized = classVariants(family);
  const relatedModels: string[] = [];
  const seenRelated = new Set<string>();
  for (const name of [...related, ...synthesized]) {
    const nameKey = modelKey(name);
    if (!nameKey || seenRelated.has(nameKey)) continue;
    seenRelated.add(nameKey);
    relatedModels.push(name);
  }
  // The numbered models a "-Class" family is really filed under are tried before other versions of the
  // family, so the cap reaches them. Both spellings of each number go first, joined then spaced, since
  // either may be the one NHTSA filed the recalls under.
  const joined = synthesized.filter((name) => !/\s/.test(name));
  const spaced = synthesized.filter((name) => /\s/.test(name));
  const candidates: string[] = [];
  const seenCandidates = new Set<string>();
  const addCandidate = (name: string) => {
    const callKey = name.trim().toLowerCase().replace(/\s+/g, " ");
    if (!callKey || seenCandidates.has(callKey)) return;
    seenCandidates.add(callKey);
    candidates.push(name);
  };
  for (const name of [...joined, ...spaced, ...related]) {
    if (modelKey(name) === key) continue;
    addCandidate(name);
  }
  const searched = candidates.slice(0, MAX_SUBMODEL_CALLS);
  const settled = await Promise.allSettled(
    searched.map(async (model) => ({
      model,
      recalls: toRecalls((await fetchRecalls(make, model, year, fetchFn)).raw, make, model, year),
    }))
  );
  const mergeKeys = new Set(synthesized.map(modelKey));
  const recalls: Recall[] = [];
  const seen = new Set<string>();
  const filedUnder: string[] = [];
  const relatedRecalls: RelatedModelRecall[] = [];
  let failures = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      failures++;
      continue;
    }
    const found = result.value.recalls;
    if (found.length === 0) continue;
    const sameCar = isNumberedClassModel(result.value.model, mergeKeys)
      || isNumberedFamilyModel(result.value.model, key);
    if (sameCar) {
      let added = 0;
      for (const recall of found) {
        if (seen.has(recall.id)) continue;
        seen.add(recall.id);
        recalls.push(recall);
        added++;
      }
      // Only the spelling that actually brought new campaigns is named, so "C300" and "C 300" do not
      // both appear when they are the same car with the same recalls.
      if (added > 0) filedUnder.push(result.value.model);
    } else {
      // A different car that shares the name: named separately, never merged into the user's total.
      relatedRecalls.push({ model: result.value.model, count: found.length });
    }
  }
  // A failed sub-model check must not become a no-recalls answer for the whole family.
  if (failures > 0 && recalls.length === 0) {
    throw new SourceError(`${VEHICLE_SERVICE}: a related model check failed`);
  }
  // The spoken list names each number once: the spaced spelling is only an extra way to file it.
  const spokenSearched: string[] = [];
  const seenSearched = new Set<string>();
  for (const name of searched) {
    const searchedKey = modelKey(name);
    if (seenSearched.has(searchedKey)) continue;
    seenSearched.add(searchedKey);
    spokenSearched.push(name);
  }
  return { related: relatedModels, searched: spokenSearched, filedUnder, relatedRecalls, recalls: recalls.sort(byRecency) };
}

export async function searchVehicle(
  make: string,
  model: string,
  year: number,
  fetchFn?: FetchFn,
  canonicalRetry = true
): Promise<SearchResult> {
  validateYear(year);

  const doFetch = fetchFn ?? fetch;
  const first = await fetchRecalls(make, model, year, doFetch);

  if (first.raw.length > 0) {
    const direct = toRecalls(first.raw, make, model, year).sort(byRecency);
    const shown = displayModelName(model, agencyModel(first.raw));
    const query = `${year} ${titleCase(make)} ${shown}`;
    // A family can have a recall of its own while its numbered versions have more (RX and RX350).
    // Only a short direct list needs the family search; a full five already fills the spoken answer.
    if (first.total < MAX_RESULTS) {
      const family = await searchRelatedModels(make, model, year, doFetch).catch(() => null);
      if (family && family.recalls.length > 0) {
        const merged: Recall[] = [];
        const seen = new Set<string>();
        for (const recall of [...direct, ...family.recalls]) {
          if (seen.has(recall.id)) continue;
          seen.add(recall.id);
          merged.push(recall);
        }
        merged.sort(byRecency);
        const result: SearchResult = {
          query,
          source: "nhtsa",
          total: merged.length,
          recalls: merged.slice(0, MAX_RESULTS),
        };
        vehicleNotes.set(result, {
          model: shown,
          relatedModels: family.related,
          searchedModels: family.searched,
          filedUnder: family.filedUnder,
          relatedRecalls: family.relatedRecalls,
          example: hintExample(family.related, family.searched, model),
        });
        return result;
      }
    }
    return {
      query,
      source: "nhtsa",
      total: first.total,
      recalls: direct.slice(0, MAX_RESULTS),
    };
  }

  const match = await confirmModel(make, model, year, doFetch);
  const canonical = displayModel(make, model, match);
  const query = vehicleQuery(make, canonical, year);

  if (canonicalRetry && modelKey(match) !== modelKey(model)) {
    // NHTSA files recalls under the vPIC model name, so "3" for Mazda is searched again as "Mazda3"
    // and "Accordion" is searched as "Accord" before the answer can say that nothing is listed.
    const again = await searchVehicle(make, match, year, doFetch, false);
    const result = withQuery(again, query);
    const found = vehicleNotes.get(result);
    vehicleNotes.set(result, {
      model: canonical,
      relatedModels: found?.relatedModels ?? [],
      searchedModels: found?.searchedModels ?? [],
      filedUnder: found?.filedUnder ?? [],
      relatedRecalls: found?.relatedRecalls ?? [],
      example: found?.example,
    });
    return result;
  }

  const related = await searchRelatedModels(make, match, year, doFetch);
  const note: VehicleSearchNote = {
    model: canonical,
    relatedModels: related.related,
    searchedModels: related.searched,
    filedUnder: related.filedUnder,
    relatedRecalls: related.relatedRecalls,
    example: hintExample(related.related, related.searched, match),
  };
  const result: SearchResult = related.recalls.length > 0
    ? {
        query,
        source: "nhtsa",
        total: related.recalls.length,
        recalls: related.recalls.slice(0, MAX_RESULTS),
      }
    : { query, source: "nhtsa", total: 0, recalls: [] };
  vehicleNotes.set(result, note);
  return result;
}
