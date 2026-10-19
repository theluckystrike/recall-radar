import test from "node:test";
import assert from "node:assert/strict";

import { SourceError, type Recall, type SearchResult } from "../src/types.js";
import {
  addWatchItem,
  checkWatchList,
  classifyWatchItem,
  createServer,
  itemSearch,
  NEED_USER_ID,
  readWatchList,
  removeWatchItem,
  searchWatchItem,
  SEARCH_SOURCES,
  verifyWatchVehicle,
  watchUserId,
  type RecallSources,
  type WatchEnv,
  type WatchItem,
} from "../src/server.js";
import { WatchStore } from "../src/watchstore.js";
import { searchFood } from "../src/sources/fda.js";

type FetchFn = typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function fdaRecord(overrides: Record<string, unknown>): unknown {
  return {
    recall_number: "H-0249-2026",
    product_description: "a.) ByHeart Whole Nutrition Infant Formula",
    reason_for_recall: "The product may contain botulism.",
    classification: "Class I",
    report_date: "20260105",
    status: "Ongoing",
    recalling_firm: "ByHeart",
    ...overrides,
  };
}

class FakeKV {
  readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

function watchEnv(): WatchEnv {
  return { LIMITS: new FakeKV() };
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

function toolHandler(server: ReturnType<typeof createServer>, name: string): ToolHandler {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler;
}

function makeRecall(overrides: Partial<Recall>): Recall {
  return {
    source: "cpsc",
    id: "R-1",
    date: "2024-01-15",
    title: "Widget",
    hazard: "May cause injury.",
    remedy: "Contact the manufacturer.",
    url: "https://example.com",
    ...overrides,
  };
}

function hit(query: string, source: SearchResult["source"], recalls: Recall[]): SearchResult {
  return { query, source, total: recalls.length, recalls };
}

test("itemSearch: one failed form and zero from the other is not a no-recalls answer", async () => {
  const search = async (q: string): Promise<SearchResult> => {
    if (q === "cantaloupe") throw new SourceError("fda-food: HTTP 500");
    return { query: q, source: "fda-food", total: 0, recalls: [] };
  };
  await assert.rejects(itemSearch(search, "cantaloupes"), /could not be fully checked/);
});

test("itemSearch: a successful form still answers when the other form fails", async () => {
  const recall = makeRecall({ id: "FDA-1", source: "fda-food", title: "Cantaloupe" });
  const search = async (q: string): Promise<SearchResult> => {
    if (q === "cantaloupe") throw new SourceError("fda-food: HTTP 500");
    return hit(q, "fda-food", [recall]);
  };
  const result = await itemSearch(search, "cantaloupes");
  assert.equal(result.total, 1);
  assert.equal(result.recalls[0]?.id, "FDA-1");
});

test("watch list validates and classifies vehicles, products and foods", () => {
  assert.deepEqual(classifyWatchItem({ year: 2018, make: "honda", model: "accord" }), {
    kind: "vehicle",
    label: "2018 Honda Accord",
    query: "2018 Honda Accord",
    year: 2018,
    make: "honda",
    model: "accord",
  });
  assert.equal(classifyWatchItem({ item: "IKEA MALM dresser" }).kind, "all");
  assert.equal(classifyWatchItem({ item: "peanut butter" }).kind, "food");
  assert.throws(() => classifyWatchItem({ item: "a" }), /between 2 and 80/);
  assert.throws(() => classifyWatchItem({ year: 1800, make: "ford", model: "t" }), /model year/);
  assert.throws(() => classifyWatchItem({ item: "honda accord" }), /year, make and model/);
});

test("a watch item keeps every word the person gave, including the brand", () => {
  assert.deepEqual(classifyWatchItem({ item: "ByHeart formula" }), { kind: "food", label: "ByHeart formula", query: "byheart formula" });
  assert.deepEqual(classifyWatchItem({ item: "Similac baby formula" }), { kind: "food", label: "Similac baby formula", query: "similac infant formula" });
  assert.deepEqual(classifyWatchItem({ item: "baby formula" }), { kind: "food", label: "baby formula", query: "infant formula" });
});

test("a watch item drops a leading my from its label but keeps the search words", () => {
  assert.equal(classifyWatchItem({ item: "my wagon" }).label, "wagon");
  assert.equal(classifyWatchItem({ item: "my wagon" }).query, "wagon");
  assert.equal(classifyWatchItem({ item: "my peanut butter" }).label, "peanut butter");
  // A word that merely starts with "my" keeps its letters.
  assert.equal(classifyWatchItem({ item: "mystery box" }).label, "mystery box");
});

test("a watch item with accents searches the unaccented words", async () => {
  const env = watchEnv();
  const added = await addWatchItem(env, "user", { item: "jalapeño peppers" });
  assert.ok(added.ok);
  assert.equal(added.item.label, "jalapeno peppers");
  assert.equal(added.item.query, "jalapeno peppers");
  const removed = await removeWatchItem(env, "user", "jalapeño peppers");
  assert.equal(removed.removed, true);
});

test("text with no letters, no Latin letters or Latin mixed with another script is refused, never as an unreachable source", async () => {
  const env = watchEnv();
  for (const item of ["日本", "ибупрофен", "12345", "@#%", "ibuprofen 日本", "Ибупрофен ibuprofen"]) {
    const added = await addWatchItem(env, "user", { item });
    assert.equal(added.ok, false, item);
    if (!added.ok) {
      assert.match(added.message, /English letters/, item);
      assert.ok(!/could not be reached|unavailable/.test(added.message), item);
    }
    const server = createServer({ env, userId: "user" });
    for (const name of ["check_all_recalls", "search_food_recalls", "search_drug_recalls", "search_product_recalls"]) {
      const result = await toolHandler(server, name)({ query: item }, {});
      const text = result.content?.[0]?.text ?? "";
      assert.equal(result.isError, true, `${name} ${item}`);
      assert.match(text, /English letters/, `${name} ${item}`);
      assert.ok(!/could not be reached|did not answer in time/.test(text), `${name} ${item}`);
    }
  }
  assert.equal((await readWatchList(env, "user")).length, 0);
});

test("an unknown vehicle is refused at add time and never saved", async () => {
  const env = watchEnv();
  const added = await addWatchItem(env, "user", { year: 2019, make: "honda", model: "accord" }, async () => "unknown");
  assert.equal(added.ok, false);
  if (!added.ok) {
    assert.match(added.message, /does not list that make and model/);
    assert.ok(added.message.length <= 120, added.message);
  }
  assert.equal((await readWatchList(env, "user")).length, 0);
});

test("a vehicle that could not be verified is saved with a note", async () => {
  const env = watchEnv();
  const added = await addWatchItem(env, "user", { year: 2019, make: "honda", model: "accord" }, async () => "unverified");
  assert.ok(added.ok);
  assert.match(added.note ?? "", /could not verify it with NHTSA yet/);
  assert.equal((await readWatchList(env, "user")).length, 1);
});

test("a known vehicle is saved without a note and checked once", async () => {
  const env = watchEnv();
  let calls = 0;
  const added = await addWatchItem(env, "user", { year: 2019, make: "honda", model: "accord" }, async () => {
    calls++;
    return "known";
  });
  assert.ok(added.ok);
  assert.equal(added.note, undefined);
  assert.equal(calls, 1);
});

test("the add check maps an unlisted model to unknown, a listed no-recalls model to known and a vPIC failure to unverified", async () => {
  const vpicThen = (body: unknown, status = 200) => (async (input: string | URL | Request) => {
    if (String(input).includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify(body), { status });
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  assert.equal(await verifyWatchVehicle("honda", "nope", 2019, vpicThen({ Results: [{ Model_Name: "Accord" }] })), "unknown");
  assert.equal(await verifyWatchVehicle("honda", "accord", 2019, vpicThen({ Results: [{ Model_Name: "Accord" }] })), "known");
  assert.equal(await verifyWatchVehicle("honda", "accord", 2019, vpicThen({}, 500)), "unverified");
  const down = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  assert.equal(await verifyWatchVehicle("honda", "accord", 2019, down), "unverified");
});

test("verifyWatchVehicle retries with the model name the way the check tool does", async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Civic Hybrid" }] }), { status: 200 });
    }
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  assert.equal(await verifyWatchVehicle("honda", "civic ex", 2019, fetchFn), "known");
});

test("the add tool refuses an unknown vehicle and saves nothing", async () => {
  const env = watchEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify({ Results: [{ Model_Name: "Accord" }] }), { status: 200 });
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  try {
    const result = await toolHandler(createServer({ env, userId: "user" }), "add_to_watch_list")({ year: 2019, make: "honda", model: "nope" }, {});
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /does not list that make and model/);
    assert.equal((await readWatchList(env, "user")).length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a real car with no recalls is accepted on the watch list", async () => {
  const env = watchEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify({ Results: [{ Model_Name: "Camry" }] }), { status: 200 });
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  try {
    const added = await addWatchItem(env, "user", { year: 2026, make: "toyota", model: "camry" });
    assert.ok(added.ok);
    assert.equal(added.note, undefined);
    assert.equal((await readWatchList(env, "user")).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a known model with no recalls answers no recalls, and a vPIC failure says the vehicle service is unavailable", async () => {
  const original = globalThis.fetch;
  const vpicThen = (body: unknown, status = 200) => (async (input: string | URL | Request) => {
    if (String(input).includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify(body), { status });
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  try {
    globalThis.fetch = vpicThen({ Results: [{ Model_Name: "Camry" }] });
    const found = await toolHandler(createServer({}), "check_vehicle_recalls")({ year: 2026, make: "toyota", model: "camry" }, {});
    assert.equal(found.isError, undefined);
    assert.match(found.content?.[0]?.text ?? "", /no recalls/);

    globalThis.fetch = vpicThen({}, 500);
    const down = await toolHandler(createServer({}), "check_vehicle_recalls")({ year: 2026, make: "toyota", model: "camry" }, {});
    assert.equal(down.isError, true);
    const text = down.content?.[0]?.text ?? "";
    assert.match(text, /vehicle service is unavailable/);
    assert.ok(!/no recalls/i.test(text), text);
    assert.ok(!/not find that make/i.test(text), text);
  } finally {
    globalThis.fetch = original;
  }
});

test("the add tool saves a vehicle it could not verify and says so", async () => {
  const env = watchEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  try {
    const result = await toolHandler(createServer({ env, userId: "user" }), "add_to_watch_list")({ year: 2019, make: "honda", model: "accord" }, {});
    assert.equal(result.isError, undefined);
    assert.match(result.content?.[0]?.text ?? "", /could not verify it with NHTSA yet/);
    assert.equal((await readWatchList(env, "user")).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("watch list persists across sessions under a per-user key", async () => {
  const env = watchEnv();
  const added = await addWatchItem(env, "user-a", { item: "crib" });
  assert.equal(added.ok, true);
  const again = await readWatchList(env, "user-a");
  assert.equal(again.length, 1);
  assert.equal(again[0]?.label, "crib");
  assert.equal((await readWatchList(env, "user-b")).length, 0);
});

test("watch list caps at 10 items and rejects duplicates", async () => {
  const env = watchEnv();
  const items = ["crib", "stroller", "toy", "heater", "blender", "kettle", "chair", "mattress", "lamp", "fan"];
  for (const item of items) {
    const result = await addWatchItem(env, "user", { item });
    assert.equal(result.ok, true, item);
  }
  const extra = await addWatchItem(env, "user", { item: "toaster" });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.match(extra.message, /full/);
  const duplicate = await addWatchItem(env, "user", { item: "crib" });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.message, /already/);
});

test("remove takes one saved item off the list", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "peanut butter" });
  const removed = await removeWatchItem(env, "user", "crib");
  assert.equal(removed.removed, true);
  assert.equal(removed.item?.label, "crib");
  assert.equal((await readWatchList(env, "user")).length, 1);
  const again = await removeWatchItem(env, "user", "crib");
  assert.equal(again.removed, false);
});

test("remove matches whole words and never a substring inside a word", async () => {
  const object = new WatchStore({ storage: new FakeStorage() });
  await object.add({ item: "Fisher-Price Rock n Play sleeper" });
  const miss = await object.remove("ice");
  assert.equal(miss.removed, false);
  assert.equal((await object.list()).length, 1);
});

test("remove drops the words around the item and asks when several items match", async () => {
  const object = new WatchStore({ storage: new FakeStorage() });
  await object.add({ item: "crib" });
  const removed = await object.remove("Remove the crib from my list");
  assert.equal(removed.removed, true);
  assert.equal(removed.item?.label, "crib");

  await object.add({ item: "white crib" });
  await object.add({ item: "crib mattress" });
  const question = await object.remove("remove the crib from my list");
  assert.equal(question.removed, false);
  assert.match(question.message, /white crib/);
  assert.match(question.message, /crib mattress/);
  assert.match(question.message, /\?$/);
  assert.equal((await object.list()).length, 2);
});

test("check runs every saved item in parallel", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "stroller" });
  let active = 0;
  let maxActive = 0;
  const lookup = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    return { recalls: [], failed: false };
  };
  const result = await checkWatchList(env, "user", lookup);
  assert.equal(result.totalItems, 2);
  assert.ok(maxActive >= 2, `only ${maxActive} item was checked at once`);
});

test("check reports only new recall ids and remembers them per item", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "stroller" });
  const crib = makeRecall({ id: "CRIB-1", title: "Crib", date: "2023-01-01", severity: "high" });
  const stroller = makeRecall({ id: "STROLLER-1", title: "Stroller", date: "2024-02-01" });
  const lookup = async (item: WatchItem) => ({
    recalls: item.query === "crib" ? [crib] : [stroller],
    failed: false,
  });

  const first = await checkWatchList(env, "user", lookup);
  assert.equal(first.newItems, 2);
  assert.equal(first.recalls[0]?.id, "CRIB-1");
  assert.match(first.text, /2 of your 2 items have a new recall/);

  const second = await checkWatchList(env, "user", lookup);
  assert.equal(second.newItems, 0);
  assert.match(second.text, /None of your items has a new recall/);

  const newer = makeRecall({ id: "CRIB-2", title: "Crib", date: "2024-03-01", severity: "high" });
  const third = await checkWatchList(env, "user", async (item) => ({
    recalls: item.query === "crib" ? [newer, crib] : [stroller],
    failed: false,
  }));
  assert.equal(third.newItems, 1);
  assert.deepEqual(third.recalls.map((recall) => recall.id), ["CRIB-2"]);
  assert.match(third.text, /1 of your 2 items has a new recall/);
});

test("check says an unavailable source is never reported as no recalls", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  const failed = await checkWatchList(env, "user", async () => ({ recalls: [], failed: true }));
  assert.match(failed.text, /could not check your watch list/);
  assert.ok(!failed.text.toLowerCase().includes("no recalls"));

  await addWatchItem(env, "user", { item: "stroller" });
  const partial = await checkWatchList(env, "user", async (item) => ({ recalls: [], failed: item.query === "crib" }));
  assert.match(partial.text, /could not fully check 1 of your 2 items/);
  assert.ok(!partial.text.toLowerCase().includes("no recalls"));
});

test("the watch answer lead counts only the items the check reached", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "stroller" });
  await addWatchItem(env, "user", { item: "kettle" });
  const crib = makeRecall({ id: "CRIB-1", title: "Crib", date: "2024-02-01", severity: "high" });
  const lookup = async (item: WatchItem) => {
    if (item.query === "kettle") return { recalls: [], failed: true };
    return { recalls: item.query === "crib" ? [crib] : [], failed: false };
  };
  const check = await checkWatchList(env, "user", lookup);
  assert.match(check.text, /1 of your 2 items has a new recall/);
  // The lead counts the two items the check reached. The three item total appears only in the unavailable sentence.
  const lead = check.text.slice(0, check.text.indexOf("I could not"));
  assert.ok(!lead.includes("1 of your 3 items"), check.text);
  assert.match(check.text, /could not fully check 1 of your 3 items/);
});

test("a partial failure that still found a recall counts as checked, so the lead stays plural", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "stroller" });
  const crib = makeRecall({ id: "CRIB-1", title: "Crib", date: "2024-02-01" });
  const stroller = makeRecall({ id: "STROLLER-1", title: "Stroller", date: "2024-02-01" });
  const lookup = async (item: WatchItem) => item.query === "crib"
    ? { recalls: [crib], failed: true }
    : { recalls: [stroller], failed: false };
  const check = await checkWatchList(env, "user", lookup);
  assert.equal(check.newItems, 2);
  assert.match(check.text, /2 of your 2 items have a new recall/);
  assert.ok(!/Your item has a new recall/.test(check.text), check.text);
});

// ---- WatchStore: the plain class the Durable Object and the in-memory fallback both delegate to ----

class FakeStorage {
  readonly data = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

test("watch store: three adds in a row report 1, 2 and 3 items", async () => {
  const object = new WatchStore({ storage: new FakeStorage() });
  const first = await object.add({ item: "crib" });
  assert.ok(first.ok);
  assert.equal(first.list.length, 1);
  const second = await object.add({ item: "stroller" });
  assert.ok(second.ok);
  assert.equal(second.list.length, 2);
  const third = await object.add({ item: "kettle" });
  assert.ok(third.ok);
  assert.equal(third.list.length, 3);
  assert.equal((await object.list()).length, 3);
});

test("watch store: a remove finds an item that was just added", async () => {
  const object = new WatchStore({ storage: new FakeStorage() });
  await object.add({ item: "crib" });
  await object.add({ item: "peanut butter" });
  const removed = await object.remove("peanut butter");
  assert.equal(removed.removed, true);
  assert.equal(removed.item?.label, "peanut butter");
  assert.equal((await object.list()).length, 1);
  const again = await object.remove("peanut butter");
  assert.equal(again.removed, false);
});

test("watch store: duplicates and the 10 item cap are enforced", async () => {
  const object = new WatchStore({ storage: new FakeStorage() });
  const items = ["crib", "stroller", "toy", "heater", "blender", "kettle", "chair", "mattress", "lamp", "fan"];
  for (const item of items) assert.ok((await object.add({ item })).ok, item);
  const extra = await object.add({ item: "toaster" });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.match(extra.message, /full/);
  const duplicate = await object.add({ item: "crib" });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.message, /already/);
});

test("watch store: a repeat check reports no new recalls", async () => {
  const recall = makeRecall({ id: "CRIB-1", title: "Crib" });
  const lookup = async () => ({ recalls: [recall], failed: false });
  const object = new WatchStore({ storage: new FakeStorage() }, lookup);
  await object.add({ item: "crib" });
  await object.add({ item: "stroller" });
  await object.add({ item: "kettle" });

  const first = await object.check();
  assert.equal(first.totalItems, 3);
  assert.equal(first.newItems, 3);
  assert.equal(first.recalls.length, 3);

  const second = await object.check();
  assert.equal(second.totalItems, 3);
  assert.equal(second.newItems, 0);
  assert.equal(second.recalls.length, 0);
  assert.match(second.text, /None of your items has a new recall since you last asked/);
});

test("watch list: three adds in a row give 1, 2, 3 and a repeat check finds nothing new", async () => {
  const env = watchEnv();
  const sizes: number[] = [];
  for (const item of ["crib", "stroller", "kettle"]) {
    const added = await addWatchItem(env, "user", { item });
    assert.ok(added.ok);
    sizes.push(added.list.length);
  }
  assert.deepEqual(sizes, [1, 2, 3]);

  const recall = makeRecall({ id: "CRIB-1", title: "Crib" });
  const lookup = async () => ({ recalls: [recall], failed: false });
  const first = await checkWatchList(env, "user", lookup);
  assert.equal(first.totalItems, 3);
  assert.equal(first.newItems, 3);
  const second = await checkWatchList(env, "user", lookup);
  assert.equal(second.newItems, 0);
  assert.match(second.text, /None of your items has a new recall since you last asked/);
});

test("watch list sends every operation to one Durable Object per sanitised user id", async () => {
  const objects = new Map<string, WatchStore>();
  const names: string[] = [];
  const env: WatchEnv = {
    WATCH: {
      idFromName(name: string) { names.push(name); return name; },
      get(id: unknown) {
        const key = String(id);
        let object = objects.get(key);
        if (!object) {
          object = new WatchStore({ storage: new FakeStorage() });
          objects.set(key, object);
        }
        return object;
      },
    },
  };
  const added = await addWatchItem(env, "User A", { item: "crib" });
  assert.ok(added.ok);
  assert.equal((await readWatchList(env, "User A")).length, 1);
  assert.equal((await readWatchList(env, "another user")).length, 0);
  assert.deepEqual(names, ["UserA", "UserA", "anotheruser"]);
  assert.equal(objects.size, 2);
});

test("the watch check searches the saved item exactly as search_food_recalls does", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "ByHeart formula" });
  const stored = (await readWatchList(env, "user"))[0]!;
  assert.equal(stored.query, "byheart formula");

  const nara = fdaRecord({ recall_number: "N-1", product_description: "a.) Nara Organics Infant Formula", recalling_firm: "Nara Organics" });
  const byheart = fdaRecord({});
  const fetchFn = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes('product_description:"byheart%20formula"')) return jsonResponse(200, { meta: { results: { total: 1 } }, results: [byheart] });
    if (target.includes('product_description:"infant%20formula"')) return jsonResponse(200, { meta: { results: { total: 1 } }, results: [nara] });
    return jsonResponse(404, { error: { code: "NOT_FOUND" } });
  }) as unknown as FetchFn;

  const sources: RecallSources = { ...SEARCH_SOURCES, food: (q: string) => itemSearch((qq) => searchFood(qq, fetchFn), q) };
  const check = await checkWatchList(env, "user", (item) => searchWatchItem(item, sources));
  assert.equal(check.recalls.length, 1);
  assert.equal(check.recalls[0]?.id, "H-0249-2026");
  assert.match(check.text, /For your ByHeart formula/);
  assert.ok(!check.text.includes("Nara"), check.text);
  assert.ok(check.text.includes("It is ByHeart Whole Nutrition Infant Formula."), check.text);
  assert.ok(!check.text.includes("a.)"), check.text);
});

test("the watch check keeps the tool's all-words retry", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "ByHeart formula" });
  let sawLoose = false;
  const fetchFn = (async (url: string | URL | Request) => {
    if (String(url).includes("product_description:byheart+AND+product_description:formula")) {
      sawLoose = true;
      return jsonResponse(200, { meta: { results: { total: 1 } }, results: [fdaRecord({ recall_number: "H-7" })] });
    }
    return jsonResponse(404, { error: { code: "NOT_FOUND" } });
  }) as unknown as FetchFn;

  const sources: RecallSources = { ...SEARCH_SOURCES, food: (q: string) => itemSearch((qq) => searchFood(qq, fetchFn), q) };
  const check = await checkWatchList(env, "user", (item) => searchWatchItem(item, sources));
  assert.ok(sawLoose, "the all-words retry ran");
  assert.equal(check.recalls[0]?.id, "H-7");
});

test("the watch answer counts the items with new recalls and names the most important one", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "ByHeart formula" });
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "stroller" });
  const formula = makeRecall({ id: "B-1", source: "fda-food", title: "ByHeart Formula", severity: "high", date: "2026-01-05" });
  const crib = makeRecall({ id: "C-1", title: "Crib", date: "2026-02-01" });
  const lookup = async (item: WatchItem) => ({
    recalls: item.label === "ByHeart formula" ? [formula] : item.label === "crib" ? [crib] : [],
    failed: false,
  });
  const check = await checkWatchList(env, "user", lookup);
  assert.match(check.text, /2 of your 3 items have a new recall/);
  assert.match(check.text, /For your ByHeart formula/);
});

test("watch store keeps an add made while a slow check is running", async () => {
  const object = new WatchStore({ storage: new FakeStorage() });
  await object.add({ item: "crib" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const checking = object.check(async () => {
    started();
    await gate;
    return { recalls: [], failed: false };
  });
  await began;
  const added = await object.add({ item: "stroller" });
  assert.ok(added.ok);
  release();
  const result = await checking;
  const list = await object.list();
  assert.deepEqual(list.map((item) => item.label).sort(), ["crib", "stroller"]);
  assert.equal(result.totalItems, 2);
});

test("watch tools refuse to run without a user id and never use a shared list", async () => {
  const env = watchEnv();
  const server = createServer({ env });
  const calls: Array<[string, Record<string, unknown>]> = [
    ["add_to_watch_list", { item: "crib" }],
    ["remove_from_watch_list", { item: "crib" }],
    ["check_my_watch_list", {}],
  ];
  for (const [name, args] of calls) {
    const result = await toolHandler(server, name)(args, {});
    assert.equal(result.isError, true, name);
    assert.equal(result.content?.[0]?.text, NEED_USER_ID, name);
  }
  assert.equal(watchUserId(undefined), "");
  assert.equal((await readWatchList(env, undefined)).length, 0);
  assert.equal((await readWatchList(env, "user-a")).length, 0);
});

test("vehicle aliases work in watch classification and over the MCP vehicle tool", async () => {
  const chevy = classifyWatchItem({ year: 2019, make: "Chevy", model: "Silverado" });
  assert.equal(chevy.label, "2019 Chevrolet Silverado 1500");
  assert.equal(chevy.make, "chevrolet");
  assert.equal(chevy.model, "silverado 1500");
  const ford = classifyWatchItem({ year: 2021, make: "Ford", model: "f150" });
  assert.equal(ford.label, "2021 Ford F-150");
  assert.equal(ford.model, "f-150");
  assert.equal(classifyWatchItem({ item: "2019 Chevy Silverado" }).model, "silverado 1500");

  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).includes("vpic.nhtsa.dot.gov")) return jsonResponse(200, { Results: [{ Model_Name: "Silverado 1500" }] });
    return jsonResponse(200, { Count: 0, results: [] });
  }) as typeof fetch;
  try {
    const server = createServer({});
    const result = await toolHandler(server, "check_vehicle_recalls")({ year: 2019, make: "Chevy", model: "Silverado" }, {});
    assert.equal(result.isError, undefined);
    assert.match(urls[0]!, /make=chevrolet/);
    assert.match(urls[0]!, /model=silverado\+1500/);
  } finally {
    globalThis.fetch = original;
  }
});

test("check says no recalls found when sources answer zero and could not check only on failure", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { year: 2019, make: "Chevy", model: "Silverado" }, async () => "known");
  const empty = await checkWatchList(env, "user", async () => ({ recalls: [], failed: false }));
  assert.match(empty.text, /NHTSA lists no recalls filed under the name 2019 Chevrolet Silverado 1500\. That does not prove the car is safe\./);
  assert.ok(!empty.text.includes("No recalls found"), empty.text);
  assert.ok(!empty.text.includes("could not check"), empty.text);

  const unavailable = await checkWatchList(env, "user", async () => ({ recalls: [], failed: true }));
  assert.match(unavailable.text, /could not check/);
  assert.ok(!unavailable.text.includes("No recalls found"), unavailable.text);
});

test("the vehicle tool answers an ambiguous prefix with a question naming the vPIC choices", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Model S" }, { Model_Name: "Model X" }, { Model_Name: "Model 3" }, { Model_Name: "Model Y" }] }), { status: 200 });
    }
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  try {
    const result = await toolHandler(createServer({ env: watchEnv() }), "check_vehicle_recalls")({ year: 2021, make: "tesla", model: "model" }, {});
    assert.equal(result.isError, undefined);
    assert.equal(result.content?.[0]?.text, "Which one, Model 3, Model S, Model X or Model Y?");
  } finally {
    globalThis.fetch = original;
  }
});

test("a misheard vehicle saved from a single vPIC prefix uses the real model name", async () => {
  const env = watchEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Accord" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const added = await addWatchItem(env, "user", { year: 2019, make: "honda", model: "accordion" });
    assert.ok(added.ok);
    assert.equal(added.item.label, "2019 Honda Accord");
    assert.equal(added.item.model, "accord");
    assert.equal((await readWatchList(env, "user"))[0]?.label, "2019 Honda Accord");
  } finally {
    globalThis.fetch = original;
  }
});

test("check_all_recalls turns a vehicle kind with no make or model into a year make and model prompt", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new TypeError("no source should be searched");
  }) as typeof fetch;
  try {
    const result = await toolHandler(createServer({ env: watchEnv() }), "check_all_recalls")({ query: "is my car recalled" }, {});
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /Which vehicle\?/);
    assert.match(text, /year, make and model/);
    assert.equal(result.isError, undefined);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("the watch lead ranks a hazard that mentions death above a newer high severity recall", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { item: "crib" });
  await addWatchItem(env, "user", { item: "stroller" });
  const fatal = makeRecall({ id: "C-1", title: "Crib", date: "2023-01-01", hazard: "The crib can cause death." });
  const highNewer = makeRecall({ id: "S-1", title: "Stroller", date: "2025-06-01", severity: "high", hazard: "The stroller may tip over." });
  const lookup = async (item: WatchItem) => ({ recalls: item.query === "crib" ? [fatal] : [highNewer], failed: false });
  const check = await checkWatchList(env, "user", lookup);
  assert.equal(check.recalls[0]?.id, "C-1");
  assert.equal(check.recalls[1]?.id, "S-1");
});

test("a saved vehicle keeps the vPIC display casing on the watch list (2021 Lexus RX)", async () => {
  const env = watchEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify({ Results: [{ Model_Name: "RX" }] }), { status: 200 });
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const added = await addWatchItem(env, "user", { year: 2021, make: "lexus", model: "rx" });
    assert.ok(added.ok);
    assert.equal(added.item.label, "2021 Lexus RX");
    assert.equal(added.item.model, "rx");
    assert.equal((await readWatchList(env, "user"))[0]?.label, "2021 Lexus RX");
  } finally {
    globalThis.fetch = original;
  }
});

test("a saved vehicle keeps the vPIC casing when the model already has recalls (rx -> 2021 Lexus RX)", async () => {
  const env = watchEnv();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify({ Results: [{ Model_Name: "RX" }] }), { status: 200 });
    return new Response(JSON.stringify({ Count: 1, results: [{ NHTSACampaignNumber: "20V-1", ReportReceivedDate: "01/02/2021", Component: "AIR BAGS", Consequence: "The air bag may fail.", Remedy: "Dealers will replace it." }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const added = await addWatchItem(env, "user", { year: 2021, make: "lexus", model: "rx" });
    assert.ok(added.ok);
    assert.equal(added.item.label, "2021 Lexus RX");
    assert.equal((await readWatchList(env, "user"))[0]?.label, "2021 Lexus RX");
  } finally {
    globalThis.fetch = original;
  }
});

test("a saved vehicle uses the vPIC spelling for C300, CX-5 and F-150", async () => {
  const cases = [
    { year: 2021, make: "mercedes-benz", model: "c300", vpic: "C300", label: "2021 Mercedes-Benz C300" },
    { year: 2021, make: "mazda", model: "cx-5", vpic: "CX-5", label: "2021 Mazda CX-5" },
    { year: 2021, make: "ford", model: "f150", vpic: "F-150", label: "2021 Ford F-150" },
  ];
  for (const entry of cases) {
    const env = watchEnv();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify({ Results: [{ Model_Name: entry.vpic }] }), { status: 200 });
      return new Response(JSON.stringify({ Count: 1, results: [{ NHTSACampaignNumber: "R-1", ReportReceivedDate: "01/02/2021", Component: "BRAKES", Consequence: "The part may fail.", Remedy: "Dealers will replace it." }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const added = await addWatchItem(env, "user", { year: entry.year, make: entry.make, model: entry.model });
      assert.ok(added.ok);
      assert.equal(added.item.label, entry.label);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test("the watch check never reports a related model's recall as the saved car's recall", async () => {
  const env = watchEnv();
  await addWatchItem(env, "user", { year: 2021, make: "toyota", model: "corolla" }, async () => ({ status: "known", model: "Corolla" }));
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) return new Response(JSON.stringify({ Results: [{ Model_Name: "Corolla" }, { Model_Name: "Corolla Cross" }] }), { status: 200 });
    if (url.includes("/products/vehicle/models")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    if (/model=Corolla\+Cross/.test(url)) {
      return new Response(JSON.stringify({ Count: 1, results: [{ NHTSACampaignNumber: "CROSS-1", ReportReceivedDate: "01/02/2021", Component: "BRAKES", Consequence: "The part may fail.", Remedy: "Dealers will replace it." }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const check = await checkWatchList(env, "user");
    assert.equal(check.newItems, 0, "the Corolla Cross recall is not the Corolla's");
    assert.deepEqual(check.recalls, []);
    assert.match(check.text, /NHTSA lists no recalls filed under the name 2021 Toyota Corolla\./, check.text);
  } finally {
    globalThis.fetch = original;
  }
});

test("itemSearch breaks a same-date tie by severity, a death mention first", async () => {
  const death = makeRecall({ id: "D-1", source: "fda-food", date: "2024-01-01", hazard: "The product can cause death." });
  const high = makeRecall({ id: "H-1", source: "fda-food", date: "2024-01-01", severity: "high", hazard: "May cause serious injury." });
  const none = makeRecall({ id: "N-1", source: "fda-food", date: "2024-01-01", hazard: "A minor fault." });
  const search = async (q: string) => hit(q, "fda-food", [none, high, death]);
  const result = await itemSearch(search, "widget");
  assert.deepEqual(result.recalls.map((r) => r.id), ["D-1", "H-1", "N-1"]);
});
