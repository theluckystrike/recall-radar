import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("README and simulator show Built with Llama", () => {
  assert.match(read("README.md"), /Built with Llama/);
  assert.match(read("web/index.html"), /Built with Llama/);
});

test("README documents the run steps and the watch list tools", () => {
  const readme = read("README.md");
  for (const text of ["wrangler login", "kv namespace create", "wrangler.jsonc", "rule router", "add_to_watch_list", "remove_from_watch_list", "check_my_watch_list"]) {
    assert.ok(readme.includes(text), text);
  }
  assert.match(readme, /\b\d+ tests, no network/);
});

test("README matches the CPU limit and the response caps in the code", () => {
  const readme = read("README.md");
  assert.match(read("wrangler.jsonc"), /"cpu_ms":\s*300/);
  assert.match(readme, /300 ms CPU limit/);
  assert.match(readme, /at most 5 recalls/);
  assert.match(readme, /120 character title/);
  assert.match(readme, /300 character hazard and remedy/);
});

test("Agent Skill keeps the 70 word, four at a time and pharmacist rules", () => {
  const skill = read("skills/recall-radar/SKILL.md");
  assert.ok(skill.includes("about 70 words"));
  assert.ok(skill.includes("four at a time"));
  assert.ok(!skill.includes("For medicine, add the line"));
});
