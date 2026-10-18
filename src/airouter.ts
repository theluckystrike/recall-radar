import { route, type RouteResult } from "./router.js";

// The simulator's stand-in for the Alexa+ language model: a real model chooses the MCP tool from the tool descriptions.
// Its output is validated strictly; anything invalid falls back to the rule router. A daily cap keeps the demo at 0 USD.

export interface AiEnv {
  AI?: { run: (model: string, input: unknown) => Promise<{ response?: unknown }> };
  LIMITS?: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> };
}
export interface Pending { make: string; model: string }

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const DAILY_CAP = 200;

const SYSTEM = `You route one spoken question about recalls to ONE tool of the Recall Radar MCP server. Reply with JSON only.
Tools:
- check_vehicle_recalls {"year": number, "make": string, "model": string}: cars, trucks, motorcycles. Use NHTSA spelling: "ford","f-150"; "chevrolet","silverado 1500"; "mercedes-benz"; "volkswagen"; "cr-v"; "rav4"; "model 3". Model = the model only, no trim words like "sport" or "ex".
- search_food_recalls {"query": string}: food, drinks, infant formula, pet food.
- search_drug_recalls {"query": string}: medicines, eye drops, sanitizer, sunscreen, supplements.
- check_all_recalls {"query": string}: household products (cribs, toys, appliances, furniture, electronics) and anything unclear. Keep brand and product words, for example "uppababy high chair".
- add_to_watch_list {"year": number, "make": string, "model": string} or {"item": string}: save a vehicle, product, food or medicine for later checks. Use the vehicle shape only when the year, make and model are all present.
- remove_from_watch_list {"item": string}: remove one saved item from the watch list.
- check_my_watch_list {}: check every saved item for new recalls.
Special replies:
- {"tool":"ask_vehicle","args":{"make":..., "model":..., "missing":"year"|"model"}} when a vehicle question lacks the year or the model.
- {"tool":"more","args":{}} when the person wants to hear more of the previous answer ("more", "yes", "go on", "the others").
- {"tool":"none","args":{}} when it is not a recall question.
The query is the item only: drop words about the worry ("safe", "outbreak", "listeria", "still okay", "to take").
Watch list phrases such as "add my 2018 Honda Accord to my watch list", "watch the IKEA MALM dresser", "check my watch list", "anything new on my list" and "remove the crib from my list" use the watch list tools.
"Mini", "Fire", "Ring" and other brand words are products unless a model year and a car model follow.`;

const today = () => new Date().toISOString().slice(0, 10);

async function takeCall(env: AiEnv): Promise<boolean> {
  if (!env.LIMITS) return true;
  const key = `route:${today()}`;
  const used = Number((await env.LIMITS.get(key)) ?? "0");
  if (!Number.isFinite(used) || used >= DAILY_CAP) return false;
  await env.LIMITS.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
  return true;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim().toLowerCase() : null);

function validateVehicle(a: Record<string, unknown>, maxYear: number): RouteResult | null {
  const year = Number(a.year); const make = str(a.make, 30); const model = str(a.model, 40);
  const ok = Number.isInteger(year) && year >= 1950 && year <= maxYear && make !== null && model !== null;
  return ok ? { tool: "check_vehicle_recalls", args: { year, make: make!, model: model! } } : null;
}

/** Accept only the exact shapes the simulator can execute. */
export function validate(raw: unknown): RouteResult | null {
  if (!raw || typeof raw !== "object") return null;
  const { tool, args } = raw as { tool?: unknown; args?: Record<string, unknown> };
  const a = args ?? {};
  const maxYear = new Date().getUTCFullYear() + 1;
  if (tool === "more") return { tool: "more", args: {} };
  if (tool === "check_vehicle_recalls") return validateVehicle(a, maxYear);
  if (tool === "ask_vehicle") {
    const make = str(a.make, 30); const missing = a.missing === "model" ? "model" : "year";
    return make ? { tool, args: { make, model: str(a.model, 40) ?? "", missing } } : null;
  }
  if (tool === "search_food_recalls" || tool === "search_drug_recalls" || tool === "check_all_recalls" || tool === "search_product_recalls") {
    const query = str(a.query, 60);
    return query ? { tool, args: { query } } : null;
  }
  if (tool === "check_my_watch_list") return { tool, args: {} };
  if (tool === "remove_from_watch_list") {
    const item = str(a.item, 80) ?? str(a.query, 80);
    return item ? { tool, args: { item } } : null;
  }
  if (tool === "add_to_watch_list") {
    if (a.year !== undefined || a.make !== undefined || a.model !== undefined) {
      const vehicle = validateVehicle(a, maxYear);
      return vehicle?.tool === "check_vehicle_recalls" ? { tool, args: vehicle.args } : null;
    }
    const item = str(a.item, 80) ?? str(a.query, 80);
    return item ? { tool, args: { item } } : null;
  }
  return null;
}

function parseJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

export async function aiRoute(env: AiEnv, utterance: string, pending: Pending | null): Promise<{ route: RouteResult | null; by: "model" | "rules" }> {
  // Rules fallback: only a bare answer to the pending question ("2018", "the 2018 one", "accord") completes it.
  const fallback = () => {
    if (/^\s*(never ?mind|cancel|stop|forget it|no thanks|nothing)\W*$/i.test(utterance)) return { route: null, by: "rules" as const };
    const bare = pending && utterance.trim().split(/\s+/).length <= 3 && !/recall/i.test(utterance);
    const year = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(utterance)?.[1];
    const text = bare && pending ? (pending.model ? (year ? `${year} ${pending.make} ${pending.model}` : utterance) : `${year ?? ""} ${pending.make} ${utterance}`.trim()) : utterance;
    return { route: route(text), by: "rules" as const };
  };
  if (!env.AI || !(await takeCall(env))) return fallback();
  const context = pending ? `The assistant just asked for the ${pending.model ? "model year" : "model"} of the person's ${pending.make} ${pending.model}. If the reply gives it, call check_vehicle_recalls.` : "No open question.";
  try {
    const out = await env.AI.run(MODEL, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `${context}\nQuestion: ${utterance.slice(0, 200)}` }], max_tokens: 120, temperature: 0 });
    const raw = typeof out.response === "string" ? parseJson(out.response) : out.response;
    if (raw && typeof raw === "object" && (raw as { tool?: unknown }).tool === "none") return { route: null, by: "model" };
    const valid = validate(raw);
    return valid ? { route: valid, by: "model" } : fallback();
  } catch {
    return fallback();
  }
}
