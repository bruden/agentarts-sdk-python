// High-level memory operations — TypeScript port of
// src/agentarts/toolkit/plugins/memory/agentarts_client.py, calling the
// data-plane REST API directly instead of the Python SDK.
//
// Read-only search. Writing (add_messages) stays with the platform
// hooks/plugins, so this server needs no session management.

import { DEFAULT_MIN_SCORE, DEFAULT_TOP_K } from "./config.js";
import { MemoryDataPlane, SearchRecord } from "./api.js";

export interface SearchItem {
  content: string;
  score: number;
  type: string;
}

// ── normalization helpers (parity with the Python client) ──

function extractContent(record: unknown): string {
  if (record === null || record === undefined) return "";
  if (typeof record === "string") return record;
  if (typeof record === "object") {
    const r = record as Record<string, unknown>;
    for (const key of ["content", "text", "summary", "message"]) {
      const val = r[key];
      if (val) return String(val);
    }
    // nested record
    const inner = r["record"];
    if (inner) return extractContent(inner);
  }
  return String(record);
}

function extractType(record: unknown): string {
  if (typeof record === "object" && record !== null) {
    const r = record as Record<string, unknown>;
    for (const key of ["strategy_type", "memory_type", "type", "strategy"]) {
      const val = r[key];
      if (val) return String(val);
    }
    const inner = r["record"];
    if (typeof inner === "object" && inner !== null) return extractType(inner);
  }
  return "";
}

function normalizeSearchResults(resp: { records?: SearchRecord[]; results?: SearchRecord[] }): SearchItem[] {
  const raw = resp.records ?? resp.results ?? [];
  return raw.map((item) => {
    const rec = (item ?? {}) as SearchRecord;
    const record = rec.record !== undefined ? rec.record : rec;
    return {
      content: extractContent(record),
      score: typeof rec.score === "number" ? rec.score : 0,
      type: extractType(record),
    };
  });
}

export class MemoryClient {
  constructor(private readonly api: MemoryDataPlane) {}

  async searchMemories(
    query: string,
    userId: string,
    num: number = DEFAULT_TOP_K,
    threshold: number = DEFAULT_MIN_SCORE,
  ): Promise<SearchItem[]> {
    const resp = await this.api.searchMemories({
      query,
      top_k: num,
      min_score: threshold,
      actor_id: userId,
    });
    return normalizeSearchResults(resp);
  }
}
