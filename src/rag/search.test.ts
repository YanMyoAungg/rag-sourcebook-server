import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PGVectorStore } from "@langchain/pgvector";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestDocument } from "../documents/ingest.js";
import { createVectorStore } from "./vector-store.js";
import {
  RELEVANCE_THRESHOLD,
  SearchValidationError,
  searchDocuments,
} from "./search.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://localhost:5432/rag_sourcebook_test";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CORPUS = [
  {
    filename: "pgvector.md",
    content:
      "The pgvector extension adds a vector column type to PostgreSQL. " +
      "Vectors are queried with distance operators, and cosine distance is " +
      "commonly used for text embeddings produced by sentence transformers.",
  },
  {
    filename: "espresso.md",
    content:
      "A double espresso is brewed by forcing hot water at nine bars of " +
      "pressure through finely ground coffee. Grind size, water temperature " +
      "near 93 degrees Celsius, and freshly roasted beans determine the " +
      "crema and the body of the shot.",
  },
  {
    filename: "eclipses.txt",
    content:
      "A lunar eclipse happens when Earth passes between the Sun and the " +
      "Moon, casting Earth's shadow onto the Moon. Totality can last over " +
      "an hour and watching it needs no eye protection.",
  },
];

const ANSWERABLE = [
  { question: "What does pgvector add to PostgreSQL?", filename: "pgvector.md" },
  { question: "How is a double espresso brewed?", filename: "espresso.md" },
  { question: "What causes a lunar eclipse?", filename: "eclipses.txt" },
];

const UNRELATED = [
  "How do I renew a driver's license?",
  "What is the best fertilizer for tomato plants?",
  "Who won the football world cup in 1994?",
];

describe("searchDocuments (PostgreSQL)", () => {
  let pool: Pool;
  let store: PGVectorStore;
  let deps: { getVectorStore: () => Promise<PGVectorStore> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
    await pool.query(await readFile(schemaPath, "utf8"));

    const storePool = new Pool({ connectionString: TEST_DATABASE_URL });
    store = await createVectorStore(storePool);
    deps = { getVectorStore: async () => store };

    await pool.query("TRUNCATE documents, chunks");
    for (const document of CORPUS) {
      await ingestDocument(document, {
        pool,
        getVectorStore: async () => store,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await store.end();
    await pool.end();
  });

  it("rejects an empty query", async () => {
    await expect(searchDocuments("   ", {}, deps)).rejects.toBeInstanceOf(
      SearchValidationError,
    );
  });

  it("rejects a limit outside 1..20", async () => {
    await expect(
      searchDocuments("anything", { limit: 0 }, deps),
    ).rejects.toBeInstanceOf(SearchValidationError);
    await expect(
      searchDocuments("anything", { limit: 500 }, deps),
    ).rejects.toBeInstanceOf(SearchValidationError);
  });

  it("returns ranked hits with source metadata and normalized relevance", async () => {
    const hits = await searchDocuments(
      "What does pgvector add to PostgreSQL?",
      {},
      deps,
    );

    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.filename).toBe("pgvector.md");
    expect(top.documentId).toMatch(uuidPattern);
    expect(top.chunkIndex).toBe(0);
    expect(top.content).toContain("vector column type");
    expect(top.relevance).toBeGreaterThan(0);
    expect(top.relevance).toBeLessThanOrEqual(1);

    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i]!.relevance).toBeLessThanOrEqual(hits[i - 1]!.relevance);
    }
  });

  it("keeps answerable questions above threshold and filters unrelated ones below it", async () => {
    for (const { question, filename } of ANSWERABLE) {
      const hits = await searchDocuments(
        question,
        { minRelevance: RELEVANCE_THRESHOLD },
        deps,
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.filename).toBe(filename);
    }

    for (const question of UNRELATED) {
      const hits = await searchDocuments(
        question,
        { minRelevance: RELEVANCE_THRESHOLD },
        deps,
      );
      expect(hits).toHaveLength(0);
    }
  }, 30_000);
});
