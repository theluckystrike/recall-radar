import type { Recall } from "./types.js";

// Ranking shared by the sources, the watch list lead and the merged search results.
// A hazard that mentions death or a fatal outcome outranks an ordinary high severity recall.

/** death, deaths, died, fatal, fatality or fatalities as whole words, case-insensitive. */
export const DEATH_MENTION = /\b(?:deaths?|died|fatal|fatality|fatalities)\b/i;

export function mentionsDeath(recall: Pick<Recall, "title" | "hazard">): boolean {
  return DEATH_MENTION.test(recall.hazard) || DEATH_MENTION.test(recall.title);
}

/** 3 for a death mention, 2 high, 1 medium, 0 for anything else. */
export function recallRank(recall: Recall): number {
  if (mentionsDeath(recall)) return 3;
  if (recall.severity === "high") return 2;
  if (recall.severity === "medium") return 1;
  return 0;
}

/** The watch list lead order: the most serious class first, then the newest. Death mentions outrank other high recalls. */
export function byImportance(a: Recall, b: Recall): number {
  return recallRank(b) - recallRank(a) || b.date.localeCompare(a.date);
}

/** Search order: newest first, and on the same date the more serious recall first. */
export function byRecency(a: Recall, b: Recall): number {
  return b.date.localeCompare(a.date) || recallRank(b) - recallRank(a);
}
