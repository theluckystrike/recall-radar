import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMake, normalizeModel, route } from "../src/router.js";

// Safety rule under test: no utterance may be routed to a source that cannot hold its recall.
// check_all_recalls (CPSC + FDA food + FDA drug) is the safe default for anything that is not clearly a vehicle, food or medicine.
const cases: Array<[string, string, Record<string, unknown> | null]> = [
  ["is my 2018 honda accord recalled", "check_vehicle_recalls", { year: 2018, make: "honda", model: "accord" }],
  ["did they recall the 2018 honda accord", "check_vehicle_recalls", { year: 2018, make: "honda", model: "accord" }],
  ["is my twenty eighteen honda accord recalled", "check_vehicle_recalls", { year: 2018, make: "honda", model: "accord" }],
  ["is my two thousand and nine toyota camry recalled", "check_vehicle_recalls", { year: 2009, make: "toyota", model: "camry" }],
  ["is my 2018 accord recalled", "check_vehicle_recalls", { year: 2018, make: "honda", model: "accord" }],
  ["is my honda accord recalled", "ask_vehicle", { make: "honda", model: "accord", missing: "year" }],
  ["is my ford recalled", "ask_vehicle", { make: "ford", model: "", missing: "model" }],
  ["is my car recalled", "ask_vehicle", { make: "", model: "", missing: "vehicle" }],
  ["is my truck recalled", "ask_vehicle", { make: "", model: "", missing: "vehicle" }],
  ["are there recalls on my van", "ask_vehicle", { make: "", model: "", missing: "vehicle" }],
  ["is there a recall on my 2020 tesla model 3", "check_vehicle_recalls", { year: 2020, make: "tesla", model: "model 3" }],
  ["any recalls on my 2021 ram 1500", "check_vehicle_recalls", { year: 2021, make: "ram", model: "1500" }],
  ["check my 2019 mazda 3", "check_vehicle_recalls", { year: 2019, make: "mazda", model: "3" }],
  ["is my 2018 bmw 3 series recalled", "check_vehicle_recalls", { year: 2018, make: "bmw", model: "3 series" }],
  ["is my 2019 mercedes benz c300 recalled", "check_vehicle_recalls", { year: 2019, make: "mercedes-benz", model: "c300" }],
  ["is my 2019 mercedes-benz c300 recalled", "check_vehicle_recalls", { year: 2019, make: "mercedes-benz", model: "c300" }],
  ["any recalls on my 2016 land rover range rover", "check_vehicle_recalls", { year: 2016, make: "land rover", model: "range rover" }],
  ["is my 2017 chevy silverado recalled", "check_vehicle_recalls", { year: 2017, make: "chevrolet", model: "silverado 1500" }],
  ["is my 2016 vw jetta recalled", "check_vehicle_recalls", { year: 2016, make: "volkswagen", model: "jetta" }],
  ["any recalls on my 2021 ford f150", "check_vehicle_recalls", { year: 2021, make: "ford", model: "f-150" }],
  ["any recalls on my 2021 ford f 150", "check_vehicle_recalls", { year: 2021, make: "ford", model: "f-150" }],
  ["is my 2019 toyota rav 4 recalled", "check_vehicle_recalls", { year: 2019, make: "toyota", model: "rav4" }],
  ["is my 2020 honda cr-v recalled", "check_vehicle_recalls", { year: 2020, make: "honda", model: "cr-v" }],
  ["is my 2018 honda accord's airbag recalled", "check_vehicle_recalls", { year: 2018, make: "honda", model: "accord" }],
  ["is there a recall on the hyundai elantra 2017", "check_vehicle_recalls", { year: 2017, make: "hyundai", model: "elantra" }],
  ["is there a recall on cucumbers", "search_food_recalls", { query: "cucumbers" }],
  ["is there a recall on baby formula", "search_food_recalls", { query: "infant formula" }],
  ["any recalls on hot dogs", "search_food_recalls", { query: "hot dog" }],
  ["is boar's head liverwurst recalled", "search_food_recalls", { query: "boar head liverwurst" }],
  ["any recalls on dog food", "search_food_recalls", { query: "dog food" }],
  ["any recalls on peanut butter", "search_food_recalls", { query: "peanut butter" }],
  ["any recalls on eye drops", "search_drug_recalls", { query: "eye drops" }],
  ["is my hand sanitizer recalled", "search_drug_recalls", { query: "hand sanitizer" }],
  ["was my children's cough syrup recalled", "search_drug_recalls", { query: "cough syrup" }],
  ["was ozempic recalled", "search_drug_recalls", { query: "ozempic" }],
  ["was my ibuprofen recalled", "search_drug_recalls", { query: "ibuprofen" }],
  ["is the graco pack and play recalled", "check_all_recalls", { query: "graco pack and play" }],
  ["is my apple watch recalled", "check_all_recalls", { query: "apple watch" }],
  ["is my rice cooker recalled", "check_all_recalls", { query: "rice cooker" }],
  ["is my coffee maker recalled", "check_all_recalls", { query: "coffee maker" }],
  ["is the ikea malm dresser recalled", "check_all_recalls", { query: "ikea malm dresser" }],
  ["is the 2000 watt space heater recalled", "check_all_recalls", { query: "2000 watt space heater" }],
  ["check my peloton tread", "check_all_recalls", { query: "peloton tread" }],
  ["more", "more", {}],
  ["tell me more", "more", {}],
  ["what about the next one", "more", {}],
];

test("routes realistic spoken questions to a source that can hold the recall", () => {
  for (const [utterance, tool, args] of cases) {
    const got = route(utterance);
    assert.ok(got, `no route for ${JSON.stringify(utterance)}`);
    assert.equal(got.tool, tool, utterance);
    assert.deepEqual(got.args, args, utterance);
  }
});

test("routes watch list phrases to the watch list tools", () => {
  const watchCases: Array<[string, string, Record<string, unknown>]> = [
    ["add my 2018 honda accord to my watch list", "add_to_watch_list", { year: 2018, make: "honda", model: "accord" }],
    ["watch the ikea malm dresser", "add_to_watch_list", { item: "ikea malm dresser" }],
    ["add the crib to my watch list", "add_to_watch_list", { item: "crib" }],
    ["put my 2018 honda accord on my watch list", "add_to_watch_list", { year: 2018, make: "honda", model: "accord" }],
    ["check my watch list", "check_my_watch_list", {}],
    ["anything new on my list", "check_my_watch_list", {}],
    ["what is new on my watch list", "check_my_watch_list", {}],
    ["remove the crib from my list", "remove_from_watch_list", { item: "crib" }],
    ["remove my 2018 honda accord from my watch list", "remove_from_watch_list", { item: "2018 honda accord" }],
  ];
  for (const [utterance, tool, args] of watchCases) {
    const got = route(utterance);
    assert.ok(got, `no route for ${JSON.stringify(utterance)}`);
    assert.equal(got.tool, tool, utterance);
    assert.deepEqual(got.args, args, utterance);
  }
});

test("returns null for nothing to search", () => {
  for (const u of ["", "   ", "any recalls", "is it recalled", "?!"]) assert.equal(route(u), null, JSON.stringify(u));
});

test("never routes a food or a medicine to the product-only tool", () => {
  for (const u of ["spinach", "frozen vegetables", "similac", "tylenol", "sunscreen", "deli meat", "alfalfa sprouts"]) {
    assert.notEqual(route(`any recalls on ${u}`)?.tool, "search_product_recalls", u);
  }
});

test("a vehicle kind word next to a product word stays a product search", () => {
  assert.equal(route("is my car seat recalled")?.tool, "check_all_recalls");
  assert.deepEqual(route("is my car seat recalled")?.args, { query: "car seat" });
});

test("an ambiguous vehicle noun alone stays a product search", () => {
  for (const noun of ["wagon", "pickup", "convertible"]) {
    const got = route(`is my ${noun} recalled`);
    assert.ok(got, noun);
    assert.equal(got.tool, "check_all_recalls", noun);
    assert.deepEqual(got.args, { query: noun }, noun);
  }
});

test("a synonym phrase mixed with another script is refused, never thrown", () => {
  assert.doesNotThrow(() => route("baby formula 日本"));
  const got = route("baby formula 日本");
  if (!got || got.tool !== "refuse") assert.fail("expected a refusal route");
  assert.match(got.args.message, /English letters/);
});

test("caps long input and survives hostile text", () => {
  assert.doesNotThrow(() => route("x".repeat(10_000)));
  assert.doesNotThrow(() => route("<script>alert(1)</script> recall"));
  assert.equal(route("is my 1949 ford model a recalled")?.tool, "ask_vehicle");
});

test("never mind cancels instead of searching", () => {
  for (const u of ["never mind", "nevermind", "cancel", "forget it"]) assert.equal(route(u), null, u);
});

test("accents are stripped on the search and watch list paths", () => {
  assert.deepEqual(route("is there a recall on jalapeño peppers")?.args, { query: "jalapeno peppers" });
  assert.deepEqual(route("add jalapeño peppers to my watch list")?.args, { item: "jalapeno peppers" });
  assert.deepEqual(route("watch crème brûlée")?.args, { item: "creme brulee" });
});

test("a generic synonym keeps the brand words the person said", () => {
  assert.deepEqual(route("is my ByHeart formula recalled")?.args, { query: "byheart formula" });
  assert.deepEqual(route("is my Similac baby formula safe")?.args, { query: "similac infant formula" });
  assert.deepEqual(route("is there a recall on baby formula")?.args, { query: "infant formula" });
});

test("vehicle aliases are reused by the server", () => {
  assert.equal(normalizeMake("Chevy"), "chevrolet");
  assert.equal(normalizeMake("Mercedes-Benz"), "mercedes-benz");
  assert.equal(normalizeModel("f150"), "f-150");
  assert.equal(normalizeModel("Silverado"), "silverado 1500");
});
