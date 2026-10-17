// Shared contract for Recall Radar. Owned by the orchestrator; workers import, never edit.
export type Source = "nhtsa" | "cpsc" | "fda-food" | "fda-drug";

export interface Recall {
  source: Source;
  id: string;
  date: string;
  title: string;
  hazard: string;
  remedy: string;
  url: string;
  severity?: "high" | "medium" | "low";
}

export interface SearchResult {
  query: string;
  source: Source;
  total: number;
  recalls: Recall[];
}

export class SourceError extends Error {
  constructor(message: string) { super(message); this.name = "SourceError"; }
}

export const FETCH_TIMEOUT_MS = 4000;
