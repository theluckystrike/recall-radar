import test from "node:test";
import assert from "node:assert/strict";
import { cleanItem } from "../src/query.js";
import { itemSearch } from "../src/server.js";
import { searchFood } from "../src/sources/fda.js";

test("cleanItem keeps only the item from a spoken worry", () => {
  assert.equal(cleanItem("is zyrtec safe to take"), "zyrtec");
  assert.equal(cleanItem("is my peanut butter safe to eat"), "peanut butter");
  assert.equal(cleanItem("is my crib safe"), "crib");
  assert.equal(cleanItem("does my ByHeart formula have a recall"), "byheart formula");
});

test("cleanItem strips accents and refuses text with no Latin letters", () => {
  assert.equal(cleanItem("jalapeño"), "jalapeno");
  assert.equal(cleanItem("crème brûlée"), "creme brulee");
  assert.throws(() => cleanItem("ибупрофен"), /English letters/);
});

test("a query with no readable item is refused and never searches everything", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return { query: "", source: "fda-drug" as const, total: 0, recalls: [] };
  };
  await assert.rejects(itemSearch(search, "ибупрофен"), /English letters/);
  assert.equal(calls, 0);
});

test("FDA retries with every word required when the exact phrase finds nothing", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    if (urls.length === 1) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    return new Response(JSON.stringify({ meta: { results: { total: 1 } }, results: [{ recall_number: "H-0249-2026", product_description: "ByHeart Whole Nutrition Infant Formula", reason_for_recall: "Botulism", classification: "Class I", report_date: "20260101", status: "Ongoing", recalling_firm: "ByHeart" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await searchFood("byheart formula", fetchFn);
  assert.equal(urls.length, 2);
  assert.match(urls[1]!, /product_description:byheart\+AND\+product_description:formula/);
  assert.equal(r.total, 1);
  assert.match(r.query, /all words matched/);
});
