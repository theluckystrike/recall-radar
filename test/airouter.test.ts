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

test("model output is validated strictly", () => {
  assert.equal(validate({ tool: "check_vehicle_recalls", args: { year: 1800, make: "ford", model: "t" } }), null);
  assert.equal(validate({ tool: "delete_everything", args: {} }), null);
  assert.equal(validate({ tool: "search_food_recalls", args: { query: "x".repeat(200) } }), null);
  assert.deepEqual(validate({ tool: "search_food_recalls", args: { query: "Peanut Butter" } }), { tool: "search_food_recalls", args: { query: "peanut butter" } });
});
