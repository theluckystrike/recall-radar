import test from "node:test";
import assert from "node:assert/strict";

import { SourceError, type Recall, type SearchResult } from "../src/types.js";
import {
  addWatchItem,
  checkWatchList,
  classifyWatchItem,
  itemSearch,
  readWatchList,
  removeWatchItem,
  searchWatchItem,
  SEARCH_SOURCES,
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
