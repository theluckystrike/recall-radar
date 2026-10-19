import test from "node:test";
import assert from "node:assert/strict";
import { aiRoute, validate } from "../src/airouter.js";

const noModel = {}; // no AI binding: the rules fallback answers, as when the daily cap is reached

test("X2: an unrelated question after a pending car question is routed on its own", async () => {
  const { route, by } = await aiRoute(noModel, "is the 2019 graco stroller recalled", { make: "honda", model: "accord" });
  assert.equal(by, "rules");
  assert.equal(route?.tool, "check_all_recalls");
  assert.deepEqual(route?.args, { query: "2019 graco stroller" });
});

test("X2: a bare year completes the pending car question", async () => {
  const { route } = await aiRoute(noModel, "2018", { make: "honda", model: "accord" });
  assert.deepEqual(route, { tool: "check_vehicle_recalls", args: { year: 2018, make: "honda", model: "accord" } });
});

test("X2: never mind cancels a pending question", async () => {
  const { route } = await aiRoute(noModel, "never mind", { make: "ford", model: "" });
  assert.equal(route, null);
});

test("a bare model answers a pending 'which model' question", async () => {
  const { route } = await aiRoute(noModel, "f150", { make: "ford", model: "" });
  assert.equal(route?.tool, "ask_vehicle");
  assert.deepEqual(route?.args, { make: "ford", model: "f-150", missing: "year" });
});

test("a vehicle kind with no make or model asks for the year, make and model", async () => {
  assert.deepEqual(validate({ tool: "ask_vehicle", args: { make: "", model: "", missing: "vehicle" } }), {
    tool: "ask_vehicle",
    args: { make: "", model: "", missing: "vehicle" },
  });
  const { route, by } = await aiRoute(noModel, "is my truck recalled", null);
  assert.equal(by, "rules");
  assert.deepEqual(route, { tool: "ask_vehicle", args: { make: "", model: "", missing: "vehicle" } });
});

test("a bare year with an empty pending vehicle asks for the vehicle again", async () => {
  const { route, by } = await aiRoute(noModel, "2018", { make: "", model: "" });
  assert.equal(by, "rules");
  assert.deepEqual(route, { tool: "ask_vehicle", args: { make: "", model: "", missing: "vehicle" } });
});

test("a bare model with an empty pending vehicle asks for the vehicle again", async () => {
  const { route, by } = await aiRoute(noModel, "Camry", { make: "", model: "" });
  assert.equal(by, "rules");
  assert.deepEqual(route, { tool: "ask_vehicle", args: { make: "", model: "", missing: "vehicle" } });
});

test("a full vehicle answer completes an empty pending vehicle", async () => {
  const { route } = await aiRoute(noModel, "2018 honda accord", { make: "", model: "" });
  assert.deepEqual(route, { tool: "check_vehicle_recalls", args: { year: 2018, make: "honda", model: "accord" } });
});

test("a synonym phrase mixed with another script is refused, never thrown", async () => {
  const { route, by } = await aiRoute(noModel, "baby formula 日本", null);
  assert.equal(by, "rules");
  if (!route || route.tool !== "refuse") assert.fail("expected a refusal route");
  assert.match(route.args.message, /English letters/);
});

test("model output is validated strictly", () => {
  assert.equal(validate({ tool: "check_vehicle_recalls", args: { year: 1800, make: "ford", model: "t" } }), null);
  assert.equal(validate({ tool: "delete_everything", args: {} }), null);
  assert.equal(validate({ tool: "search_food_recalls", args: { query: "x".repeat(200) } }), null);
  assert.deepEqual(validate({ tool: "search_food_recalls", args: { query: "Peanut Butter" } }), { tool: "search_food_recalls", args: { query: "peanut butter" } });
});

test("watch list model output is validated and the rules fallback routes watch phrases", async () => {
  assert.deepEqual(validate({ tool: "add_to_watch_list", args: { year: 2018, make: "Honda", model: "Accord" } }), { tool: "add_to_watch_list", args: { year: 2018, make: "honda", model: "accord" } });
  assert.deepEqual(validate({ tool: "add_to_watch_list", args: { item: "IKEA MALM Dresser" } }), { tool: "add_to_watch_list", args: { item: "ikea malm dresser" } });
  assert.deepEqual(validate({ tool: "remove_from_watch_list", args: { item: "Crib" } }), { tool: "remove_from_watch_list", args: { item: "crib" } });
  assert.deepEqual(validate({ tool: "check_my_watch_list", args: {} }), { tool: "check_my_watch_list", args: {} });
  assert.equal(validate({ tool: "add_to_watch_list", args: { year: 1800, make: "ford", model: "t" } }), null);
  const { route, by } = await aiRoute(noModel, "add my 2018 honda accord to my watch list", null);
  assert.equal(by, "rules");
  assert.deepEqual(route, { tool: "add_to_watch_list", args: { year: 2018, make: "honda", model: "accord" } });
});
