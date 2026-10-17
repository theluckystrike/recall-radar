// Live end-to-end MCP check over Streamable HTTP (2025-11-25 handshake), as Alexa+ or any MCP client would call it.
const base = process.argv[2] ?? "http://127.0.0.1:8791";
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function rpc(body, extra = {}) {
  const t = Date.now();
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(body) });
  const text = await r.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5));
  return { ms: Date.now() - t, status: r.status, json, session: r.headers.get("mcp-session-id") };
}
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "live-check", version: "1" } } });
console.log("initialize", init.status, init.ms + "ms", init.json.result?.protocolVersion, init.json.result?.serverInfo?.name);
const extra = init.session ? { "mcp-session-id": init.session, "mcp-protocol-version": "2025-11-25" } : { "mcp-protocol-version": "2025-11-25" };
await fetch(`${base}/mcp`, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, extra);
console.log("tools/list", list.status, list.ms + "ms", (list.json.result?.tools ?? []).map((t) => t.name).join(", "));
const calls = [
  ["check_vehicle_recalls", { year: 2018, make: "Honda", model: "Accord" }],
  ["search_product_recalls", { query: "crib" }],
  ["search_food_recalls", { query: "peanut butter" }],
  ["search_drug_recalls", { query: "ibuprofen" }],
  ["search_food_recalls", { query: "zzqxv unicorn" }],
  ["check_all_recalls", { query: "stroller" }],
];
let id = 3;
for (const [name, args] of calls) {
  const r = await rpc({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, extra);
  const res = r.json.result ?? {};
  console.log(`\n${name} ${JSON.stringify(args)} -> ${r.status} ${r.ms}ms isError=${!!res.isError}\n  "${res.content?.[0]?.text}"`);
}
