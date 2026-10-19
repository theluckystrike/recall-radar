import { test } from "node:test";
import assert from "node:assert/strict";
import { followUps, speak, speakMany, speakWatch, spokenTitle } from "../src/speech";
import type { Recall, SearchResult, Source } from "../src/types";

function recall(overrides: Partial<Recall>): Recall {
  return {
    source: "cpsc",
    id: "R-1",
    date: "2023-01-15",
    title: "Widget",
    hazard: "May cause injury.",
    remedy: "Contact the manufacturer.",
    url: "https://example.com",
    ...overrides,
  };
}

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    query: "widget",
    source: "cpsc",
    total: 1,
    recalls: [recall({})],
    ...overrides,
  };
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ---- 0 recalls, each source name ----

test("speak: zero recalls uses NHTSA name and never claims safety", () => {
  assert.equal(
    speak({ query: "honda accord", source: "nhtsa", total: 0, recalls: [] }),
    "NHTSA lists no recalls filed under the name honda accord. Recalls are often filed under a specific model, such as C300 for a C-Class, so check the exact model on the registration too. That does not prove the car is safe.",
  );
});

test("a prefix that fits two vPIC models is not accepted as either", async () => {
  const { searchVehicle } = await import("../src/sources/nhtsa.js");
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("vpic.nhtsa.dot.gov")) {
      return new Response(JSON.stringify({ Results: [{ Model_Name: "Model S" }, { Model_Name: "Model X" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  await assert.rejects(searchVehicle("tesla", "model", 2021, fetchFn));
});

test("speak: zero recalls uses CPSC name", () => {
  assert.equal(
    speak({ query: "crib", source: "cpsc", total: 0, recalls: [] }),
    "I found no recalls for crib in the Consumer Product Safety Commission. That does not prove it is safe, only that nothing is listed.",
  );
});

test("speak: zero recalls uses FDA food name", () => {
  assert.equal(
    speak({ query: "peanut butter", source: "fda-food", total: 0, recalls: [] }),
    "I found no recalls for peanut butter in the FDA food recall list. That does not prove it is safe, only that nothing is listed.",
  );
});

test("speak: zero recalls uses FDA drug name", () => {
  assert.equal(
    speak({ query: "aspirin", source: "fda-drug", total: 0, recalls: [] }),
    "I found no recalls for aspirin in the FDA drug recall list. That does not prove it is safe, only that nothing is listed.",
  );
});

// ---- one recall read in full ----

test("speak: one recall reads title, hazard, remedy in full", () => {
  const r = recall({
    date: "2023-01-15",
    title: "Graco Pack and Play",
    hazard: "The play yard can collapse.",
    remedy: "Contact Graco for a refund.",
  });
  assert.equal(
    speak({ query: "graco pack and play", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions graco pack and play. The newest is from January 2023. It is Graco Pack and Play. The play yard can collapse. Contact Graco for a refund.",
  );
});

test("speak: one NHTSA recall says 'for the' and 'It affects the air bags'", () => {
  const r = recall({
    source: "nhtsa",
    date: "2024-03-10",
    title: "AIR BAGS:SENSOR:OCCUPANT CLASSIFICATION SYSTEM",
    hazard: "The air bags may deploy unexpectedly.",
    remedy: "Contact your dealer for a free repair.",
  });
  assert.equal(
    speak({ query: "honda accord", source: "nhtsa", total: 1, recalls: [r] }),
    "I found 1 recall for the honda accord. The newest is from March 2024. It affects the air bags. The air bags may deploy unexpectedly. Contact your dealer for a free repair.",
  );
});

// ---- 6 recalls: only the first is read, the rest are counted ----

test("speak: six recalls reads only the first, counts the rest", () => {
  const recalls = [
    recall({ id: "1", date: "2023-06-01", title: "Product 1", hazard: "Hazard 1.", remedy: "Remedy 1." }),
    recall({ id: "2", date: "2023-05-01", title: "Product 2", hazard: "Hazard 2.", remedy: "Remedy 2." }),
    recall({ id: "3", date: "2023-04-01", title: "Product 3", hazard: "Hazard 3.", remedy: "Remedy 3." }),
    recall({ id: "4", date: "2023-03-01", title: "Product 4", hazard: "Hazard 4.", remedy: "Remedy 4." }),
    recall({ id: "5", date: "2023-02-01", title: "Product 5", hazard: "Hazard 5.", remedy: "Remedy 5." }),
    recall({ id: "6", date: "2023-01-01", title: "Product 6", hazard: "Hazard 6.", remedy: "Remedy 6." }),
  ];
  const out = speak({ query: "widgets", source: "cpsc", total: 6, recalls });
  assert.equal(
    out,
    'I found 6 recalls that mention widgets. The newest is from June 2023. It is Product 1. Hazard 1. Remedy 1. There are 5 more. Say "more" to hear the next 4.',
  );
  assert.ok(!out.includes("Product 2"));
});

// ---- missing remedy ----

test("speak: missing remedy omits the remedy sentence", () => {
  const r = recall({ date: "2023-02-01", title: "Lamp", hazard: "May catch fire.", remedy: "" });
  assert.equal(
    speak({ query: "lamp", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions lamp. The newest is from February 2023. It is Lamp. May catch fire.",
  );
});

// ---- high severity ----

test("speak: high severity prepends Important", () => {
  const r = recall({
    date: "2023-02-01",
    title: "Lamp",
    hazard: "May catch fire and cause serious burns.",
    remedy: "Stop using it immediately.",
    severity: "high",
  });
  assert.equal(
    speak({ query: "lamp", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions lamp. Important. The newest is from February 2023. It is Lamp. May catch fire and cause serious burns. Stop using it immediately.",
  );
});

// ---- FDA short reason prefix + pharmacist sentence ----

test("speak: short FDA reason gets the 'FDA says the reason is' prefix", () => {
  const r = recall({
    source: "fda-food",
    date: "2023-01-20",
    title: "Chocolate Bar",
    hazard: "Undeclared milk",
    remedy: "Return it.",
  });
  assert.equal(
    speak({ query: "chocolate bar", source: "fda-food", total: 1, recalls: [r] }),
    "I found 1 recall that mentions chocolate bar. The newest is from January 2023. It is Chocolate Bar. The FDA says the reason is Undeclared milk. Return it.",
  );
});

test("speak: an empty FDA hazard leaves no double space", () => {
  const r = recall({
    source: "fda-food",
    date: "2023-01-20",
    title: "Chocolate Bar",
    hazard: "",
    remedy: "Return it.",
  });
  const out = speak({ query: "chocolate bar", source: "fda-food", total: 1, recalls: [r] });
  assert.ok(!out.includes("  "), out);
  assert.ok(!out.includes("reason is ."), out);
  assert.equal(
    out,
    "I found 1 recall that mentions chocolate bar. The newest is from January 2023. It is Chocolate Bar. Return it.",
  );
});

test("no speech helper ever puts two spaces in a row", () => {
  const lamp = recall({ id: "L-1", title: "Lamp", hazard: "", remedy: "" });
  const food = recall({ id: "F-1", source: "fda-food", date: "2024-03-01", title: "Chocolate Bar", hazard: "Undeclared milk", remedy: "" });
  const outputs = [
    speak({ query: "lamp", source: "cpsc", total: 0, recalls: [] }),
    speak({ query: "lamp", source: "cpsc", total: 1, recalls: [lamp] }),
    speak({ query: "lamp", source: "cpsc", total: 2, recalls: [lamp, recall({ id: "L-2" })] }),
    speakMany([{ query: "lamp", source: "cpsc", total: 0, recalls: [] }], ["cpsc", "fda-food"]),
    speakMany([{ query: "lamp", source: "cpsc", total: 2, recalls: [lamp, recall({ id: "L-2" })] }]),
    speakWatch({ totalItems: 1, newItems: 1, failedItems: 0, recall: lamp, newRecallCount: 1 }),
    speakWatch({ totalItems: 3, newItems: 1, failedItems: 1, recall: lamp, newRecallCount: 3, label: "lamp" }),
    speakWatch({ totalItems: 3, newItems: 0, failedItems: 1, newRecallCount: 0, emptyLabels: ["crib"] }),
    ...followUps([lamp, food]),
  ];
  for (const out of outputs) {
    assert.ok(!out.includes("  "), `double space in ${JSON.stringify(out)}`);
    assert.equal(out, out.trim(), `stray edge space in ${JSON.stringify(out)}`);
  }
});

test("speak: drug recalls end with the pharmacist sentence", () => {
  const r = recall({
    source: "fda-drug",
    date: "2023-03-05",
    title: "Metformin",
    hazard: "The tablets may contain a harmful impurity.",
    remedy: "Contact your pharmacy.",
  });
  assert.equal(
    speak({ query: "metformin", source: "fda-drug", total: 1, recalls: [r] }),
    "I found 1 recall that mentions metformin. The newest is from March 2023. It is Metformin. The tablets may contain a harmful impurity. Contact your pharmacy. Ask a pharmacist before you stop taking a medicine.",
  );
});

// ---- ALL CAPS hazard is lowered ----

test("speak: ALL CAPS hazard is read as lowercase", () => {
  const r = recall({
    title: "Widget",
    hazard: "THIS PRODUCT MAY CAUSE SERIOUS INJURY.",
    remedy: "Stop using it.",
  });
  assert.equal(
    speak({ query: "widget", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions widget. The newest is from January 2023. It is Widget. this product may cause serious injury. Stop using it.",
  );
});

// ---- long sentences cut at a comma / because / posing ----

test("speak: long sentence cut at the last comma inside the word limit", () => {
  const r = recall({
    title: "Toy",
    hazard: "The product can overheat during normal use and the battery may leak or swell, creating a risk of fire and burns to consumers who may be injured by the hot surface or leaking chemicals.",
    remedy: "Stop using the toy.",
  });
  assert.equal(
    speak({ query: "toy", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions toy. The newest is from January 2023. It is Toy. The product can overheat during normal use and the battery may leak or swell. Stop using the toy.",
  );
});

test("speak: long sentence cut at 'because'", () => {
  const r = recall({
    title: "Toy",
    hazard: "The product can break apart and injure a child because the mounting bracket can loosen over time when the unit is bumped or moved during regular cleaning and everyday use.",
    remedy: "Stop using the toy.",
  });
  assert.equal(
    speak({ query: "toy", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions toy. The newest is from January 2023. It is Toy. The product can break apart and injure a child. Stop using the toy.",
  );
});

test("speak: long sentence cut at ', posing'", () => {
  const r = recall({
    title: "Toy",
    hazard: "The product can overheat and catch fire, posing a risk of burns to consumers who touch the unit while it is in use.",
    remedy: "Stop using the toy.",
  });
  assert.equal(
    speak({ query: "toy", source: "cpsc", total: 1, recalls: [r] }),
    "I found 1 recall that mentions toy. The newest is from January 2023. It is Toy. The product can overheat and catch fire. Stop using the toy.",
  );
});

// ---- 70-word budget: remedy dropped first ----

test("speak: answer over 70 words drops the remedy first and stays within budget", () => {
  const r = recall({
    source: "fda-drug",
    title: "Widget Pain Relief Extra Strength Tablets",
    hazard: "The widget zebra part can fail suddenly without warning and cause a loud bang that scares users and may damage the surrounding area during normal everyday use of the product at home or at work in many cases around the world.",
    remedy: "The kangaroo company will provide a free replacement unit to all affected consumers who contact the support line and request a return authorization before the deadline passes this year or the next.",
  });
  const out = speak({ query: "widget", source: "fda-drug", total: 1, recalls: [r] });
  assert.ok(wordCount(out) <= 70, `answer has ${wordCount(out)} words: ${out}`);
  assert.ok(out.includes("zebra"), "hazard kept");
  assert.ok(!out.includes("kangaroo"), "remedy dropped first");
  assert.ok(out.endsWith("."));
});

// ---- spokenTitle transforms per source ----

test("spokenTitle: NHTSA component colon title becomes 'the air bags'", () => {
  assert.equal(
    spokenTitle(recall({ source: "nhtsa", title: "AIR BAGS:SENSOR:OCCUPANT CLASSIFICATION SYSTEM" })),
    "the air bags",
  );
});

test("spokenTitle: CPSC 'Firm Recalls Product Due to...' becomes 'Product from Firm'", () => {
  assert.equal(
    spokenTitle(recall({ source: "cpsc", title: "Firm Recalls Product Due to Fall Hazard" })),
    "Product from Firm",
  );
});

test("spokenTitle: CPSC 'Product Recalled Due to...' becomes 'Product'", () => {
  assert.equal(
    spokenTitle(recall({ source: "cpsc", title: "Widget Recalled Due to Fire Hazard" })),
    "Widget",
  );
});

test("spokenTitle: FDA description drops UPC, NET WT and sizes", () => {
  assert.equal(
    spokenTitle(recall({ source: "fda-food", title: "Happy Baby Organics Puffs 2.1 oz NET WT 60 g UPC 890475002345" })),
    "Happy Baby Organics Puffs",
  );
});

// ---- leading list markers from agency text ----

test("speak: leading list markers are stripped from FDA and CPSC titles and descriptions", () => {
  const fda = recall({
    source: "fda-food",
    title: "1. ByHeart Whole Nutrition Infant Formula",
    hazard: "1) The product may contain undeclared milk.",
    remedy: "a.) Return it to the store.",
  });
  const fdaOut = speak({ query: "byheart formula", source: "fda-food", total: 1, recalls: [fda] });
  assert.ok(fdaOut.includes("It is ByHeart Whole Nutrition Infant Formula."), fdaOut);
  assert.ok(!fdaOut.includes("It is 1."), fdaOut);
  assert.ok(!fdaOut.includes("1)"), fdaOut);
  assert.ok(!fdaOut.includes("a.)"), fdaOut);

  const cpsc = recall({
    title: "- Graco Crib",
    hazard: "(a) The crib can collapse.",
    remedy: "- Contact Graco for a refund.",
  });
  const cpscOut = speak({ query: "graco crib", source: "cpsc", total: 1, recalls: [cpsc] });
  assert.ok(cpscOut.includes("It is Graco Crib."), cpscOut);
  assert.ok(!cpscOut.includes("(a)"), cpscOut);
  assert.ok(!cpscOut.includes("- Contact"), cpscOut);
});

test("speakWatch: reports the new count and says an unavailable source is not a no-recalls answer", () => {
  const r = recall({ date: "2023-01-15", title: "Widget", hazard: "May cause injury.", remedy: "Contact the manufacturer." });
  assert.equal(
    speakWatch({ totalItems: 4, newItems: 1, failedItems: 0, recall: r, newRecallCount: 1 }),
    "1 of your 4 items has a new recall since you last asked. The newest is from January 2023. It is Widget. May cause injury. Contact the manufacturer.",
  );
  const failed = speakWatch({ totalItems: 4, newItems: 0, failedItems: 2, newRecallCount: 0 });
  assert.ok(failed.includes("could not fully check 2 of your 4 items"), failed);
  assert.ok(!failed.toLowerCase().includes("no recalls"), failed);
});

test("speakWatch names the item the spoken recall belongs to", () => {
  const r = recall({ source: "fda-food", date: "2026-01-05", title: "ByHeart Whole Nutrition Infant Formula", hazard: "The product may contain botulism.", remedy: "" });
  const out = speakWatch({ totalItems: 1, newItems: 1, failedItems: 0, recall: r, newRecallCount: 1, query: "byheart formula", label: "ByHeart formula" });
  assert.match(out, /For your ByHeart formula, the newest is from January 2026\./);
  assert.ok(!out.includes("undefined"), out);
});

test("speakWatch with several new items says the count then names the most important item", () => {
  const r = recall({ source: "fda-food", date: "2026-01-05", title: "ByHeart Whole Nutrition Infant Formula", hazard: "The product may contain botulism.", remedy: "" });
  const out = speakWatch({ totalItems: 3, newItems: 2, failedItems: 0, recall: r, newRecallCount: 2, query: "byheart formula", label: "ByHeart formula" });
  assert.match(out, /^2 of your 3 items have a new recall since you last asked\./);
  assert.match(out, /For your ByHeart formula/);
});

test("speakWatch says first check when nothing was seen before", () => {
  const r = recall({ title: "Widget", hazard: "May cause injury.", remedy: "Contact the manufacturer." });
  const out = speakWatch({ totalItems: 2, newItems: 1, failedItems: 1, checkedItems: 1, recall: r, newRecallCount: 1, firstCheck: true });
  assert.match(out, /^On this first check, your item has a new recall\./);
  assert.match(out, /I could not fully check 1 of your 2 items/);
  assert.ok(!out.includes(".I could not"), out);
});

test("speakWatch counts only the items that were checked in its lead", () => {
  const r = recall({ title: "Widget", hazard: "May cause injury.", remedy: "Contact the manufacturer." });
  const out = speakWatch({ totalItems: 4, newItems: 2, failedItems: 2, checkedItems: 2, recall: r, newRecallCount: 2 });
  assert.match(out, /^2 of your 2 items have a new recall since you last asked\./);
  // The lead sentence counts the items that were checked. The total appears only in the unavailable sentence.
  const lead = out.slice(0, out.indexOf("I could not"));
  assert.ok(!lead.includes("2 of your 4 items"), out);
  assert.match(out, /I could not fully check 2 of your 4 items/);
});

test("speakWatch on a first check with zero results says no recalls found", () => {
  const out = speakWatch({ totalItems: 1, newItems: 0, failedItems: 0, newRecallCount: 0, firstCheck: true, emptyLabels: ["2019 Chevrolet Silverado 1500"] });
  assert.match(out, /^On this first check, none of your items has a recall\./);
  assert.match(out, /No recalls found for 2019 Chevrolet Silverado 1500\./);
});

test("speak: a remedy that repeats the hazard is said once", () => {
  const r = recall({ title: "Lamp", hazard: "Stop using the lamp.", remedy: "Stop using the lamp." });
  const out = speak({ query: "lamp", source: "cpsc", total: 1, recalls: [r] });
  assert.equal((out.match(/Stop using the lamp\./g) ?? []).length, 1, out);
});

test("speakMany: the more count is capped by the 4 follow ups that are really read", () => {
  const recalls = Array.from({ length: 15 }, (_, i) => recall({
    id: String(i),
    date: `2023-01-${String(15 - i).padStart(2, "0")}`,
    title: `Product ${i}`,
    hazard: "Hazard.",
    remedy: "Remedy.",
  }));
  const out = speakMany([{ query: "widgets", source: "cpsc", total: 12, recalls }]);
  assert.match(out, /Say "more" to hear the next 4\./);
  assert.ok(!out.includes("next 11"), out);
});

// ---- speakMany ----

test("speakMany: all empty returns combined no-recalls message", () => {
  assert.equal(
    speakMany([
      { query: "peanut butter", source: "cpsc", total: 0, recalls: [] },
      { query: "peanut butter", source: "fda-food", total: 0, recalls: [] },
      { query: "peanut butter", source: "fda-drug", total: 0, recalls: [] },
    ]),
    "I found no recalls for peanut butter in the product, food or drug recall lists. That does not prove it is safe, only that nothing is listed.",
  );
});

test("speakMany: empty input yields no recalls message", () => {
  assert.equal(
    speakMany([]),
    "I found no recalls in the product, food or drug recall lists. That does not prove it is safe, only that nothing is listed.",
  );
});

test("speakMany: reads the single newest recall across 3 sources", () => {
  const r1 = recall({ id: "f1", source: "fda-food", date: "2023-01-10", title: "Peanut Butter Jar", hazard: "May contain salmonella.", remedy: "Return it to the store." });
  const r2 = recall({ id: "p1", source: "cpsc", date: "2022-03-05", title: "Peanut Butter Maker", hazard: "May overheat.", remedy: "Unplug it." });
  const r3 = recall({ id: "d1", source: "fda-drug", date: "2022-11-20", title: "Peanut Allergy Drug", hazard: "May cause dizziness.", remedy: "Consult your doctor." });
  assert.equal(
    speakMany([
      { query: "peanut butter", source: "cpsc", total: 1, recalls: [r2] },
      { query: "peanut butter", source: "fda-food", total: 1, recalls: [r1] },
      { query: "peanut butter", source: "fda-drug", total: 1, recalls: [r3] },
    ]),
    'I found 3 recalls that mention peanut butter. The newest is from January 2023. It is Peanut Butter Jar. The FDA says the reason is May contain salmonella. Return it to the store. There are 2 more. Say "more" to hear the next 2.',
  );
});

test("speakMany: 'next N' is capped by the recalls held, not the total", () => {
  const r = recall({ id: "A", date: "2023-01-15", title: "Widget A", hazard: "Risk one.", remedy: "Fix one." });
  const out = speakMany([
    { query: "widgets", source: "cpsc", total: 300, recalls: [r, r, r, r, r] },
  ]);
  assert.equal(
    out,
    'I found 300 recalls that mention widgets. The newest is from January 2023. It is Widget A. Risk one. Fix one. There are 299 more. Say "more" to hear the next 4.',
  );
});

// ---- property test: random long recalls always fit the budget ----

test("property: 200 random recalls always stay within 70 words and end with a period", () => {
  const rand = mulberry32(20261017);
  const words = [
    "the", "a", "product", "may", "cause", "risk", "of", "burns", "injury", "child",
    "fire", "battery", "choking", "hazard", "small", "part", "fall", "broken", "sharp",
    "edge", "while", "use", "normal", "handle", "unit", "device", "because", "posing",
    "which", "and", "or", "contact", "return", "repair", "replace", "refund", "stop",
    "using", "immediately", "safety", "serious", "exposed", "contains", "defect", "recall",
  ];
  const titles = ["Widget", "Lamp", "Toy", "Blender", "Charger", "Heater", "Crib", "Stroller", "Battery Pack", "Food Mix"];
  const sources: Source[] = ["nhtsa", "cpsc", "fda-food", "fda-drug"];

  function pick<T>(arr: T[]): T {
    return arr[Math.floor(rand() * arr.length)] as T;
  }
  function text(max: number): string {
    const n = 1 + Math.floor(rand() * max);
    return Array.from({ length: n }, () => pick(words)).join(" ") + (rand() < 0.5 ? "." : "");
  }

  for (let i = 0; i < 200; i++) {
    const source = pick(sources);
    const r = recall({
      source,
      date: `${2020 + Math.floor(rand() * 6)}-${1 + Math.floor(rand() * 12)}-${1 + Math.floor(rand() * 28)}`,
      title: pick(titles),
      hazard: text(45),
      remedy: text(35),
      severity: rand() < 0.2 ? "high" : undefined,
    });
    const out = speak({ query: "test", source, total: 1, recalls: [r] });
    const wc = wordCount(out);
    assert.ok(wc <= 70, `#${i} answer has ${wc} words: ${out}`);
    assert.ok(/[."]$/.test(out), `#${i} answer does not end with a period: ${out}`);
  }
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("result helper sanity", () => {
  assert.equal(result({}).total, 1);
});
