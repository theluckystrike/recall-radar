import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CARD_MIME, CARD_URI, cardDocument, escapeHtml, renderRecallCard, sourceLabel } from "../src/card.js";
import { createServer, itemSearch } from "../src/server.js";
import { speak } from "../src/speech.js";
import { searchFood } from "../src/sources/fda.js";
import type { Recall } from "../src/types.js";

type JsonMessage = { id?: number; method?: string; result?: unknown; error?: unknown; params?: unknown };

const HOSTILE: Recall = {
  source: "cpsc",
  id: "R-9",
  date: "2026-05-02",
  title: '<script>alert("pwn")</script>',
  hazard: 'May break and cut, "sharp" edges',
  remedy: "Contact the maker's support",
  url: "javascript:alert(1)",
  severity: "high",
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

/** A tiny raw MCP client over a linked in-memory transport, with the legacy handshake. */
async function mcpClient(server: ReturnType<typeof createServer>) {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: JsonMessage) => void>();
  (client as unknown as { onmessage: (message: JsonMessage) => void }).onmessage = (message) => {
    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  };
  await server.connect(serverSide);
  let nextId = 0;
  const request = async (method: string, params: unknown = {}): Promise<JsonMessage> => {
    const id = ++nextId;
    const reply = new Promise<JsonMessage>((resolve) => pending.set(id, resolve));
    await client.send({ jsonrpc: "2.0", id, method, params } as never);
    return reply;
  };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
  return { request, close: () => server.close() };
}

test("escapeHtml neutralises markup and quotes", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
});

test("a recall title with script tags and quotes is escaped in the card", () => {
  const html = renderRecallCard(HOSTILE);
  assert.ok(!html.includes("<script>"), "raw script tag must not survive");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("May break and cut, &quot;sharp&quot; edges"));
  assert.ok(html.includes("Contact the maker&#39;s support"));
  assert.ok(!html.includes("javascript:"), "a javascript URL must not become a link");
  assert.ok(!html.includes("href="), "no link is emitted for a non http URL");
});

test("source and severity labels are the plain words a screen shows", () => {
  assert.equal(sourceLabel("nhtsa"), "NHTSA");
  assert.equal(sourceLabel("cpsc"), "CPSC");
  assert.equal(sourceLabel("fda-food"), "FDA");
  assert.equal(sourceLabel("fda-drug"), "FDA");
  assert.match(renderRecallCard({ ...HOSTILE, severity: "low" }), />Low severity</);
  assert.match(renderRecallCard({ ...HOSTILE, severity: undefined }), />Severity not stated</);
});

test("a CPSC card treats a death or fatal mention as high severity", () => {
  assert.match(renderRecallCard({ ...HOSTILE, severity: undefined, hazard: "The crib can cause death." }), />High severity</);
  assert.match(renderRecallCard({ ...HOSTILE, severity: undefined, title: "A child died after a fall", hazard: "Fall risk." }), />High severity</);
  assert.match(renderRecallCard({ ...HOSTILE, severity: undefined, hazard: "A fatal collapse risk." }), />High severity</);
  assert.match(renderRecallCard({ ...HOSTILE, severity: undefined, hazard: "A fire risk." }), />Severity not stated</);
});

test("the card document is self contained and carries inline CSS only", () => {
  const html = cardDocument();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  assert.ok(!/<link\b/.test(html), "no external stylesheet");
  assert.ok(!/<script[^>]*\bsrc=/.test(html), "no script loaded from the network");
  assert.ok(!/@import/.test(html), "no imported font");
  assert.ok(!/https?:\/\//.test(html), "no network resource is referenced");
  assert.match(html, /Checking the newest recall\./);
  const rendered = cardDocument(HOSTILE);
  assert.ok(rendered.includes("&lt;script&gt;"), "a server rendered card escapes its data");
});

test("an http recall link is kept and escaped", () => {
  const html = renderRecallCard({ ...HOSTILE, url: 'https://example.com/a?x=1&y="2"' });
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=&quot;2&quot;"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("resources/list lists the card with the mcp-app media type", async () => {
  const client = await mcpClient(createServer({}));
  try {
    const reply = await client.request("resources/list");
    const resources = (reply.result as { resources: Array<{ uri: string; name: string; mimeType?: string; title?: string }> }).resources;
    const card = resources.find((resource) => resource.uri === CARD_URI);
    assert.ok(card, "the card resource must be listed");
    assert.equal(card.mimeType, CARD_MIME);
    assert.equal(card.mimeType, "text/html;profile=mcp-app");
    assert.ok(card.title);

    const read = await client.request("resources/read", { uri: CARD_URI });
    const contents = (read.result as { contents: Array<{ uri: string; mimeType: string; text: string }> }).contents;
    assert.equal(contents[0]?.uri, CARD_URI);
    assert.equal(contents[0]?.mimeType, CARD_MIME);
    assert.match(contents[0]?.text ?? "", /<article class="rr-card">|Checking the newest recall\./);
  } finally {
    await client.close();
  }
});

test("tools/list carries the UI link on the search tools and the watch check", async () => {
  const client = await mcpClient(createServer({}));
  try {
    const reply = await client.request("tools/list");
    const tools = (reply.result as { tools: Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }> }).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["check_vehicle_recalls", "search_product_recalls", "search_food_recalls", "search_drug_recalls", "check_all_recalls", "check_my_watch_list"]) {
      assert.equal(byName.get(name)?._meta?.ui?.resourceUri, CARD_URI, name);
    }
    for (const name of ["add_to_watch_list", "remove_from_watch_list"]) {
      assert.equal(byName.get(name)?._meta?.ui?.resourceUri, undefined, name);
    }
  } finally {
    await client.close();
  }
});

test("the spoken text answer is unchanged and the newest recall rides in structuredContent", async () => {
  const original = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (async () => ({
    status: 200,
    ok: true,
    json: async () => loadFixture("fda-food.json"),
  })) as unknown as typeof fetch;
  try {
    const expected = await itemSearch(searchFood, "peanut butter");
    const server = createServer({});
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }> }> })._registeredTools;
    const result = await tools["search_food_recalls"]!.handler({ query: "peanut butter" }, {});
    assert.equal(result.content?.[0]?.text, speak(expected));
    const newest = expected.recalls[0];
    assert.equal((result.structuredContent?.recall as Recall | undefined)?.id, newest?.id);
    assert.equal((result.structuredContent?.recalls as Recall[])[0]?.id, newest?.id);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
  }
});
