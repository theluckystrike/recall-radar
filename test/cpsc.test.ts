import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchProducts } from "../src/sources/cpsc";
import { SourceError } from "../src/types";

type FetchFn = typeof fetch;

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

test("maps a real CPSC fixture, newest first, capped to 5", async () => {
  const body = loadFixture("cpsc-crib.json");
  const result = await searchProducts("crib", fetchReturning(200, body));
  assert.equal(result.query, "crib");
  assert.equal(result.source, "cpsc");
  assert.equal(result.total, 8);
  assert.equal(result.recalls.length, 5);

  const first = result.recalls[0]!;
  assert.equal(first.id, "26669");
  assert.equal(first.date, "2026-08-06");
  assert.equal(
    first.title,
    "Play Yard and Crib Mattresses Recalled Due to Risk of Serious Injury or Death from Entrapment and Fire Hazards...",
  );
  assert.ok(first.title.length <= 120);
  assert.ok(first.hazard.startsWith("The recalled mattresses violate"));
  assert.ok(first.hazard.length <= 300);
  assert.ok(first.remedy.startsWith("Consumers should stop using the mattresses"));
  assert.ok(first.remedy.length <= 300);
  assert.ok(first.url.startsWith("https://www.cpsc.gov/"));

  for (let i = 1; i < result.recalls.length; i++) {
    assert.ok(result.recalls[i - 1]!.date >= result.recalls[i]!.date, "dates newest first");
  }
});

test("returns zero results for an empty array", async () => {
  const result = await searchProducts("nothing", fetchReturning(200, []));
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
});

test("sorts out-of-order results by date descending", async () => {
  const body = [
    { RecallNumber: "1", RecallDate: "2020-01-01T00:00:00", Title: "Oldest" },
    { RecallNumber: "2", RecallDate: "2024-05-05T00:00:00", Title: "Newest" },
    { RecallNumber: "3", RecallDate: "2022-03-03T00:00:00", Title: "Middle" },
  ];
  const result = await searchProducts("q", fetchReturning(200, body));
  assert.deepEqual(
    result.recalls.map((r) => r.id),
    ["2", "3", "1"],
  );
});

test("falls back to empty hazard and remedy when arrays are empty", async () => {
  const body = [
    {
      RecallNumber: "1",
      RecallDate: "2024-01-01T00:00:00",
      Title: "No details",
      Hazards: [],
      Remedies: [],
    },
  ];
  const result = await searchProducts("q", fetchReturning(200, body));
  assert.equal(result.recalls[0]!.hazard, "");
  assert.equal(result.recalls[0]!.remedy, "");
});

test("falls back title to product name when Title is missing", async () => {
  const body = [
    {
      RecallNumber: "1",
      RecallDate: "2024-01-01T00:00:00",
      Products: [{ Name: "Some Product" }],
    },
  ];
  const result = await searchProducts("q", fetchReturning(200, body));
  assert.equal(result.recalls[0]!.title, "Some Product");
});

test("skips items without an id or a parseable date", async () => {
  const body = [
    { RecallDate: "2024-01-01T00:00:00", Title: "no id" },
    { RecallNumber: "1", Title: "no date" },
    { RecallNumber: "2", RecallDate: "not-a-date", Title: "bad date" },
    { RecallNumber: "3", RecallDate: "2024-01-01T00:00:00", Title: "valid" },
  ];
  const result = await searchProducts("q", fetchReturning(200, body));
  assert.equal(result.recalls.length, 1);
  assert.equal(result.recalls[0]!.id, "3");
});

test("encodes the query in the request URL and searches distinctive words in parallel", async () => {
  const seen: string[] = [];
  const fetchFn: FetchFn = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return jsonResponse(200, []);
  }) as unknown as FetchFn;
  await searchProducts("graco crib", fetchFn);
  assert.ok(seen.some((u) => u.includes("RecallTitle=graco%20crib")));
  assert.ok(seen.some((u) => u.endsWith("RecallTitle=graco")));
  assert.ok(seen.length <= 3, "at most 3 requests, all in one parallel round");
});

test("throws SourceError on non-200 status", async () => {
  await assert.rejects(
    () => searchProducts("crib", fetchReturning(500, {})),
    (err: unknown) => err instanceof SourceError,
  );
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
  await assert.rejects(() => searchProducts("crib", fetchFn), SourceError);
});

test("throws SourceError on a non-array body", async () => {
  await assert.rejects(
    () => searchProducts("crib", fetchReturning(200, { not: "an array" })),
    SourceError,
  );
});

test("throws SourceError on network failure", async () => {
  await assert.rejects(
    () => searchProducts("crib", fetchThrowing(new TypeError("network down"))),
    SourceError,
  );
});
