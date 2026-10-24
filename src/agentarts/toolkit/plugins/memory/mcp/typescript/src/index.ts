#!/usr/bin/env node
// AgentArts Memory MCP server (TypeScript) — stdio transport.
//
// TypeScript port of src/agentarts/toolkit/plugins/memory/mcp/server.py.
// Instead of wrapping the Python agentarts SDK, this server calls the
// Huawei Cloud AgentArts Memory data-plane REST API directly (the same
// endpoints as resources/scripts/_shared.mjs).
//
// Exposes three MCP tools. Read-only by design: writing is handled by the
// platform hooks/plugins, so this server needs no session management:
//   - search_memories — semantic search of cloud memories
//   - list_memories   — paginated list of memory records
//   - search_summary  — list summary-type memories
//
// Lifecycle is managed by the platform (Claude Code / Codex / OpenCode):
// the platform launches this binary as a subprocess and communicates via
// stdin/stdout JSON-RPC.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MIN_SCORE,
  DEFAULT_TOP_K,
  getApiKey,
  getBaseUrl,
  getSpaceId,
  resolveUserId,
} from "./config.js";
import { MemoryDataPlane } from "./api.js";
import { MemoryClient, ListItem, SearchItem } from "./memory-client.js";

// All logging goes to stderr — stdout carries the JSON-RPC stream.
function log(...args: unknown[]): void {
  console.error("[agentarts-memory]", ...args);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── shared client instance ──
let client: MemoryClient | null = null;

function getClient(): MemoryClient {
  if (client === null) {
    client = new MemoryClient(new MemoryDataPlane(getBaseUrl(), getApiKey(), getSpaceId()));
  }
  return client;
}

const SUMMARY_TYPES = new Set(["summary", "episodic", "user_preference"]);

// ── MCP server instance ──
const server = new McpServer(
  { name: "agentarts-memory", version: "1.0.0" },
  {
    instructions:
      "AgentArts Memory provides cross-session cloud memory via Huawei Cloud. " +
      "Use search_memories to find relevant past context and list_memories to " +
      "browse stored memories.",
  },
);

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

// ── Tool: search_memories ──
server.registerTool(
  "search_memories",
  {
    description: "Search cloud memories by semantic similarity.",
    inputSchema: {
      query: z.string().describe("Natural-language search query."),
      num: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(DEFAULT_TOP_K)
        .describe("Maximum results to return (1-100)."),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .default(DEFAULT_MIN_SCORE)
        .describe("Minimum similarity score (0.0-1.0)."),
    },
  },
  async ({ query, num, threshold }) => {
    try {
      const results = await getClient().searchMemories(query, resolveUserId(), num, threshold);
      return jsonResult({ results, total: results.length, query });
    } catch (e) {
      log("search_memories failed:", errorText(e));
      return jsonResult({ error: errorText(e), results: [], total: 0 });
    }
  },
);

// ── Tool: list_memories ──
server.registerTool(
  "list_memories",
  {
    description: "List memory records from cloud memory.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(DEFAULT_LIST_LIMIT)
        .describe("Maximum records to return (1-100)."),
      offset: z.number().int().min(0).default(0).describe("Pagination offset."),
    },
  },
  async ({ limit, offset }) => {
    try {
      const results = await getClient().listMemories(limit, offset);
      return jsonResult({ results, total: results.length });
    } catch (e) {
      log("list_memories failed:", errorText(e));
      return jsonResult({ error: errorText(e), results: [], total: 0 });
    }
  },
);

// ── Tool: search_summary ──
server.registerTool(
  "search_summary",
  {
    description:
      "Search summary-type memories by semantic similarity. Performs a semantic " +
      "search, then filters results to summary-type memories (episodic, summary, " +
      "user_preference). Falls back to listing all memories if none are found.",
    inputSchema: {
      query: z.string().describe("Natural-language search query."),
      num: z.number().int().min(1).max(100).default(3).describe("Maximum results to return."),
    },
  },
  async ({ query, num }) => {
    try {
      const userId = resolveUserId();
      const c = getClient();

      // Semantic search with the query, then filter to summary types.
      const searchResults = await c.searchMemories(
        query,
        userId,
        Math.max(num * 3, DEFAULT_TOP_K),
        DEFAULT_MIN_SCORE,
      );
      let summaries: (SearchItem | ListItem)[] = searchResults.filter((m) =>
        SUMMARY_TYPES.has(m.type),
      );

      // Fallback: list memories and filter by type if semantic search found none.
      if (summaries.length === 0) {
        const allMem = await c.listMemories(Math.min(Math.max(num * 5, DEFAULT_LIST_LIMIT), 20), 0);
        summaries = allMem.filter((m) => SUMMARY_TYPES.has(m.type));
        if (summaries.length === 0) summaries = allMem;
      }

      summaries = summaries.slice(0, num);
      return jsonResult({ results: summaries, total: summaries.length, query });
    } catch (e) {
      log("search_summary failed:", errorText(e));
      return jsonResult({ error: errorText(e), results: [], total: 0 });
    }
  },
);

// ── entry point ──
async function main(): Promise<void> {
  if (!getSpaceId() || !getApiKey()) {
    const missing = [!getSpaceId() && "AGENTARTS_MEMORY_SPACE_ID", !getApiKey() && "HUAWEICLOUD_SDK_MEMORY_API_KEY"]
      .filter(Boolean)
      .join(", ");
    log(`warning: missing configuration: ${missing}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server (typescript) running on stdio, endpoint=${getBaseUrl()}`);
}

main().catch((e) => {
  log("fatal:", errorText(e));
  process.exit(1);
});
