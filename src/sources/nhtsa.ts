import { FETCH_TIMEOUT_MS, Recall, SearchResult, SourceError } from "../types";
import { byRecency } from "../rank.js";

const NHTSA_ENDPOINT = "https://api.nhtsa.gov/recalls/recallsByVehicle";
const VPIC_ENDPOINT = "https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make";
const NHTSA_PAGE = "https://www.nhtsa.gov/recalls?nhtsaId=";
const MIN_YEAR = 1950;
const MAX_RESULTS = 5;
const MAX_TITLE = 120;
const MAX_HAZARD = 300;
const MAX_REMEDY = 300;

// Two distinct failures a caller must never mix up. An unknown model is a real answer from vPIC that
// the vehicle is not listed. A service error means vPIC could not be reached, so nothing is known.
const UNKNOWN_VEHICLE = "nhtsa: does not list that make and model for that year";
const VEHICLE_SERVICE = "nhtsa: vehicle service is unavailable";

export const UNKNOWN_VEHICLE_MESSAGE = UNKNOWN_VEHICLE;

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
}

/** "F-150", "F150" and "F 150" all become "f150", so a spoken model matches the vPIC spelling. */
function modelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
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
      `${component} (${year} ${titleCase(make)} ${titleCase(model)})`,
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
  const results: unknown[] = Array.isArray(data.Results) ? data.Results : [];
  return results
    .filter((entry): entry is VpicModel => typeof entry === "object" && entry !== null)
    .map((entry) => entry.Model_Name)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
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
): Promise<void> {
  const names = await requestVpicModels(make, year, fetchFn);
  const wanted = modelKey(model);
  if (wanted && names.some((name) => modelKey(name) === wanted)) return;
  throw new SourceError(`${UNKNOWN_VEHICLE}: ${make} ${model} ${year}`);
}

export async function searchVehicle(
  make: string,
  model: string,
  year: number,
  fetchFn?: FetchFn
): Promise<SearchResult> {
  validateYear(year);

  const url =
    `${NHTSA_ENDPOINT}?` +
    new URLSearchParams({ make, model, modelYear: String(year) }).toString();

  const doFetch = fetchFn ?? fetch;
  let data: NhtsaResponse | null = null;
  try {
    data = await requestJson<NhtsaResponse>(url, doFetch);
  } catch (error) {
    // A 400 is not "unknown" on its own: the recalls API answers 400 for a real model with no recalls.
    if (!(error instanceof SourceError) || !/HTTP 400/.test(error.message)) throw error;
  }

  const raw: unknown[] = data && Array.isArray(data.results) ? (data.results as unknown[]) : [];

  if (raw.length === 0) {
    await confirmModel(make, model, year, doFetch);
    return {
      query: `${year} ${titleCase(make)} ${titleCase(model)}`,
      source: "nhtsa",
      total: 0,
      recalls: [],
    };
  }

  const total =
    data && typeof data.Count === "number" && data.Count >= 0
      ? data.Count
      : raw.length;

  const recalls = raw
    .filter(isNhtsaRecord)
    .filter(isValidRecord)
    .map((record) => toRecall(record, make, model, year))
    .sort(byRecency)
    .slice(0, MAX_RESULTS);

  return {
    query: `${year} ${titleCase(make)} ${titleCase(model)}`,
    source: "nhtsa",
    total,
    recalls,
  };
}
