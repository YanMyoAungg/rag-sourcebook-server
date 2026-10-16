# RAG Sourcebook Server — implementation guide

These docs explain the running server feature by feature, so the code can be
re-derived rather than merely trusted. [`../PLAN.md`](../PLAN.md) is the build
plan: what was asked, in what order, and the evidence each task was closed on.
This folder describes the system as it stands, and why it is shaped that way.

## The server in one paragraph

Hono on Node.js exposes two ways into one retrieval path. Inside, a PostgreSQL
database with pgvector holds documents and their chunk vectors; embeddings are
computed locally with Transformers.js, so no paid API is involved in retrieval;
generation goes out to any OpenAI-compatible chat endpoint, configured entirely
by environment variables. REST serves the browser client, MCP serves any MCP
client, and both call the same tool definitions — the tool an answer traces is
the tool an MCP client calls.

## Reading order

Each doc is self-contained, but they build on each other in this order.

| # | Doc | What you can explain afterwards |
| --- | --- | --- |
| 1 | [Scaffold and configuration](01-scaffold-and-configuration.md) | How a request enters the process, what the environment contract is, why CORS is restricted, how shutdown releases the pools. |
| 2 | [Database and schema](02-database-and-schema.md) | The two tables, why there are two connection pools, why `chunks` has no foreign key, where the vector dimension comes from. |
| 3 | [Embeddings](03-embeddings.md) | How text becomes a 384-dimension vector locally, why mean pooling with normalization, why the model is warmed at build time. |
| 4 | [Document ingestion](04-document-ingestion.md) | The upload rules, how text is split into chunks, the order of writes, and the cleanup if embedding fails halfway. |
| 5 | [Retrieval and relevance](05-retrieval-and-relevance.md) | Cosine distance turned into a normalized relevance, how the 0.35 abstention floor was calibrated, what is deliberately not filtered. |
| 6 | [Grounded answering](06-grounded-answering.md) | How evidence reaches the model, how `[chunk-N]` markers become validated citations, and why the model is never called when nothing matched. |
| 7 | [Chat API and event streaming](07-chat-api-and-event-streaming.md) | The JSON route, the SSE route, the event sequence, heartbeats, aborts, and how one failure mapping serves both routes. |
| 8 | [MCP endpoint and shared tool definitions](08-mcp-endpoint-and-shared-tools.md) | `search_documents` and `get_document` over Streamable HTTP, host-header validation, and why the tools are defined once. |
| 9 | [Deployment and operations](09-deployment-and-operations.md) | Render + Neon, the build-time model warm-up, every environment variable, cold starts, and free-tier limits. |

## How the pieces depend on each other

```text
POST /api/documents ─▶ ingestDocument ─▶ split ─▶ LocalEmbeddings ─▶ PGVectorStore ─▶ chunks
                       └ validates first         (Transformers.js)     (pgvector)

POST /api/chat       ─┐
POST /api/chat/stream ─┴▶ streamAnswer ─▶ searchDocumentsTool ─▶ searchDocuments ─▶ PGVectorStore
                       │                       (tools.ts)         (0.35 floor)
                       └▶ ChatOpenAI.stream ─▶ text deltas ─▶ [chunk-N] ─▶ citations

/mcp  search_documents ─▶ searchDocumentsTool  (same definition, no floor)
/mcp  get_document     ─▶ getDocument ─▶ documents table
```

Two things are worth noticing in that picture:

- Ingestion and answering meet only at the pgvector table. Answering never reads
  the `documents` table, except through the MCP `get_document` tool.
- The relevance floor sits in `streamAnswer`, not in the tool. An MCP client
  asking for the best matches gets them regardless of the floor.

## The contract with the client

The client lives in a separate repository,
[`rag-sourcebook-client`](https://github.com/YanMyoAungg/rag-sourcebook-client),
and has no shared code with this one. Both sides keep private copies of these
types; the contract is:

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/health` | — | `{ status: "ok" }` |
| `GET /api/documents` | — | `{ documents: DocumentSummary[] }` |
| `POST /api/documents` | `{ filename, content }` | `DocumentSummary` (201) |
| `POST /api/chat` | `{ question }` | `{ answer, citations, retrievedChunks }` |
| `POST /api/chat/stream` | `{ question }` | SSE: `tool`, `text-delta`, `finish`, `error` |
| `/mcp` | MCP protocol | Tools `search_documents`, `get_document` |

Failures on the JSON routes are `{ error: string }` with a status code: 400 for a
request the server refuses, 502 for a failed generation, 503 for an unconfigured
chat model, 500 for anything unexpected. The streaming route is the exception —
its response has already started, so the same four cases arrive as an `error`
event carrying `{ message: string }` on a 200.

## Running it locally

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL, and the CHAT_* values
pnpm dev                      # tsx watch, listens on PORT (default 3000)
```

The tests need a real PostgreSQL database with pgvector, because ingestion and
retrieval are integration-tested rather than mocked:

```bash
createdb rag_sourcebook_test
pnpm test                     # TEST_DATABASE_URL overrides the default
pnpm typecheck && pnpm build
```

The MCP endpoint can be probed without a client library:

```bash
MCP_URL=https://rag-sourcebook-server.onrender.com/mcp \
  pnpm exec tsx scripts/mcp-smoke.ts "how are chunks stored?"
```
