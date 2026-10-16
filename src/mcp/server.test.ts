import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { PGVectorStore } from "@langchain/pgvector";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestDocument } from "../documents/ingest.js";
import { createVectorStore } from "../rag/vector-store.js";
import { createMcpServer, resolveAllowedHosts } from "./server.js";
import type { McpDeps } from "./server.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://localhost:5432/rag_sourcebook_test";

const ESPRESSO = {
  filename: "espresso.md",
  content:
    "A double espresso is brewed by forcing hot water at nine bars of " +
    "pressure through finely ground coffee. Water temperature near 93 " +
    "degrees Celsius and fresh beans determine the crema and body of the shot.",
};
const PGVECTOR = {
  filename: "pgvector.md",
  content:
    "The pgvector extension adds a vector column type to PostgreSQL and is " +
    "commonly queried with cosine distance for text embeddings.",
};

function firstText(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("MCP server", () => {
  let pool: Pool;
  let store: PGVectorStore;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let espressoId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
    await pool.query(await readFile(schemaPath, "utf8"));

    const storePool = new Pool({ connectionString: TEST_DATABASE_URL });
    store = await createVectorStore(storePool);
    const deps: McpDeps = {
      pool,
      searchDeps: { getVectorStore: async () => store },
    };

    await pool.query("TRUNCATE documents, chunks");
    const espresso = await ingestDocument(ESPRESSO, {
      pool,
      getVectorStore: async () => store,
    });
    await ingestDocument(PGVECTOR, { pool, getVectorStore: async () => store });
    espressoId = espresso.id;

    server = createMcpServer(deps);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "mcp-tests", version: "0.1.0" });
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    await store.end();
    await pool.end();
  });

  it("registers search_documents and get_document with input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(["get_document", "search_documents"]);
    const search = tools.find((tool) => tool.name === "search_documents")!;
    expect(search.description).toMatch(/search/i);
    expect(search.inputSchema).toMatchObject({ type: "object" });
  });

  it("search_documents returns ranked source chunks", async () => {
    const result = await client.callTool({
      name: "search_documents",
      arguments: { query: "How is a double espresso brewed?" },
    });

    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("espresso.md");
    expect(text).toMatch(/relevance/);
    expect(text).toContain("nine bars");
  });

  it("rejects invalid tool arguments before the handler runs", async () => {
    const tooBig = await client.callTool({
      name: "search_documents",
      arguments: { query: "espresso", limit: 999 },
    });
    expect(tooBig.isError).toBe(true);
    expect(firstText(tooBig).toLowerCase()).toContain("validation");

    const wrongType = await client.callTool({
      name: "search_documents",
      arguments: { query: 42 },
    });
    expect(wrongType.isError).toBe(true);
  });

  it("get_document returns the metadata and original content", async () => {
    const result = await client.callTool({
      name: "get_document",
      arguments: { documentId: espressoId },
    });

    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("espresso.md");
    expect(text).toContain(espressoId);
    expect(text).toContain("nine bars");
  });

  it("get_document reports an unknown id as a tool error", async () => {
    const result = await client.callTool({
      name: "get_document",
      arguments: { documentId: "00000000-0000-4000-8000-000000000000" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/no document/i);
  });
});

describe("resolveAllowedHosts", () => {
  it("parses a comma-separated list, trimming and dropping empties", () => {
    expect(
      resolveAllowedHosts({ MCP_ALLOWED_HOSTS: "a.example, b.example ,, " }),
    ).toEqual(["a.example", "b.example"]);
  });

  it("falls back to the platform hostname when the list is unset", () => {
    expect(
      resolveAllowedHosts({
        RENDER_EXTERNAL_HOSTNAME: "rag-sourcebook.onrender.com",
      }),
    ).toEqual(["rag-sourcebook.onrender.com"]);
  });

  it("prefers the explicit list over the platform hostname", () => {
    expect(
      resolveAllowedHosts({
        MCP_ALLOWED_HOSTS: "api.example.com",
        RENDER_EXTERNAL_HOSTNAME: "x.onrender.com",
      }),
    ).toEqual(["api.example.com"]);
  });

  it("returns undefined when nothing is set", () => {
    expect(resolveAllowedHosts({})).toBeUndefined();
  });
});
