// Small text helpers shared by the government source normalisers, the visual card and the voice layer.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// A leading list number ("1. ") is screen furniture, not part of a title.
const LIST_NUMBER = /^\s*\d+\.\s+/;

/** "1. ByHeart Whole Nutrition" -> "ByHeart Whole Nutrition". A title with no list number is returned unchanged. */
export function stripListNumber(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LIST_NUMBER, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** "2025-12-17" -> "17 December 2025". A date that is not an ISO day is returned unchanged. */
export function spokenDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!match) return date;
  const [, year = "", month = "", day = ""] = match;
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : date;
}
