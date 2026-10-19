import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isAmbiguousVehicleError,
  isUnknownVehicleError,
  isVehicleServiceError,
  searchVehicle,
} from "../src/sources/nhtsa";
import { speak } from "../src/speech";
import { SourceError } from "../src/types";

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const fixture = loadFixture("nhtsa-honda-accord-2018.json");
const camryVpic = loadFixture("vpic-toyota-camry-2026.json");
const f150Vpic = loadFixture("vpic-ford-f150-2021.json");
const hondaVpic = loadFixture("vpic-honda-2026.json");
const mazdaVpic = loadFixture("vpic-mazda-2019.json");
const chevroletVpic = loadFixture("vpic-chevrolet-2019.json");

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

/** Routes NHTSA and vPIC calls to their own answers, so the fallback path can be tested exactly. */
function routedFetch(routes: Array<[string, () => Response]>): FetchFn {
  return async (input) => {
    const url = String(input);
    for (const [needle, answer] of routes) if (url.includes(needle)) return answer();
    return new Response("{}", { status: 404 });
  };
}

const vpic = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const nhtsa = (status: number, body: unknown = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  const urls: string[] = [];
  const capture: FetchFn = async (input) => {
    urls.push(String(input));
    if (String(input).includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "C-Class" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  };

  await searchVehicle("mercedes benz", "c-class", 2020, capture);
  assert.equal(
    urls[0],
    "https://api.nhtsa.gov/recalls/recallsByVehicle?make=mercedes+benz&model=c-class&modelYear=2020"
  );
});

test("passes an AbortSignal timeout and JSON accept header to fetch", async () => {
  let capturedSignal: unknown = null;
  let capturedHeaders: unknown;
  const capture: FetchFn = async (input, init) => {
    capturedSignal = init?.signal ?? null;
    capturedHeaders = init?.headers;
    if (String(input).includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Accord" }] }), { status: 200 });
    }
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

test("returns total 0 and empty recalls when no results and vPIC lists the model", async () => {
  const result = await searchVehicle(
    "honda",
    "accord",
    2018,
    routedFetch([
      ["vpic.nhtsa.dot.gov", vpic({ Results: [{ Model_Name: "Accord" }] })],
      ["api.nhtsa.gov", nhtsa(200, { Count: 0, results: [] })],
    ])
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
  assert.equal(result.query, "2018 Honda Accord");
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

test("same-date search results break a tie by severity, and a death mention ranks above other high severity", async () => {
  const body = {
    Count: 3,
    results: [
      { NHTSACampaignNumber: "A", ReportReceivedDate: "01/02/2020", Component: "BRAKES", Consequence: "Parts may fail." },
      { NHTSACampaignNumber: "B", ReportReceivedDate: "01/02/2020", Component: "ENGINE", Consequence: "The defect can cause death." },
      { NHTSACampaignNumber: "C", ReportReceivedDate: "01/02/2020", Component: "SEATS", Consequence: "The seat may break.", parkIt: true },
    ],
  };
  const result = await searchVehicle("honda", "accord", 2018, ok(body));
  assert.deepEqual(result.recalls.map((r) => r.id), ["B", "C", "A"]);
});

test("a 400 for a real model with no recalls is confirmed by vPIC as no recalls listed", async () => {
  const result = await searchVehicle(
    "toyota",
    "camry",
    2026,
    routedFetch([
      ["vpic.nhtsa.dot.gov", vpic(camryVpic)],
      ["api.nhtsa.gov", nhtsa(400)],
    ])
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
  assert.equal(result.query, "2026 Toyota Camry");
});

test("an empty NHTSA answer for a real model is confirmed by vPIC", async () => {
  const result = await searchVehicle(
    "toyota",
    "camry",
    2026,
    routedFetch([
      ["vpic.nhtsa.dot.gov", vpic(camryVpic)],
      ["api.nhtsa.gov", nhtsa(200, { Count: 0, results: [] })],
    ])
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
});

test("a model vPIC does not list is refused as unknown", async () => {
  await assert.rejects(
    () =>
      searchVehicle(
        "honda",
        "nope",
        2026,
        routedFetch([
          ["vpic.nhtsa.dot.gov", vpic(hondaVpic)],
          ["api.nhtsa.gov", nhtsa(400)],
        ])
      ),
    (error: unknown) => isUnknownVehicleError(error)
  );
});

test("a vPIC failure says the vehicle service is unavailable, never unknown and never no recalls", async () => {
  await assert.rejects(
    () =>
      searchVehicle(
        "toyota",
        "camry",
        2026,
        routedFetch([
          ["vpic.nhtsa.dot.gov", nhtsa(500)],
          ["api.nhtsa.gov", nhtsa(400)],
        ])
      ),
    (error: unknown) => {
      assert.ok(isVehicleServiceError(error), "a service error is reported");
      assert.ok(!isUnknownVehicleError(error), "a vPIC failure is never called unknown");
      return true;
    }
  );
  await assert.rejects(
    () =>
      searchVehicle(
        "toyota",
        "camry",
        2026,
        routedFetch([
          ["vpic.nhtsa.dot.gov", () => { throw new TypeError("network down"); }],
          ["api.nhtsa.gov", nhtsa(400)],
        ])
      ),
    (error: unknown) => isVehicleServiceError(error)
  );
});

test("F150 matches F-150 in vPIC, so the spoken form is accepted", async () => {
  const result = await searchVehicle(
    "ford",
    "F150",
    2021,
    routedFetch([
      ["vpic.nhtsa.dot.gov", vpic(f150Vpic)],
      ["api.nhtsa.gov", nhtsa(400)],
    ])
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
});

test("a real recall answer never calls vPIC", async () => {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(fixture), { status: 200 });
  };
  const result = await searchVehicle("honda", "accord", 2018, fetchFn);
  assert.equal(result.recalls.length, 5);
  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.includes("api.nhtsa.gov"));
});

test("a make-prefixed vPIC name is accepted (Mazda3 for make mazda, model 3)", async () => {
  const result = await searchVehicle(
    "mazda",
    "3",
    2019,
    routedFetch([
      ["vpic.nhtsa.dot.gov", vpic(mazdaVpic)],
      ["api.nhtsa.gov", nhtsa(400)],
    ])
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
  assert.equal(result.query, "2019 Mazda 3");
});

test("a make-prefixed model is searched again under the vPIC name before saying nothing is listed", async () => {
  const seen: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("vpic.nhtsa.dot.gov")) return vpic(mazdaVpic)();
    if (url.includes("api.nhtsa.gov") && /model=Mazda3/i.test(url)) return nhtsa(200, fixture)();
    return nhtsa(400)();
  };
  const result = await searchVehicle("mazda", "3", 2019, fetchFn);
  assert.ok(result.total > 0, "recalls filed under Mazda3 are found for the spoken model 3");
  assert.equal(result.query, "2019 Mazda 3");
  assert.ok(seen.some((u) => /model=Mazda3/i.test(u)), "NHTSA was asked again with the vPIC name");
});

test("a vPIC name that adds a trim still matches the wanted model", async () => {
  const result = await searchVehicle(
    "chevrolet",
    "silverado",
    2019,
    routedFetch([
      ["vpic.nhtsa.dot.gov", vpic(chevroletVpic)],
      ["api.nhtsa.gov", nhtsa(400)],
    ])
  );
  assert.equal(result.total, 0);
  assert.deepEqual(result.recalls, []);
});

test("a vPIC 200 without a Results array or with an Errors array is a service error, never unknown", async () => {
  for (const body of [{}, { Errors: ["invalid make"] }]) {
    await assert.rejects(
      () =>
        searchVehicle(
          "toyota",
          "camry",
          2026,
          routedFetch([
            ["vpic.nhtsa.dot.gov", vpic(body)],
            ["api.nhtsa.gov", nhtsa(400)],
          ])
        ),
      (error: unknown) => {
        assert.ok(isVehicleServiceError(error), `service error for ${JSON.stringify(body)}`);
        assert.ok(!isUnknownVehicleError(error), "a 200 error body is never called unknown");
        return true;
      }
    );
  }
});

test("the vPIC model list is cached by make and year for six hours", async () => {
  let vpicCalls = 0;
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      vpicCalls++;
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Camry" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  };
  const first = await searchVehicle("toyota", "camry", 2026, fetchFn);
  const second = await searchVehicle("toyota", "camry", 2026, fetchFn);
  assert.equal(first.total, 0);
  assert.equal(second.total, 0);
  assert.equal(vpicCalls, 1, "the second check uses the cached model list");
});

const recallRecord = (campaign: string, component = "BRAKES") => ({
  NHTSACampaignNumber: campaign,
  ReportReceivedDate: "01/02/2021",
  Component: component,
  Consequence: "The part may fail.",
  Remedy: "Dealers will replace it.",
});

test("a family name searches the listed sub-models and merges recalls by campaign number", async () => {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "C-Class" }] }), { status: 200 });
    }
    if (url.includes("/products/vehicle/models")) {
      return new Response(JSON.stringify({ results: [{ model: "C300" }, { model: "C43" }, { model: "C300" }] }), { status: 200 });
    }
    if (/model=C300(?:&|$)/.test(url)) {
      return new Response(JSON.stringify({ Count: 1, results: [recallRecord("A")] }), { status: 200 });
    }
    if (/model=C43(?:&|$)/.test(url)) {
      return new Response(JSON.stringify({ Count: 2, results: [recallRecord("B"), recallRecord("A")] }), { status: 200 });
    }
    return new Response("{}", { status: 400 });
  };
  const result = await searchVehicle("mercedes-benz", "c-class", 2021, fetchFn);
  assert.equal(result.total, 2, "the duplicate campaign is counted once");
  assert.deepEqual(result.recalls.map((r) => r.id).sort(), ["A", "B"]);
  assert.equal(result.query, "2021 Mercedes-Benz C-Class");
  const subModelCalls = urls.filter((url) => url.includes("recallsByVehicle") && /model=(C300|C43)/.test(url));
  assert.equal(subModelCalls.length, 2, "each listed sub-model is searched once");
  const out = speak(result);
  assert.match(out, /C300 and C43/, out);
});

test("a family name with no sub-model recalls says what was searched and never claims safety", async () => {
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "C-Class" }] }), { status: 200 });
    }
    if (url.includes("/products/vehicle/models")) {
      return new Response(JSON.stringify({ results: [{ model: "C300" }, { model: "C43" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  };
  const result = await searchVehicle("mercedes-benz", "c-class", 2021, fetchFn);
  assert.equal(result.total, 0);
  const out = speak(result);
  assert.match(out, /after checking C300, C250, C350, C400, C450 and C43/, out);
  assert.match(out, /That does not prove the car is safe/, out);
  // C300 was already searched, so the hint must not name it back: it drops the "such as" clause.
  assert.doesNotMatch(out, /such as/, out);
  assert.match(out, /check the exact model on the registration/, out);
});

test("an ambiguous prefix asks which real vPIC model instead of refusing", async () => {
  const fetchFn = routedFetch([
    ["vpic.nhtsa.dot.gov", vpic({ Results: [{ Model_Name: "Model S" }, { Model_Name: "Model X" }, { Model_Name: "Model 3" }, { Model_Name: "Model Y" }] })],
    ["api.nhtsa.gov", nhtsa(400)],
  ]);
  await assert.rejects(
    () => searchVehicle("tesla", "model", 2021, fetchFn),
    (error: unknown) => {
      assert.ok(isAmbiguousVehicleError(error));
      assert.equal(error.message, "Which one, Model 3, Model S, Model X or Model Y?");
      return true;
    }
  );
});

test("a single prefix match speaks and returns the vPIC name, never the misheard name", async () => {
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Accord" }] }), { status: 200 });
    }
    if (url.includes("/products/vehicle/models")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (/model=Accord(?:&|$)/.test(url)) {
      return new Response(JSON.stringify({ Count: 1, results: [recallRecord("A")] }), { status: 200 });
    }
    return new Response("{}", { status: 400 });
  };
  const result = await searchVehicle("honda", "accordion", 2019, fetchFn);
  assert.equal(result.query, "2019 Honda Accord");
  assert.ok(!result.query.includes("Accordion"), result.query);
  assert.match(speak(result), /for the 2019 Honda Accord\./, speak(result));
});

test("a C-Class searches the numbered models C300 and C450 and names what the recalls were filed under", async () => {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "C-Class" }] }), { status: 200 });
    }
    if (url.includes("/products/vehicle/models")) {
      return new Response(JSON.stringify({ results: [{ model: "C-CLASS PHEV" }] }), { status: 200 });
    }
    if (/model=C300(?:&|$)/.test(url)) {
      return new Response(JSON.stringify({ Count: 2, results: [recallRecord("A"), recallRecord("B")] }), { status: 200 });
    }
    if (/model=C450(?:&|$)/.test(url)) {
      return new Response(JSON.stringify({ Count: 2, results: [recallRecord("B"), recallRecord("C")] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  };
  const result = await searchVehicle("mercedes-benz", "c-class", 2016, fetchFn);
  assert.equal(result.total, 3, "the shared campaign number B is merged once");
  assert.deepEqual(result.recalls.map((r) => r.id).sort(), ["A", "B", "C"]);
  assert.equal(result.query, "2016 Mercedes-Benz C-Class");
  assert.ok(urls.some((u) => /model=C300(?:&|$)/.test(u)), "C300 was searched");
  assert.ok(urls.some((u) => /model=C450(?:&|$)/.test(u)), "C450 was searched");
  const out = speak(result);
  assert.match(out, /filed under C300 and C450/, out);
  assert.doesNotMatch(out, /PHEV/, out);
});

test("the sub-model hint never names a searched model and skips PHEV style variants", async () => {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "C-Class" }] }), { status: 200 });
    }
    if (url.includes("/products/vehicle/models")) {
      return new Response(JSON.stringify({ results: [{ model: "C300" }, { model: "C43" }, { model: "C-CLASS PHEV" }, { model: "C450 AMG" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Count: 0, results: [] }), { status: 200 });
  };
  const result = await searchVehicle("mercedes-benz", "c-class", 2019, fetchFn);
  assert.equal(result.total, 0);
  const out = speak(result);
  assert.match(out, /such as C450 AMG for a C-Class/, out);
  assert.doesNotMatch(out, /PHEV/, out);
  assert.doesNotMatch(out, /such as C300/, out);
  assert.ok(!urls.some((u) => u.includes("AMG")), "the model named in the hint was not searched");
});

test("a model the speaker or NHTSA writes in capitals keeps them (2021 Lexus RX)", async () => {
  const body = {
    Count: 1,
    results: [
      {
        NHTSACampaignNumber: "99V000001",
        ReportReceivedDate: "01/02/2021",
        Model: "RX",
        Component: "BRAKES",
        Consequence: "The brakes may fail.",
        Remedy: "Dealers will replace them.",
      },
    ],
  };
  const spoken = await searchVehicle("lexus", "RX", 2021, ok(body));
  assert.equal(spoken.query, "2021 Lexus RX");
  assert.equal(spoken.recalls[0]?.title, "Brakes (2021 Lexus RX)");

  const lower = await searchVehicle("lexus", "rx", 2021, ok(body));
  assert.equal(lower.query, "2021 Lexus RX", "the capitals NHTSA uses are kept");
});
