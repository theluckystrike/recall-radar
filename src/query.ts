// Server-side query hygiene. Any MCP client (Alexa+ included) may pass a whole phrase; the sources need the item only.

/** Words that describe the worry, not the item: "is zyrtec safe to take", "listeria outbreak cantaloupes". */
const WORRY = new Set(["safe", "safety", "unsafe", "dangerous", "ok", "okay", "fine", "good", "bad", "still", "anymore", "now", "today",
  "take", "use", "eat", "drink", "to", "outbreak", "outbreaks", "listeria", "salmonella", "coli", "e", "contaminated", "contamination",
  "recall", "recalls", "recalled", "warning", "warnings", "alert", "alerts", "news", "lately", "recently", "please", "my", "the", "a", "an",
  "is", "it", "are", "was", "were", "there", "any", "does", "do", "should", "i", "we", "our", "of", "can", "has", "have", "for", "me"]);

/** "jalapeño" -> "jalapeno": the same NFD and combining-mark strip everywhere an item is read. */
export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Spoken phrases the sources spell differently. The server applies these itself, not only the router,
 * so a client that sends "baby formula" straight to a search tool still searches "infant formula".
 * A single word synonym is never applied here: "byheart formula" must keep the brand.
 */
const PHRASE_SYNONYMS: Array<[string, string]> = [["baby formula", "infant formula"]];

export const REFUSAL = "I need an item in English letters, for example ibuprofen.";

export function cleanItem(query: string): string {
  const plain = stripAccents(query).toLowerCase();
  // A query with no letters, only non-Latin letters, or a mix of Latin and another script is refused
  // before any source is called, so it never reaches a database and never becomes a no-recalls answer.
  const letters = plain.match(/\p{L}/gu) ?? [];
  const isLatin = (letter: string) => /\p{Script=Latin}/u.test(letter);
  const hasLatin = letters.some(isLatin);
  const hasOther = letters.some((letter) => !isLatin(letter));
  // One letter is not a word: a stray letter in "-- --x" must never search the whole database.
  if (!hasLatin || hasOther || letters.length < 2) throw new RangeError(REFUSAL);
  const words = plain.replace(/[^a-z0-9'&\- ]+/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !WORRY.has(w));
  let cleaned = (kept.length ? kept : words).join(" ").slice(0, 60);
  for (const [phrase, target] of PHRASE_SYNONYMS) {
    cleaned = cleaned.replace(new RegExp(`\\b${phrase}\\b`, "g"), target);
  }
  // Nothing readable is left (for example a query in a non-Latin script). Never search the whole database.
  if (!cleaned) throw new RangeError(REFUSAL);
  return cleaned;
}

// FDA product descriptions spell the dosage form out, so the spoken shorthand "metformin er" must search "metformin extended release".
const DRUG_FORMS: Record<string, string> = { er: "extended release", xr: "extended release" };

/** "metformin er" -> "metformin extended release"; a shorthand after a drug name only, so a lone "er" is left alone. */
export function expandDrugForm(query: string): string {
  const words = query.split(" ").filter(Boolean);
  const form = DRUG_FORMS[(words[words.length - 1] ?? "").toLowerCase()];
  return form && words.length > 1 ? [...words.slice(0, -1), form].join(" ") : query;
}

/** The item for the FDA drug search: the cleaned item with a trailing ER or XR read as extended release. */
export function cleanDrugItem(query: string): string {
  return expandDrugForm(cleanItem(query));
}

/** "cantaloupes" -> "cantaloupe", "berries" -> "berry"; used only as a second try after zero results. */
export function singularPhrase(query: string): string | null {
  const words = query.split(" ");
  const last = words[words.length - 1] ?? "";
  const single = last.length > 4 && last.endsWith("ies") ? `${last.slice(0, -3)}y` : last.length > 3 && last.endsWith("es") && /(ch|sh|x|ss|o)es$/.test(last) ? last.slice(0, -2) : last.length > 3 && last.endsWith("s") && !last.endsWith("ss") ? last.slice(0, -1) : null;
  return single ? [...words.slice(0, -1), single].join(" ") : null;
}
