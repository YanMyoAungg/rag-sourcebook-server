import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Document } from "@langchain/core/documents";
import type { PGVectorStore } from "@langchain/pgvector";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createVectorStore } from "../rag/vector-store.js";
import { IngestValidationError, assertValidUpload, ingestDocument } from "./ingest.js";
import type { IngestDeps } from "./ingest.js";
import { listDocuments } from "./repository.js";

const MEBIBYTE = 1024 * 1024;
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://localhost:5432/rag_sourcebook_test";

describe("upload validation", () => {
  it("rejects empty content", () => {
    expect(() =>
      assertValidUpload({ filename: "notes.txt", content: "" }),
    ).toThrow(/content/i);
  });

  it("rejects whitespace-only content", () => {
    expect(() =>
      assertValidUpload({ filename: "notes.txt", content: "  \n\t  " }),
    ).toThrow(/content/i);
  });

  it("rejects an unsupported extension", () => {
    expect(() =>
      assertValidUpload({ filename: "paper.pdf", content: "hello" }),
    ).toThrow(/\.txt/);
  });

  it("rejects a filename without an extension", () => {
    expect(() =>
      assertValidUpload({ filename: "README", content: "hello" }),
    ).toThrow(IngestValidationError);
  });

  it("accepts .txt and .md filenames", () => {
    expect(() =>
      assertValidUpload({ filename: "notes.txt", content: "hello" }),
    ).not.toThrow();
    expect(() =>
      assertValidUpload({ filename: "GUIDE.MD", content: "hello" }),
    ).not.toThrow();
  });

  it("rejects content over the 1 MiB limit", () => {
    const tooBig = "a".repeat(MEBIBYTE + 1);
    expect(() =>
      assertValidUpload({ filename: "big.md", content: tooBig }),
    ).toThrow(/1 MiB/);
  });

  it("accepts content exactly at the 1 MiB limit", () => {
    const exact = "a".repeat(MEBIBYTE);
    expect(() =>
      assertValidUpload({ filename: "exact.txt", content: exact }),
    ).not.toThrow();
  });
});

const LONG_DOC = [
  "Alpha section. " + "alpha ".repeat(120),
  "Beta section. " + "beta ".repeat(120),
  "Gamma section. " + "gamma ".repeat(120),
].join("\n\n");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("document ingestion (PostgreSQL)", () => {
  let pool: Pool;
  let store: PGVectorStore;
  let deps: IngestDeps;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
    await pool.query(await readFile(schemaPath, "utf8"));
    // The store gets its own pool: initialize() holds a client for its
    // lifetime and end() closes the whole pool.
    const storePool = new Pool({ connectionString: TEST_DATABASE_URL });
    store = await createVectorStore(storePool);
    deps = { pool, getVectorStore: async () => store };
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE documents, chunks");
  });

  afterAll(async () => {
    await store.end();
    await pool.end();
  });

  it("stores the document and chunk metadata", async () => {
    const summary = await ingestDocument(
      { filename: "handbook.md", content: LONG_DOC },
      deps,
    );

    const { rows: documents } = await pool.query(
      "SELECT filename, content FROM documents WHERE id = $1",
      [summary.id],
    );
    expect(documents).toHaveLength(1);
    expect(documents[0].filename).toBe("handbook.md");
    expect(documents[0].content).toBe(LONG_DOC);

    const { rows: chunks } = await pool.query(
      "SELECT metadata FROM chunks ORDER BY (metadata->>'chunkIndex')::int",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBe(summary.chunkCount);
    chunks.forEach((row, index) => {
      expect(row.metadata.documentId).toBe(summary.id);
      expect(row.metadata.filename).toBe("handbook.md");
      expect(row.metadata.chunkIndex).toBe(index);
    });
  });

  it("returns a summary with an id, chunk count, and creation date", async () => {
    const summary = await ingestDocument(
      { filename: "tiny.md", content: "A short note about gamma rays." },
      deps,
    );

    expect(summary.id).toMatch(uuidPattern);
    expect(summary.filename).toBe("tiny.md");
    expect(summary.chunkCount).toBe(1);
    expect(Date.parse(summary.createdAt)).not.toBeNaN();
  });

  it("stores 384-dimension normalized vectors for every chunk", async () => {
    const summary = await ingestDocument(
      { filename: "handbook.md", content: LONG_DOC },
      deps,
    );

    const { rows } = await pool.query(
      `SELECT vector_dims(vector) AS dims,
              sqrt(-(vector <#> vector)) AS norm
       FROM chunks`,
    );
    expect(rows).toHaveLength(summary.chunkCount);
    for (const row of rows) {
      expect(row.dims).toBe(384);
      expect(Number(row.norm)).toBeCloseTo(1, 3);
    }
  });

  it("cleans up the document and partial chunks when vector storage fails", async () => {
    const partialWriteThenFail = {
      async addDocuments(documents: Document[]): Promise<void> {
        const first = documents[0]!;
        await pool.query(
          "INSERT INTO chunks (content, metadata) VALUES ($1, $2)",
          [first.pageContent, JSON.stringify(first.metadata)],
        );
        throw new Error("vector backend exploded");
      },
    };

    await expect(
      ingestDocument(
        { filename: "handbook.md", content: LONG_DOC },
        { pool, getVectorStore: async () => partialWriteThenFail },
      ),
    ).rejects.toThrow("vector backend exploded");

    const { rows: documents } = await pool.query("SELECT 1 FROM documents");
    const { rows: chunks } = await pool.query("SELECT 1 FROM chunks");
    expect(documents).toHaveLength(0);
    expect(chunks).toHaveLength(0);
  });

  it("rejects invalid uploads without writing anything", async () => {
    await expect(
      ingestDocument({ filename: "notes.pdf", content: "hello" }, deps),
    ).rejects.toBeInstanceOf(IngestValidationError);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM documents",
    );
    expect(rows[0].count).toBe(0);
  });

  it("lists documents with their chunk counts", async () => {
    const long = await ingestDocument(
      { filename: "handbook.md", content: LONG_DOC },
      deps,
    );
    const short = await ingestDocument(
      { filename: "note.txt", content: "Short note." },
      deps,
    );

    const list = await listDocuments(pool);
    expect(list).toHaveLength(2);

    const byId = new Map(list.map((document) => [document.id, document]));
    expect(byId.get(long.id)).toMatchObject({
      filename: "handbook.md",
      chunkCount: long.chunkCount,
    });
    expect(byId.get(short.id)).toMatchObject({
      filename: "note.txt",
      chunkCount: 1,
    });
    for (const document of list) {
      expect(Date.parse(document.createdAt)).not.toBeNaN();
    }
  });
});
