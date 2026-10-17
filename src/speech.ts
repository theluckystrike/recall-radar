import type { Recall, SearchResult, Source } from "./types";

// Voice answers for Alexa+. One recall is read in full, then the count of the others.
// Target: about 50 words, never more than 70. The structured result keeps every detail.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const SOURCE_NAMES: Record<Source, string> = {
  nhtsa: "the NHTSA vehicle database",
  cpsc: "the Consumer Product Safety Commission",
  "fda-food": "the FDA food recall list",
  "fda-drug": "the FDA drug recall list",
};

const MAX_WORDS_SENTENCE = 26;
const MAX_WORDS_TITLE = 9;

function monthYear(date: string): string {
  const [year = "", month = ""] = date.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : year;
}

function words(text: string, max: number): string {
  const list = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const cut = list.slice(0, max).join(" ").replace(/[\s,;:.-]+$/, "");
  return list.length > max ? cut : cut.replace(/\.{3}$/, "");
}

/** First sentence, ending with a period. A long sentence is cut at its last comma inside the word limit. */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").replace(/\.{3}$/, "").trim();
  if (t === "") return "";
  const match = /^.+?[.!?](?=\s|$)/.exec(t);
  const whole = match ? match[0] : t;
  let sentence = words(whole, MAX_WORDS_SENTENCE);
  if (sentence.split(" ").length < whole.split(" ").length) {
    const comma = sentence.lastIndexOf(",");
    if (comma > 20) sentence = sentence.slice(0, comma);
  }
  sentence = sentence.replace(/[\s,;:-]+$/, "");
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Keep the core of a long safety sentence: cut at "because", ", posing", ", which" after the first 8 words. */
function core(sentence: string): string {
  if (sentence.split(" ").length <= 16) return sentence;
  const m = /^(.{40,}?)(?:,?\s+because\s|,\s*posing\s|\s+posing\s|,\s*which\s|,\s*and\s)/i.exec(sentence);
  return m?.[1] ? `${m[1].replace(/[\s,;:-]+$/, "")}.` : sentence;
}

const MAX_WORDS_ANSWER = 70;

/** Agency acronyms a voice cannot read: say what they mean. */
const ACRONYMS: Array<[RegExp, string]> = [[/\bc?GMP Deviations?\b/gi, "Manufacturing quality problems"], [/\bCGMP\b|\bcGMP\b/g, "manufacturing quality"], [/\bMBUSA\b/g, "Mercedes-Benz USA"], [/\bFMVSS\b/g, "federal safety standard"], [/\bUPC\b/g, "product code"]];
const expand = (t: string) => ACRONYMS.reduce((acc, [re, rep]) => acc.replace(re, rep), t);

function lowerIfShouting(text: string): string {
  text = expand(text);
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length > 3 && letters === letters.toUpperCase() ? text.toLowerCase() : text;
}

/** "AIR BAGS:SENSOR:OCCUPANT..." -> "the air bags, sensor" (the component, readable). */
function vehicleTitle(title: string): string {
  const component = title.replace(/\s*\(.*\)\s*$/, "");
  const system = component.split(":").map((p) => p.trim().toLowerCase()).find(Boolean);
  return system ? `the ${system.split(",")[0]!.trim()}` : "a vehicle part";
}

/** "Firm Recalls Product Due to Risk..." -> "Product from Firm"; "Product Recalled Due to..." -> "Product". */
function productTitle(title: string): string {
  const t = title.replace(/\.{3}$/, "").replace(/\s+Reannounces Recall of\s+/i, " Recalls ").replace(/\s+and Other Models of\s+/i, " ");
  // The firm is the capitalised words right before "Recalls"; "to Inspect" style verbs after it are dropped.
  const recalls = /([A-Z0-9][\w&'.-]*(?:\s+[A-Z0-9][\w&'.-]*){0,3})\s+Recalls\s+(?:to\s+\w+\s+)?(.+?)(?:\s+Due to\b|\s+Following\b|;|$)/.exec(t);
  if (recalls?.[1] && recalls[2]) return `${tidy(words(recalls[2].replace(/^\d[\d.,]*\s+(Million|Thousand)\s+/i, ""), MAX_WORDS_TITLE))} from ${words(recalls[1], 4)}`;
  const recalled = /^(.+?)\s+(?:Are\s+|Is\s+)?Recalled\b/i.exec(t);
  return tidy(words(recalled?.[1] ?? t.split(/\s+Due to\b|;/i)[0] ?? t, MAX_WORDS_TITLE));
}

/** FDA product descriptions carry sizes, UPC codes and ingredients: keep the product name only. */
function tidy(title: string): string {
  return title.replace(/\b\d+\s*\/\s*\d+\s*("|in\b|inch)?/gi, " ").replace(/\s+/g, " ").replace(/\s(of|and|the|with|for|to|in|or|are|is|was|were)$/i, "").trim();
}

function fdaTitle(title: string): string {
  title = title.replace(/^\s*(?:\d+(?:\.\d+)?\s*(?:lbs?|oz|ounces?|g|kg|ct|count|pk|pack|cases?)\.?\s*)+/i, "");
  const name = title.split(/,|;|\.\s|\s+-\s+|\(|#|\bLOT\b|\bBIN\b|\bContains\b|\bpackaged\b|\bPacked\b|\bUPC\b|\bNDC\b|\bNET\s*WT\b|\bINGREDIENTS\b|\d+(?:\.\d+)?\s*(?:oz|g|kg|lb|ml|mg|fl)\b/i)[0] ?? title;
  return tidy(words(lowerIfShouting(name), MAX_WORDS_TITLE)) || "a product";
}

/** FDA records often abbreviate ("Ctrzne Alrgy All Dy Tblt"): mostly vowel-less words cannot be read aloud. */
function garbled(title: string): boolean {
  const shouting = title.replace(/[^A-Za-z]/g, "") === title.replace(/[^A-Za-z]/g, "").toUpperCase();
  // In an ALL CAPS record every word looks like an acronym, so only skip short capitals in mixed-case text.
  const list = title.split(/\s+/).slice(0, 12).map((w) => w.replace(/[^a-z]/gi, "")).filter((w) => w.length > 0 && (shouting || !/^[A-Z]{2,4}$/.test(w)));
  // Unreadable: 4+ letters and no a, e, i, o, u after the first letter ("Tblt", "Alrgy"). "Dry" and "BBQ" stay readable.
  const bad = list.filter((w) => w.length >= 4 && !/[aeiou]/i.test(w.slice(1))).length;
  return bad >= 2 && bad / Math.max(1, list.length) >= 0.15;
}

export function spokenTitle(recall: Recall, query = ""): string {
  if (recall.source !== "nhtsa" && recall.source !== "cpsc" && garbled(recall.title)) return query ? `a product listed under ${query}` : "a listed product";
  if (recall.source === "nhtsa") return vehicleTitle(recall.title);
  if (recall.source === "cpsc") return productTitle(recall.title);
  return fdaTitle(recall.title);
}

function detail(recall: Recall, query = ""): string {
  const important = recall.severity === "high" ? "Important. " : "";
  const what = recall.source === "nhtsa" ? `It affects ${spokenTitle(recall)}.` : `It is ${spokenTitle(recall, query)}.`;
  const raw = core(firstSentence(lowerIfShouting(recall.hazard)));
  // FDA reasons are often fragments ("Undeclared milk"): say where the words come from.
  const hazard = recall.source.startsWith("fda") && raw.split(" ").length < 6 ? `The FDA gives the reason as: ${raw}` : raw;
  const pharmacist = recall.source === "fda-drug" ? "Ask a pharmacist before you stop taking a medicine." : "";
  const remedy = core(firstSentence(recall.remedy));
  return [`${important}The newest is from ${monthYear(recall.date)}.`, what, hazard, remedy, pharmacist].filter(Boolean).join(" ");
}

/** The search note "(matched by graco and play)" is for screens, not for the ear. */
const spokenQuery = (q: string) => q.replace(/\s*\(matched by [^)]*\)\s*$/, "");

const mention = (n: number) => (n === 1 ? "that mentions" : "that mention");

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The structured result holds the newest 5, so "more" offers at most the next 4. */
function others(total: number, held: number): string {
  const rest = total - 1;
  if (rest <= 0) return "";
  const next = Math.min(rest, Math.max(0, held - 1));
  const say = next > 0 ? ` Say "more" to hear the next ${next === 1 ? "one" : next}.` : "";
  return ` There ${rest === 1 ? "is 1 more" : `are ${rest} more`}.${say}`;
}

/** Hard budget for one spoken answer: drop the remedy sentence first, then the hazard, until it fits. */
function fit(lead: string, recall: Recall, tail: string, query = ""): string {
  const full = `${lead} ${detail(recall, query)}${tail}`;
  if (full.split(" ").length <= MAX_WORDS_ANSWER) return full;
  const lean = `${lead} ${detail({ ...recall, remedy: "" }, query)}${tail}`;
  if (lean.split(" ").length <= MAX_WORDS_ANSWER) return lean;
  return `${lead} ${detail({ ...recall, remedy: "", hazard: "" }, query)}${tail}`;
}

/** One short sentence per further recall, for "more": "From March 2023: the seat belts. Dealers will replace the buckles." */
export function followUps(recalls: Recall[]): string[] {
  return recalls.slice(1, 5).map((r) => {
    const what = r.source === "nhtsa" ? spokenTitle(r) : spokenTitle(r);
    const why = core(firstSentence(lowerIfShouting(r.hazard)));
    const line = `From ${monthYear(r.date)}: ${tidy(what)}. ${why}`.replace(/\s+(in|of|and|the|with|for|to|from)\.$/i, ".").trim();
    return line.split(" ").length > 35 ? `${line.split(" ").slice(0, 35).join(" ").replace(/[\s,;:-]+$/, "")}.` : line;
  });
}

export function speak(result: SearchResult): string {
  const first = result.recalls[0];
  if (result.total <= 0 || !first) {
    return `I found no recalls for ${spokenQuery(result.query)} in ${SOURCE_NAMES[result.source]}. That does not prove it is safe, only that nothing is listed.`;
  }
  const matched = /\(matched by /.test(result.query);
  const lead = result.source === "nhtsa" ? `I found ${count(result.total, "recall")} for the ${result.query}.`
    : `I found ${count(result.total, "recall")} ${matched ? "matching" : mention(result.total)} ${spokenQuery(result.query)}.`;
  return fit(lead, first, others(result.total, result.recalls.length), spokenQuery(result.query));
}

export function speakMany(results: SearchResult[], failed: Source[] = []): string {
  if (!failed.length) return speakManyCore(results);
  // Say what was NOT checked first, so a partial "no recalls" is never heard as a full one.
  const missing = `I could not reach ${failed.map((f) => SOURCE_NAMES[f]).join(" or ")}, so this answer is incomplete.`;
  return `${missing} ${speakManyCore(results).replace("in the product, food or drug recall lists", "in the lists I could reach")}`;
}

function speakManyCore(results: SearchResult[]): string {
  const query = spokenQuery(results.find((r) => r.query)?.query ?? "");
  const total = results.reduce((sum, r) => sum + r.total, 0);
  const newest = results.flatMap((r) => r.recalls).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (total <= 0 || !newest) {
    return `I found no recalls for ${query} in the product, food or drug recall lists. That does not prove it is safe, only that nothing is listed.`;
  }
  const held = results.reduce((sum, r) => sum + r.recalls.length, 0);
  return fit(`I found ${count(total, "recall")} ${results.some((r) => /\(matched by /.test(r.query)) ? "matching" : mention(total)} ${query}.`, newest, others(total, held), query);
}
