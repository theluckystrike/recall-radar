import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { searchVehicle } from "../src/sources/nhtsa";
import { SourceError } from "../src/types";

const fixtureUrl = new URL(
  "./fixtures/nhtsa-honda-accord-2018.json",
  import.meta.url
);
const fixture = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8"));

type FetchFn = typeof fetch;

function ok(body: unknown): FetchFn {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function httpError(status: number): FetchFn {
  return async () => new Response("{}", { status });
}

function nonJson(): FetchFn {
  return async () =>
    new Response("not json at all", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
}

function networkFail(): FetchFn {
  return async () => {
    throw new TypeError("network down");
  };
}

test("maps a real NHTSA response newest first, capped at 5", async () => {
  const result = await searchVehicle("honda", "accord", 2018, ok(fixture));

  assert.equal(result.source, "nhtsa");
  assert.equal(result.query, "2018 Honda Accord");
  assert.equal(result.total, 6);
  assert.equal(result.recalls.length, 5);

  const first = result.recalls[0];
  assert.equal(first?.id, "26V332000");
  assert.equal(first?.date, "2026-05-21");
  assert.equal(
    first?.url,
    "https://www.nhtsa.gov/recalls?nhtsaId=26V332000"
  );
  assert.equal(
    first?.title,
    "Air bags: sensor, occupant classification, front passenger (2018 Honda Accord)"
  );
  assert.equal(
    first?.hazard,
    "Air bags that deploy unintentionally during a crash increase the risk of injury."
  );
  assert.equal(first?.severity, undefined);

  const last = result.recalls[4];
  assert.equal(last?.id, "20V314000");
  assert.equal(last?.date, "2020-05-28");

  const dates = result.recalls.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("constructs the endpoint URL with encoded params", async () => {
  let capturedUrl = "";
  const capture: FetchFn = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ Count: 0, results: [] }), {
      status: 200,
    });
  };

  await searchVehicle("mercedes benz", "c-class", 2020, capture);
  assert.equal(
    capturedUrl,
    "https://api.nhtsa.gov/recalls/recallsByVehicle?make=mercedes+benz&model=c-class&modelYear=2020"
  );
});

test("passes an AbortSignal timeout and JSON accept header to fetch", async () => {
  let capturedSignal: unknown = null;
  let capturedHeaders: unknown;
  const capture: FetchFn = async (_input, init) => {
    capturedSignal = init?.signal ?? null;
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({ Count: 0, results: [] }), {
      status: 200,
    });
  };

  await searchVehicle("honda", "accord", 2018, capture);
  assert.ok(capturedSignal !== null);
  assert.equal(typeof (capturedSignal as { aborted?: unknown }).aborted, "boolean");
  assert.deepEqual(capturedHeaders, { accept: "application/json" });
});

test("throws RangeError when year is out of range", async () => {
  await assert.rejects(
    searchVehicle("honda", "accord", 1949, ok(fixture)),
    RangeError
  );
  await assert.rejects(
    searchVehicle("honda", "accord", new Date().getFullYear() + 2, ok(fixture)),
    RangeError
  );
});

test("throws RangeError when year is not an integer", async () => {
  await assert.rejects(
    searchVehicle("honda", "accord", 2018.5, ok(fixture)),
    RangeError
  );
  await assert.rejects(searchVehicle("honda", "accord", NaN, ok(fixture)), RangeError);
});

test("throws SourceError on network failure", async () => {
  await assert.rejects(
    searchVehicle("honda", "accord", 2018, networkFail()),
    SourceError
  );
});

test("throws SourceError on HTTP error status", async () => {
  await assert.rejects(
    searchVehicle("honda", "accord", 2018, httpError(500)),
    SourceError
  );
});

test("throws SourceError on non-JSON body", async () => {
  await assert.rejects(
    searchVehicle("honda", "accord", 2018, nonJson()),
    SourceError
  );
});

test("returns total 0 and empty recalls when no results", async () => {
  const result = await searchVehicle(
    "honda",
    "accord",
    2018,
    ok({ Count: 0, results: [] })
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
});

test("falls back to Summary when Consequence is missing", async () => {
  const body = {
    Count: 1,
    results: [
      {
        NHTSACampaignNumber: "99V000001",
        ReportReceivedDate: "01/02/2020",
        Component: "BRAKES",
        Summary: "The brakes may fail.",
        Remedy: "Replace the brakes.",
      },
    ],
  };
  const result = await searchVehicle("honda", "accord", 2018, ok(body));
  assert.equal(result.recalls[0]?.hazard, "The brakes may fail.");
});

test("marks severity high when parkIt or parkOutSide is true", async () => {
  const body = {
    Count: 2,
    results: [
      {
        NHTSACampaignNumber: "99V000001",
        ReportReceivedDate: "01/02/2020",
        Component: "BRAKES",
        Consequence: "Failure.",
        parkIt: true,
      },
      {
        NHTSACampaignNumber: "99V000002",
        ReportReceivedDate: "01/02/2020",
        Component: "ENGINE",
        Consequence: "Failure.",
        parkOutSide: true,
      },
    ],
  };
  const result = await searchVehicle("honda", "accord", 2018, ok(body));
  assert.equal(result.recalls[0]?.severity, "high");
  assert.equal(result.recalls[1]?.severity, "high");
});

test("trims, collapses whitespace and caps long fields", async () => {
  const longText = "word ".repeat(400);
  const body = {
    Count: 1,
    results: [
      {
        NHTSACampaignNumber: "99V000001",
        ReportReceivedDate: "01/02/2020",
        Component: "  BRAKES  ",
        Consequence: "   The\nbrakes\tmay   fail.   ",
        Remedy: longText,
      },
    ],
  };
  const result = await searchVehicle("honda", "accord", 2018, ok(body));
  const recall = result.recalls[0];
  assert.equal(recall?.title, "Brakes (2018 Honda Accord)");
  assert.equal(recall?.hazard, "The brakes may fail.");
  assert.ok((recall?.remedy.length ?? 0) <= 300, "remedy stays within 300 characters");
  assert.match(recall?.remedy ?? "", /^(word )+word\.\.\.$/, "cut at a word boundary, marked with ...");
});

test("skips records missing a campaign number or a parseable date", async () => {
  const body = {
    Count: 4,
    results: [
      null,
      "garbage",
      { ReportReceivedDate: "01/02/2020", Component: "BRAKES" },
      {
        NHTSACampaignNumber: "99V000001",
        ReportReceivedDate: "not-a-date",
        Component: "BRAKES",
      },
      {
        NHTSACampaignNumber: "99V000002",
        ReportReceivedDate: "01/02/2020",
        Component: "BRAKES",
        Consequence: "Failure.",
      },
    ],
  };
  const result = await searchVehicle("honda", "accord", 2018, ok(body));
  assert.equal(result.recalls.length, 1);
  assert.equal(result.recalls[0]?.id, "99V000002");
});
