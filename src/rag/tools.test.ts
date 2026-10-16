import { Document } from "@langchain/core/documents";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { SearchDeps } from "./search.js";
import { getDocumentTool, searchDocumentsTool } from "./tools.js";

const HIT = new Document({
  pageContent: "A double espresso is brewed at nine bars.",
  metadata: { documentId: "d1", filename: "espresso.md", chunkIndex: 0 },
});

function fakeSearchDeps(distance: number) {
  const similaritySearchWithScore = vi.fn(async () => [
    [HIT, distance] as [Document, number],
  ]);
  const deps: SearchDeps = {
    getVectorStore: async () => ({ similaritySearchWithScore }),
  };
  return { deps, similaritySearchWithScore };
}

describe("search_documents tool", () => {
  it("takes a query plus an optional limit", () => {
    expect(searchDocumentsTool.inputSchema.parse({ query: "espresso" })).toEqual(
      { query: "espresso" },
    );
  });

  it("refuses a missing query and a limit outside the schema", () => {
    expect(() => searchDocumentsTool.inputSchema.parse({})).toThrow();
    expect(() =>
      searchDocumentsTool.inputSchema.parse({ query: "espresso", limit: 999 }),
    ).toThrow();
  });

  it("passes the limit through to retrieval", async () => {
    const { deps, similaritySearchWithScore } = fakeSearchDeps(0.9);

    await searchDocumentsTool.run({ query: "espresso", limit: 3 }, deps);

    expect(similaritySearchWithScore).toHaveBeenCalledWith("espresso", 3);
  });

  it("returns ranked hits even when they would be below the answering threshold", async () => {
    // 0.9 cosine distance is a relevance of 0.1: far below the 0.35 floor the
    // answering pipeline applies, and still a result a tool caller asked for.
    const { deps } = fakeSearchDeps(0.9);

    const hits = await searchDocumentsTool.run({ query: "espresso" }, deps);

    expect(hits).toEqual([
      {
        documentId: "d1",
        filename: "espresso.md",
        chunkIndex: 0,
        content: "A double espresso is brewed at nine bars.",
        relevance: expect.closeTo(0.1, 5),
      },
    ]);
  });
});

describe("get_document tool", () => {
  it("fetches one document with its metadata", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: "d1",
            filename: "espresso.md",
            content: "A double espresso is brewed at nine bars.",
            created_at: new Date("2026-01-02T03:04:05.000Z"),
            chunk_count: 2,
          },
        ],
      })),
    };

    const document = await getDocumentTool.run(
      { documentId: "d1" },
      { pool: pool as unknown as Pool },
    );

    expect(document).toEqual({
      id: "d1",
      filename: "espresso.md",
      content: "A double espresso is brewed at nine bars.",
      chunkCount: 2,
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("reports an unknown id as no document", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };

    const document = await getDocumentTool.run(
      { documentId: "missing" },
      { pool: pool as unknown as Pool },
    );

    expect(document).toBeNull();
  });
});
