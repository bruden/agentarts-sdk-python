// End-to-end tests for the AgentArts Memory MCP server.
//
// Spawns dist/index.mjs (the exact artifact an MCP host runs) against a mock
// AgentArts data plane, then asserts:
//   - MCP protocol behavior (initialize / tools/list / tools/call / errors)
//   - the exact REST wire format: paths, Bearer auth, request bodies —
//     the expected values mirror the Python SDK's data-plane branch
//     (agentarts/sdk/service/memory_service.py) and its normalization layer
//     (toolkit/plugins/memory/agentarts_client.py)
//
// No network access, no real credentials, no test dependencies (node:test).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const SPACE = "sp-test-123";
const API_KEY = "test-key-xyz";
const USER = "cc-user";
const BASE = `/v1/core/spaces/${SPACE}`;

// ── mock AgentArts data plane ─────────────────────────────────────────

let calls = [];

function mockHandler(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");

    if (req.method === "POST" && req.url === `${BASE}/memories/search`) {
      const q = JSON.parse(body).query;
      if (q === "boom") {
        res.statusCode = 500;
        res.end(JSON.stringify({ error_code: "InternalError", error_msg: "backend exploded" }));
      } else if (q === "summary please") {
        res.end(JSON.stringify({ records: [{ record: { content: "an episodic note", strategy_type: "episodic" }, score: 0.9 }] }));
      } else if (q === "only semantic") {
        res.end(JSON.stringify({ records: [{ record: { content: "a semantic fact", strategy_type: "semantic" }, score: 0.95 }] }));
      } else {
        res.end(JSON.stringify({ records: [{ record: { content: "found it", strategy_type: "semantic" }, score: 0.88 }], total: 1 }));
      }
      return;
    }
    if (req.method === "GET" && req.url.startsWith(`${BASE}/memories`)) {
      res.end(JSON.stringify({
        items: [
          { id: "mem-1", content: "semantic item", strategy_type: "semantic", created_at: "2026-01-01T00:00:00Z" },
          { id: "mem-2", content: "preference item", memory_type: "user_preference", created_at: "2026-01-02T00:00:00Z" },
        ],
        total: 2,
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error_code: "NotFound", error_msg: `unexpected path ${req.url}` }));
  });
}

// ── MCP server harness ────────────────────────────────────────────────

function startMcp(env) {
  const child = spawn("node", ["dist/index.mjs"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ...env },
  });
  let nextId = 1;
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) => {
    const id = nextId++;
    const p = Promise.race([
      new Promise((resolve) => pending.set(id, resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no response to ${method} #${id}`)), 5000)),
    ]);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  const callTool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return JSON.parse(r.result.content[0].text);
  };
  return {
    child,
    rpc,
    callTool,
    kill: () => child.kill(),
  };
}

// ── tests ─────────────────────────────────────────────────────────────

describe("agentarts-memory MCP server (with credentials)", () => {
  let httpServer, mcp;

  before(async () => {
    httpServer = createServer(mockHandler);
    await once(httpServer.listen(0, "127.0.0.1"), "listening");
    mcp = startMcp({
      AGENTARTS_MEMORY_DATA_ENDPOINT: `http://127.0.0.1:${httpServer.address().port}`,
      HUAWEICLOUD_SDK_MEMORY_API_KEY: API_KEY,
      AGENTARTS_MEMORY_SPACE_ID: SPACE,
      AGENTARTS_MEMORY_USER_ID: USER,
    });
    const init = await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "agentarts-memory");
    mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  after(() => {
    mcp.kill();
    httpServer.close();
  });

  test("initialize handshake reports server identity", async () => {
    const r = await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(r.result.serverInfo.name, "agentarts-memory");
    assert.equal(r.result.serverInfo.version, "1.0.0");
    assert.ok(r.result.capabilities.tools);
  });

  test("tools/list: exactly the three read-only tools", async () => {
    const r = await mcp.rpc("tools/list");
    const tools = r.result.tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["list_memories", "search_memories", "search_summary"],
    );
    // query is required; num/threshold have defaults and stay optional.
    assert.deepEqual(tools.find((t) => t.name === "search_memories").inputSchema.required, ["query"]);
    const props = tools.find((t) => t.name === "search_memories").inputSchema.properties;
    assert.deepEqual(Object.keys(props).sort(), ["num", "query", "threshold"]);
  });

  test("search_memories: REST wire format (path, bearer auth, body defaults)", async () => {
    const out = await mcp.callTool("search_memories", { query: "hello world" });
    const call = calls.find((c) => c.url === `${BASE}/memories/search` && c.body.query === "hello world");
    assert.ok(call, "search endpoint was called");
    assert.equal(call.auth, `Bearer ${API_KEY}`);
    // Defaults mirror the Python server: num=5, threshold=0.7, actor_id from env.
    assert.deepEqual(call.body, { query: "hello world", top_k: 5, min_score: 0.7, actor_id: USER });
    // Normalized result: {content, score, type} from records[].record/score.
    assert.deepEqual(out.results, [{ content: "found it", score: 0.88, type: "semantic" }]);
    assert.equal(out.total, 1);
    assert.equal(out.query, "hello world");
  });

  test("search_memories: custom num/threshold are forwarded", async () => {
    await mcp.callTool("search_memories", { query: "custom k", num: 12, threshold: 0.3 });
    const call = calls.find((c) => c.body?.query === "custom k");
    assert.deepEqual(call.body, { query: "custom k", top_k: 12, min_score: 0.3, actor_id: USER });
  });

  test("list_memories: limit/offset in query string, items normalized", async () => {
    const out = await mcp.callTool("list_memories", { limit: 7, offset: 3 });
    const call = calls.find((c) => c.method === "GET" && c.url === `${BASE}/memories?limit=7&offset=3`);
    assert.ok(call, "list endpoint called with pagination");
    assert.equal(out.total, 2);
    assert.deepEqual(out.results[0], { id: "mem-1", content: "semantic item", type: "semantic", created_at: "2026-01-01T00:00:00Z" });
    // memory_type fallback when strategy_type is absent (Python client parity).
    assert.equal(out.results[1].type, "user_preference");
  });

  test("search_summary: returns summary-type hits directly", async () => {
    const out = await mcp.callTool("search_summary", { query: "summary please", num: 3 });
    // Python parity: search runs with top_k = max(num*3, 5).
    const call = calls.find((c) => c.body?.query === "summary please");
    assert.equal(call.body.top_k, 9);
    assert.deepEqual(out.results, [{ content: "an episodic note", score: 0.9, type: "episodic" }]);
  });

  test("search_summary: falls back to list when search has no summary-type hits", async () => {
    const out = await mcp.callTool("search_summary", { query: "only semantic", num: 3 });
    // Search returned only "semantic" -> fallback lists memories and filters
    // to summary types (mem-2, user_preference).
    assert.deepEqual(out.results, [
      { id: "mem-2", content: "preference item", type: "user_preference", created_at: "2026-01-02T00:00:00Z" },
    ]);
  });

  test("backend 5xx: tool returns an error payload, not a protocol error", async () => {
    const out = await mcp.callTool("search_memories", { query: "boom" });
    assert.match(out.error, /InternalError/);
    assert.match(out.error, /backend exploded/);
    assert.deepEqual(out.results, []);
    assert.equal(out.total, 0);
  });

  test("read-only: no session/message endpoints are ever called", () => {
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.doesNotMatch(c.url, /\/sessions/, `write-path endpoint hit: ${c.url}`);
    }
  });

  test("unknown tool: JSON-RPC level error, no crash", async () => {
    const r = await mcp.rpc("tools/call", { name: "add_messages", arguments: { messages: [] } });
    assert.ok(r.error || r.result?.isError, "unknown tool must produce an error");
  });
});

describe("agentarts-memory MCP server (missing credentials)", () => {
  let mcp;

  before(async () => {
    // Endpoint points at an unreachable port — the auth check must fire first,
    // so no network access happens at all.
    mcp = startMcp({
      AGENTARTS_MEMORY_DATA_ENDPOINT: "http://127.0.0.1:1",
      AGENTARTS_MEMORY_SPACE_ID: SPACE,
      AGENTARTS_MEMORY_USER_ID: USER,
    });
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } });
  });

  after(() => mcp.kill());

  test("tool call degrades to an error payload naming the missing env var", async () => {
    const out = await mcp.callTool("search_memories", { query: "anything" });
    assert.match(out.error, /HUAWEICLOUD_SDK_MEMORY_API_KEY/);
    assert.deepEqual(out.results, []);
    assert.equal(out.total, 0);
  });
});
