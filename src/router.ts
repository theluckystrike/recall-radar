// Turns one spoken sentence into one tool call, without a language model. It stands in for the Alexa+ model in the simulator.
// Safety rule: when the kind of item is not clear, search every source (check_all_recalls) instead of guessing one.

import { cleanItem, stripAccents } from "./query.js";

export type RouteResult =
  | { tool: "check_vehicle_recalls"; args: { year: number; make: string; model: string } }
  | { tool: "search_food_recalls" | "search_drug_recalls" | "search_product_recalls" | "check_all_recalls"; args: { query: string } }
  | { tool: "ask_vehicle"; args: { make: string; model: string; missing: "year" | "model" } }
  | { tool: "add_to_watch_list"; args: { year: number; make: string; model: string } | { item: string } }
  | { tool: "remove_from_watch_list"; args: { item: string } }
  | { tool: "check_my_watch_list"; args: Record<string, never> }
  | { tool: "more"; args: Record<string, never> };

/** Spoken alias -> NHTSA make name. Longest aliases are matched first. */
export const MAKES: Record<string, string> = {
  "acura": "acura", "alfa romeo": "alfa romeo", "alfa": "alfa romeo", "audi": "audi", "bmw": "bmw", "buick": "buick",
  "cadillac": "cadillac", "chevrolet": "chevrolet", "chevy": "chevrolet", "chrysler": "chrysler", "dodge": "dodge",
  "fiat": "fiat", "ford": "ford", "genesis": "genesis", "gmc": "gmc", "harley davidson": "harley-davidson", "harley": "harley-davidson",
  "honda": "honda", "hyundai": "hyundai", "infiniti": "infiniti", "jaguar": "jaguar", "jeep": "jeep", "kia": "kia",
  "land rover": "land rover", "range rover": "land rover", "lexus": "lexus", "lincoln": "lincoln", "lucid": "lucid", "mazda": "mazda",
  "mercedes benz": "mercedes-benz", "mercedes": "mercedes-benz", "benz": "mercedes-benz", "mini": "mini", "mitsubishi": "mitsubishi",
  "nissan": "nissan", "polestar": "polestar", "porsche": "porsche", "ram": "ram", "rivian": "rivian", "subaru": "subaru",
  "tesla": "tesla", "toyota": "toyota", "volkswagen": "volkswagen", "vw": "volkswagen", "volvo": "volvo",
};

/** Spoken model -> NHTSA model name, where they differ. */
export const MODEL_FIX: Record<string, string> = {
  "f150": "f-150", "f 150": "f-150", "f250": "f-250", "f 250": "f-250", "f350": "f-350", "f 350": "f-350",
  "crv": "cr-v", "cr v": "cr-v", "hrv": "hr-v", "hr v": "hr-v", "cx5": "cx-5", "cx 5": "cx-5", "cx9": "cx-9", "cx 9": "cx-9",
  "rav 4": "rav4", "silverado": "silverado 1500", "sierra": "sierra 1500", "model three": "model 3", "model why": "model y",
};

/** "Chevy" -> "chevrolet" and "Mercedes-Benz" -> "mercedes-benz", for tool input as well as speech. */
export function normalizeMake(make: string): string {
  const key = make.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return MAKES[key] ?? key;
}

/** "f150" -> "f-150" and "Silverado" -> "silverado 1500", for tool input as well as speech. */
export function normalizeModel(model: string): string {
  const key = model.toLowerCase().replace(/\s+/g, " ").trim();
  return MODEL_FIX[key] ?? MODEL_FIX[key.replace(/-/g, " ")] ?? key;
}

const FILLERS = new Set(["is", "my", "the", "a", "an", "any", "are", "there", "was", "were", "has", "have", "had", "been", "did", "they",
  "recall", "recalls", "recalled", "on", "for", "of", "check", "about", "please", "alexa", "tell", "me", "if", "whether", "our", "this", "that",
  "it", "do", "does", "know", "you", "can", "could", "find", "look", "up", "safety", "issue", "issues", "problem", "problems", "with", "new", "i", "we", "in", "at", "from", "any", "what", "about"]);

/** Multi-word phrases first, so "cough syrup" is a medicine before "syrup" is a food. Values: [kind, query to send]. */
const PHRASES: Array<[string, "drug" | "food", string]> = [
  ["cough syrup", "drug", "cough syrup"], ["eye drops", "drug", "eye drops"], ["eye drop", "drug", "eye drops"], ["nasal spray", "drug", "nasal spray"],
  ["hand sanitizer", "drug", "hand sanitizer"], ["sanitizer", "drug", "hand sanitizer"], ["sunscreen", "drug", "sunscreen"],
  ["baby formula", "food", "infant formula"], ["infant formula", "food", "infant formula"], ["formula", "food", "infant formula"],
  ["similac", "food", "similac"], ["enfamil", "food", "enfamil"], ["baby food", "food", "baby food"], ["dog food", "food", "dog food"],
  ["cat food", "food", "cat food"], ["pet food", "food", "pet food"], ["hot dogs", "food", "hot dog"], ["hot dog", "food", "hot dog"],
  ["deli meat", "food", "deli meat"], ["frozen vegetables", "food", "frozen vegetables"], ["alfalfa sprouts", "food", "alfalfa sprouts"],
  ["peanut butter", "food", "peanut butter"], ["ice cream", "food", "ice cream"], ["olive oil", "food", "olive oil"],
];

const DRUG_WORDS = new Set(["ibuprofen", "acetaminophen", "paracetamol", "tylenol", "advil", "motrin", "aleve", "naproxen", "aspirin",
  "excedrin", "metformin", "lisinopril", "amlodipine", "atorvastatin", "lipitor", "simvastatin", "losartan", "valsartan", "omeprazole",
  "prilosec", "nexium", "pantoprazole", "levothyroxine", "synthroid", "gabapentin", "sertraline", "zoloft", "fluoxetine", "prozac",
  "escitalopram", "lexapro", "bupropion", "wellbutrin", "adderall", "ritalin", "xanax", "alprazolam", "ozempic", "wegovy", "semaglutide",
  "insulin", "albuterol", "prednisone", "amoxicillin", "azithromycin", "zyrtec", "cetirizine", "claritin", "loratadine", "benadryl",
  "diphenhydramine", "mucinex", "nyquil", "dayquil", "robitussin", "pepto", "imodium", "zantac", "ranitidine", "famotidine", "pepcid",
  "melatonin", "viagra", "sildenafil", "warfarin", "clopidogrel", "plavix", "eliquis", "metoprolol", "hydrochlorothiazide",
  "medicine", "medication", "tablets", "tablet", "capsules", "capsule", "pills", "pill", "ointment", "inhaler", "antacid", "laxative"]);

const FOOD_WORDS = new Set(["apple", "banana", "orange", "grape", "strawberry", "blueberry", "raspberry", "cherry", "peach", "pear", "plum",
  "pineapple", "mango", "avocado", "lemon", "lime", "cantaloupe", "melon", "watermelon", "milk", "cheese", "yogurt", "butter", "cream",
  "egg", "bread", "bagel", "cereal", "oatmeal", "oat", "rice", "pasta", "noodle", "soup", "salad", "chicken", "beef", "pork", "turkey",
  "ham", "bacon", "sausage", "liverwurst", "salami", "fish", "salmon", "tuna", "shrimp", "crab", "oyster", "bean", "pea", "lentil",
  "hummus", "peanut", "almond", "cashew", "walnut", "pecan", "pistachio", "spinach", "lettuce", "kale", "broccoli", "carrot", "onion",
  "garlic", "potato", "tomato", "cucumber", "pepper", "corn", "squash", "zucchini", "mushroom", "celery", "cabbage", "sprout", "sugar",
  "honey", "syrup", "jam", "flour", "spice", "cinnamon", "chocolate", "candy", "cookie", "cracker", "chip", "pretzel", "granola",
  "popcorn", "pizza", "sandwich", "burrito", "salsa", "sauce", "ketchup", "mayonnaise", "dressing", "juice", "soda", "coffee", "tea",
  "smoothie", "tofu", "vegetable", "fruit", "berry", "seafood", "meat", "snack", "dessert", "cake", "pie", "muffin", "tortilla"]);

/** Popular models spoken without a make: "my 2018 accord". */
const MODEL_MAKE: Record<string, string> = {
  "accord": "honda", "civic": "honda", "cr-v": "honda", "pilot": "honda", "odyssey": "honda", "camry": "toyota", "corolla": "toyota",
  "rav4": "toyota", "highlander": "toyota", "tacoma": "toyota", "tundra": "toyota", "prius": "toyota", "f-150": "ford", "explorer": "ford",
  "escape": "ford", "mustang": "ford", "silverado 1500": "chevrolet", "equinox": "chevrolet", "malibu": "chevrolet", "altima": "nissan",
  "rogue": "nissan", "sentra": "nissan", "outback": "subaru", "forester": "subaru", "elantra": "hyundai", "tucson": "hyundai",
  "sonata": "hyundai", "jetta": "volkswagen", "wrangler": "jeep", "grand cherokee": "jeep", "model 3": "tesla", "model y": "tesla",
};

/** Words that mark a thing as a product even when a food word appears ("rice cooker", "apple watch"). */
const PRODUCT_NOUNS = new Set(["watch", "spray", "cooker", "maker", "cup", "bottle", "toy", "crib", "stroller", "seat", "heater", "dresser",
  "machine", "charger", "battery", "helmet", "bike", "bicycle", "scooter", "lamp", "blender", "kettle", "fryer", "oven", "stove", "chair",
  "gate", "monitor", "carrier", "swing", "bassinet", "mattress", "pacifier", "sippy", "phone", "laptop", "cable", "light", "treadmill",
  "tread", "dryer", "washer", "fridge", "refrigerator", "dishwasher", "microwave", "toaster", "grill", "fan", "vacuum", "drill", "saw",
  "jacket", "shirt", "shoe", "boot", "hat", "costume", "doll", "game", "book", "table", "desk", "bed", "sofa", "couch", "rug", "candle"]);

const SPOKEN_TENS: Record<string, number> = { "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
  "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "twenty one": 21, "twenty two": 22, "twenty three": 23,
  "twenty four": 24, "twenty five": 25, "twenty six": 26, "twenty seven": 27, "oh one": 1, "oh two": 2, "oh three": 3, "oh four": 4,
  "oh five": 5, "oh six": 6, "oh seven": 7, "oh eight": 8, "oh nine": 9 };

/** "twenty eighteen" / "two thousand eighteen" / "two thousand and eighteen" -> "2018". */
function spokenYears(text: string): string {
  let out = text;
  for (const [words, n] of Object.entries(SPOKEN_TENS).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\btwo thousand (?:and )?${words}\\b`, "g"), String(2000 + n));
    if (n >= 10) out = out.replace(new RegExp(`\\btwenty ${words}\\b`, "g"), String(2000 + n));
    if (n >= 50 && n <= 99) out = out.replace(new RegExp(`\\bnineteen ${words}\\b`, "g"), String(1900 + n));
  }
  return out.replace(/\btwo thousand\b/g, "2000");
}

// Letters from any script are kept here so a query with no Latin letters reaches the server's validation,
// which refuses it with the English letters message instead of searching a shortened phrase.
const normalize = (text: string) => stripAccents(text).toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'&\- ]+/gu, " ").replace(/\s+/g, " ").trim();
const singular = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && /(ches|shes|oes)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

function findYear(words: string[]): number | null {
  const max = new Date().getUTCFullYear() + 1;
  const hit = words.map(Number).find((n) => Number.isInteger(n) && n >= 1950 && n <= max);
  return hit ?? null;
}

function findMake(text: string): { alias: string; make: string; at: number } | null {
  text = text.replace(/-/g, " ");
  const aliases = Object.keys(MAKES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const at = ` ${text} `.indexOf(` ${alias} `);
    if (at >= 0) return { alias, make: MAKES[alias] ?? alias, at };
  }
  return null;
}

/** Model = up to 3 words after the make, stopping at filler words; spoken forms fixed for NHTSA. */
function findModel(text: string, found: { alias: string; at: number }, year: number | null): string {
  const after = text.replace(/-/g, " ").slice(found.at + found.alias.length).trim().split(" ").filter((w) => w && w !== String(year));
  const kept: string[] = [];
  for (const w of after.slice(0, 4)) {
    if (FILLERS.has(w)) break;
    if (w.endsWith("'s")) { kept.push(w.slice(0, -2)); break; } // "accord's airbag" -> "accord"
    kept.push(w);
    if (kept.length === 3) break;
  }
  const model = kept.join(" ");
  if (found.alias === "range rover" && !model) return "range rover";
  const fixed = MODEL_FIX[model] ?? MODEL_FIX[model.replace(/-/g, " ")] ?? model;
  return fixed.replace(/^model (\d|[sxy3])$/, "model $1");
}

/** "my 2018 accord": a known model with a year but no make. */
function modelOnly(words: string[], year: number | null): RouteResult | null {
  if (year === null) return null;
  for (const [model, make] of Object.entries(MODEL_MAKE)) {
    if (` ${words.join(" ").replace(/-/g, " ")} `.includes(` ${model.replace(/-/g, " ")} `)) return { tool: "check_vehicle_recalls", args: { year, make, model } };
  }
  return null;
}

function vehicleRoute(text: string, words: string[]): RouteResult | null {
  const found = findMake(text);
  if (!found) return modelOnly(words, findYear(words));
  const year = findYear(words);
  const model = findModel(text, found, year);
  if (!model) return { tool: "ask_vehicle", args: { make: found.make, model: "", missing: "model" } };
  if (year === null) return { tool: "ask_vehicle", args: { make: found.make, model, missing: "year" } };
  return { tool: "check_vehicle_recalls", args: { year, make: found.make, model } };
}

function itemQuery(words: string[]): string {
  return words.filter((w) => !FILLERS.has(w)).join(" ").replace(/'s\b/g, "").trim().slice(0, 60);
}

/** Only the phrases whose search form differs from the spoken form. Longest first, so "baby formula" wins over "formula". */
const PHRASE_SYNONYMS: Array<[string, string]> = PHRASES
  .filter(([phrase, , target]) => phrase !== target)
  .map(([phrase, , target]) => [phrase, target] as [string, string])
  .sort((a, b) => b[0].length - a[0].length);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The item words with generic synonyms swapped, keeping everything else the person said:
 * "similac baby formula" -> "similac infant formula", "baby formula" -> "infant formula".
 * A one word synonym only expands when it is the whole item, so a brand is never dropped:
 * "byheart formula" stays "byheart formula" and "purell sanitizer" keeps its brand.
 */
function synonymQuery(text: string): string {
  let out = itemQuery(cleanItem(text).split(" "));
  for (const [phrase, target] of PHRASE_SYNONYMS) {
    if (phrase.includes(" ")) out = out.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "g"), target);
    else if (out === phrase) out = target;
  }
  return out;
}

const WATCH_LIST = "(?:my\\s+)?(?:watch\\s*list|watchlist|list)";

function watchCheck(text: string): boolean {
  return new RegExp(`^(?:check|show|read|open|watch)\\s+${WATCH_LIST}$`).test(text)
    || new RegExp(`^(?:anything|any|what'?s|what is|is there anything)\\s+new\\s+(?:on|in)\\s+${WATCH_LIST}$`).test(text)
    || new RegExp(`^what(?:'s| is)\\s+on\\s+${WATCH_LIST}$`).test(text);
}

function watchRemove(text: string): RouteResult | null {
  const found = new RegExp(`^(?:remove|delete|take|drop)\\s+(.+?)(?:\\s+(?:from|off)\\s+${WATCH_LIST})?$`).exec(text);
  const item = itemQuery((found?.[1] ?? "").split(" "));
  return item ? { tool: "remove_from_watch_list", args: { item } } : null;
}

function watchAdd(text: string): RouteResult | null {
  const found = new RegExp(`^(?:add|put|save)\\s+(.+?)\\s+(?:to|on)\\s+${WATCH_LIST}$`).exec(text);
  let payload = found?.[1] ?? "";
  if (!payload && text.startsWith("watch ")) {
    const rest = text.slice(6);
    if (!new RegExp(`^${WATCH_LIST}$`).test(rest)) payload = rest;
  }
  if (!payload) return null;
  const vehicle = vehicleRoute(payload, payload.split(" "));
  if (vehicle?.tool === "check_vehicle_recalls") return { tool: "add_to_watch_list", args: vehicle.args };
  const item = itemQuery(payload.split(" "));
  return item ? { tool: "add_to_watch_list", args: { item } } : null;
}

export function route(utterance: string): RouteResult | null {
  const text = spokenYears(normalize(utterance ?? "").slice(0, 200));
  if (!text) return null;
  if (/^(never ?mind|cancel|stop|forget it|no thanks|nothing)$/.test(text)) return null;
  if (/^(more|next|tell me more|the others|what else|keep going|go on|and the others)$/.test(text) || (text.split(" ").length <= 6 && /\b(next one|next recall|more recalls|the rest|the others)\b/.test(text))) return { tool: "more", args: {} };
  if (watchCheck(text)) return { tool: "check_my_watch_list", args: {} };
  const removed = watchRemove(text);
  if (removed) return removed;
  const added = watchAdd(text);
  if (added) return added;
  const words = text.split(" ");
  const vehicle = vehicleRoute(text, words);
  if (vehicle) return vehicle;
  for (const [phrase, kind, target] of PHRASES) {
    // An unchanged phrase is already the canonical search form ("cough syrup"); a synonym keeps the other words ("Similac baby formula").
    if (` ${text} `.includes(` ${phrase} `)) return { tool: kind === "drug" ? "search_drug_recalls" : "search_food_recalls", args: { query: target === phrase ? phrase : synonymQuery(text) } };
  }
  const query = itemQuery(words);
  if (!query) return null;
  const items = query.split(" ").map(singular);
  // A product noun wins over a food word ("rice cooker"); unclear things search every source.
  if (items.some((w) => PRODUCT_NOUNS.has(w))) return { tool: "check_all_recalls", args: { query } };
  if (items.some((w) => DRUG_WORDS.has(w))) return { tool: "search_drug_recalls", args: { query } };
  if (items.some((w) => FOOD_WORDS.has(w))) return { tool: "search_food_recalls", args: { query } };
  return { tool: "check_all_recalls", args: { query } };
}
