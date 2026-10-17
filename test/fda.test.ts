import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchFood, searchDrug } from "../src/sources/fda";
import { SourceError } from "../src/types";

type FetchFn = typeof fetch;

const FDA_PAGE = "https://www.accessdata.fda.gov/scripts/ires/index.cfm";

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function fetchReturning(status: number, body: unknown): FetchFn {
  return (async () => jsonResponse(status, body)) as unknown as FetchFn;
}

function fetchThrowing(err: Error): FetchFn {
  return (async () => {
    throw err;
  }) as unknown as FetchFn;
}

test("maps a real FDA food fixture", async () => {
  const result = await searchFood("peanut butter", fetchReturning(200, loadFixture("fda-food.json")));
  assert.equal(result.query, "peanut butter");
  assert.equal(result.source, "fda-food");
  assert.equal(result.total, 606);
  assert.equal(result.recalls.length, 5);

  const first = result.recalls[0]!;
  assert.equal(first.id, "H-1386-2026");
  assert.equal(first.date, "2026-09-23");
  assert.equal(first.severity, "medium");
  assert.equal(first.remedy, "");
  assert.equal(first.url, FDA_PAGE);
  assert.ok(first.title.startsWith("PUMPKIN SPICE NO BAKE COOKIE"));
  assert.ok(first.hazard.startsWith("Peanuts & Eggs"));
  assert.ok(first.title.length <= 120);
  assert.ok(first.hazard.length <= 300);

  const classI = result.recalls.find((r) => r.id === "H-0542-2026");
  assert.equal(classI!.severity, "high");
});

test("maps a real FDA drug fixture, Class III becomes low", async () => {
  const result = await searchDrug("ibuprofen", fetchReturning(200, loadFixture("fda-drug.json")));
  assert.equal(result.source, "fda-drug");
  assert.equal(result.total, 68);
  assert.equal(result.recalls.length, 5);
  const classIII = result.recalls.find((r) => r.id === "D-0047-2025");
  assert.equal(classIII!.severity, "low");
});

test("treats a 404 NOT_FOUND as zero results, not an error", async () => {
  const body = { error: { code: "NOT_FOUND", message: "No matches found!" } };
  const result = await searchFood("zzz", fetchReturning(404, body));
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
});

test("throws SourceError on a 404 without NOT_FOUND", async () => {
  await assert.rejects(
    () => searchFood("zzz", fetchReturning(404, { error: { code: "OTHER" } })),
    SourceError,
  );
});

test("throws SourceError on other non-200 status", async () => {
  await assert.rejects(() => searchFood("zzz", fetchReturning(500, {})), SourceError);
});

test("throws SourceError on non-JSON body", async () => {
  const fetchFn = (async () => {
    return {
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response;
  }) as unknown as FetchFn;
  await assert.rejects(() => searchFood("zzz", fetchFn), SourceError);
});

test("throws SourceError when the 200 body has no results array", async () => {
  await assert.rejects(
    () => searchFood("zzz", fetchReturning(200, { meta: { results: { total: 3 } } })),
    SourceError,
  );
});

test("throws SourceError on network failure", async () => {
  await assert.rejects(
    () => searchDrug("ibuprofen", fetchThrowing(new TypeError("network down"))),
    SourceError,
  );
});

test("sanitizes the query and keeps the phrase quotes in the URL", async () => {
  let seen = "";
  const fetchFn: FetchFn = (async (url: string | URL | Request) => {
    seen = String(url);
    return jsonResponse(200, { meta: { results: { total: 0 } }, results: [] });
  }) as unknown as FetchFn;
  await searchFood("  peanut, butter!!<> ", fetchFn);
  assert.ok(seen.includes('search=product_description:"peanut%20butter"'), seen);
  assert.ok(seen.includes("/food/enforcement.json"));
  assert.ok(seen.includes("sort=report_date:desc&limit=5"));
});

test("caps the sanitized query at 60 characters", async () => {
  let seen = "";
  const fetchFn: FetchFn = (async (url: string | URL | Request) => {
    seen = String(url);
    return jsonResponse(200, { meta: { results: { total: 0 } }, results: [] });
  }) as unknown as FetchFn;
  const long = "a".repeat(100);
  await searchFood(long, fetchFn);
  assert.ok(seen.includes(`"${"a".repeat(60)}"`), "query truncated to 60 chars");
});
