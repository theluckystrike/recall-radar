import { createMcpHandler } from "@modelcontextprotocol/server";

import { aiRoute, type AiEnv, type Pending } from "./airouter.js";
import { NAME, VERSION, createServer, type WatchEnv } from "./server.js";
import { WatchListDO } from "./watchdo.js";

// Wrangler needs the Durable Object class exported from the entry module.
export { WatchListDO };

interface Env extends AiEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  WATCH?: WatchEnv["WATCH"];
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, mcp-method, mcp-name, x-user-id, x-alexa-user-id, x-amazon-user-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

/** The simulator sends x-user-id. Alexa clients may send an Alexa user id header instead. */
function userIdFrom(request: Request | undefined): string | null {
  if (!request) return null;
  const header = request.headers.get("x-user-id") ?? request.headers.get("x-alexa-user-id") ?? request.headers.get("x-amazon-user-id") ?? request.headers.get("mcp-session-id");
  if (header) return header.slice(0, 200);
  return new URL(request.url).searchParams.get("user_id");
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Use POST.", { status: 405 });
  let utterance = "";
  let pending: Pending | null = null;
  try {
    const body = (await request.json()) as { utterance?: unknown; pending?: { make?: unknown; model?: unknown } };
    utterance = typeof body.utterance === "string" ? body.utterance.slice(0, 200) : "";
    const p = body.pending;
    if (p && typeof p.make === "string") pending = { make: p.make.slice(0, 30), model: typeof p.model === "string" ? p.model.slice(0, 40) : "" };
  } catch {
    return Response.json({ error: "Send JSON: {\"utterance\": \"...\"}" }, { status: 400 });
  }
  const { route: call, by } = await aiRoute(env, utterance, pending);
  return call ? Response.json({ ...call, by }) : Response.json({ error: "I did not understand. Try: is my 2018 Honda Accord recalled?", by }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const mcp = createMcpHandler((ctx) => createServer({ env, userId: userIdFrom(ctx.requestInfo ?? request) }));
      return withCors(await mcp.fetch(request));
    }
    if (pathname === "/route") return handleRoute(request, env);
    if (pathname === "/health") return Response.json({ name: NAME, version: VERSION, ok: true });
    return env.ASSETS.fetch(request);
  },
};
