// Server-side query hygiene. Any MCP client (Alexa+ included) may pass a whole phrase; the sources need the item only.

/** Words that describe the worry, not the item: "is zyrtec safe to take", "listeria outbreak cantaloupes". */
const WORRY = new Set(["safe", "safety", "unsafe", "dangerous", "ok", "okay", "fine", "good", "bad", "still", "anymore", "now", "today",
  "take", "use", "eat", "drink", "to", "outbreak", "outbreaks", "listeria", "salmonella", "coli", "e", "contaminated", "contamination",
  "recall", "recalls", "recalled", "warning", "warnings", "alert", "alerts", "news", "lately", "recently", "please", "my", "the", "a", "an",
  "is", "it", "are", "was", "were", "there", "any", "does", "do", "should", "i", "we", "our", "of", "can", "has", "have", "for", "me"]);

export function cleanItem(query: string): string {
  const words = query.toLowerCase().replace(/[^a-z0-9'&\- ]+/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !WORRY.has(w));
  return (kept.length ? kept : words).join(" ").slice(0, 60);
}

/** "cantaloupes" -> "cantaloupe", "berries" -> "berry"; used only as a second try after zero results. */
export function singularPhrase(query: string): string | null {
  const words = query.split(" ");
  const last = words[words.length - 1] ?? "";
  const single = last.length > 4 && last.endsWith("ies") ? `${last.slice(0, -3)}y` : last.length > 3 && last.endsWith("es") && /(ch|sh|x|ss|o)es$/.test(last) ? last.slice(0, -2) : last.length > 3 && last.endsWith("s") && !last.endsWith("ss") ? last.slice(0, -1) : null;
  return single ? [...words.slice(0, -1), single].join(" ") : null;
}
