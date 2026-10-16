# RAG Sourcebook Server Plan

**Goal:** Build the independent Hono API and MCP server that ingests documents, stores embeddings in PostgreSQL/pgvector, retrieves relevant chunks, and generates cited answers.

**Architecture:** This is a standalone Node.js TypeScript project with its own Git history and dependencies. It exposes REST endpoints for the client and an MCP Streamable HTTP endpoint for MCP clients. Both use the same document and retrieval services.

**Stack:** Hono, `@hono/node-server`, `@hono/zod-validator`, Zod, Hono's `cors` middleware, PostgreSQL/pgvector, `pg`, LangChain.js (`@langchain/core`, `@langchain/textsplitters`, `@langchain/pgvector`, `@langchain/openai`), Transformers.js (`@huggingface/transformers`) for local sentence embeddings, OpenCode Inference, official MCP TypeScript SDK Hono/server/client/node packages, dotenv, Vitest, pnpm.

## API contract provided

The client keeps matching local TypeScript response types; no shared source folder/package is used.

- `GET /api/health` → `{ status: "ok" }`
- `GET /api/documents` → `{ documents: DocumentSummary[] }`
- `POST /api/documents` accepts JSON `{ filename: string; content: string }` and returns the indexed document summary.
- `POST /api/chat` accepts `{ question: string }` and returns `{ answer: string; citations: Citation[]; retrievedChunks: SearchHit[] }`.
- `/mcp` exposes `search_documents({ query, limit? })` and `get_document({ documentId })`.
- Configure `CLIENT_ORIGIN`, `DATABASE_URL`, embedding configuration, OpenCode Inference URL/model, and any credential through environment variables.

## Constraints

- Accept only `.txt` and `.md` documents up to 1 MiB; reject empty or unsupported uploads.
- Store original document content and metadata separately from chunk vectors. Chunk metadata includes document ID, filename, and chunk index.
- Determine the local embedding model and dimension from current docs before creating the vector schema; re-index if the embedding model changes.
- Select a free OpenCode Inference model ID from its live model list. Do not assume the UI label is the API ID.
- Normalize retrieval relevance so larger values mean more relevant; calibrate an abstention threshold against three answerable and three unrelated questions.
- Keep secrets out of Git. Use `.env.example` only.
- Use SQL schema/migration files and the `pg` driver; do not add an ORM for this demo.
- Use `@langchain/openai` with OpenCode's OpenAI-compatible chat endpoint; verify the current custom base URL configuration before implementation.
- Keep API input schemas and environment validation in the server repository with Zod; no shared package is required.
- Backend host and hosted PostgreSQL provider are selected after comparing current pricing, Node runtime, pgvector support, and connection requirements. Do not tie application code to one provider.

## Tasks

### 1. Scaffold the server repository and database setup

**Files:** `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `src/app.ts`, `src/index.ts`, `src/db/pool.ts`, `src/db/schema.sql`, `src/config/env.ts`, `.gitignore`, `.env.example`, `README.md`, `vitest.config.ts`.

- [x] Write a failing health-route test for `GET /api/health` returning status 200 and `{ status: "ok" }`.
- [x] Run the focused test and confirm it fails because the route is missing.
- [x] Create the Hono Node application with `@hono/node-server`, Zod request/environment validation, restricted CORS middleware, and PostgreSQL configuration; add the minimal health route.
- [x] Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.

### 2. Implement ingestion and pgvector persistence

**Files:** `src/documents/repository.ts`, `src/documents/ingest.ts`, `src/routes/documents.ts`, `src/documents/ingest.test.ts`, `src/db/schema.sql`.

- [x] Verify the Transformers.js Node API and selected local sentence-embedding model with current docs; record its vector dimension before creating the pgvector schema.
- [x] Write failing tests for empty content, invalid extensions, the 1 MiB limit, metadata preservation, and cleanup after embedding/storage failure.
- [x] Run tests and confirm they fail on the missing behavior.
- [x] Implement splitting, local embeddings, document metadata persistence, `PGVectorStore` writes, and safe cleanup/transaction behavior.
- [x] Verify an indexed chunk and vector using a PostgreSQL integration test with `CREATE EXTENSION vector` enabled.

### 3. Implement retrieval and grounded chat

**Files:** `src/rag/search.ts`, `src/rag/answer.ts`, `src/routes/chat.ts`, `src/rag/search.test.ts`, `src/rag/answer.test.ts`.

- [x] Test empty queries, no results, below-threshold retrieval, citation mapping, missing model configuration, and model timeout/error behavior.
- [x] Implement ranked similarity search with source metadata and a calibrated relevance threshold.
- [x] Query the OpenCode live model list and configure a free available chat model through LangChain’s compatible integration.
- [x] Generate answers from retrieved evidence only; validate citation IDs against retrieved chunks and abstain below threshold without calling the model.
- [x] Verify with a seeded corpus and one live free-model request.

### 4. Implement the MCP server and client smoke test

**Files:** `src/mcp/server.ts`, `src/mcp/server.test.ts`, `scripts/mcp-smoke.ts`, `src/app.ts`.

- [ ] Test tool registration, valid search, document lookup, and invalid argument handling.
- [ ] Mount the official MCP TypeScript SDK Hono integration at `/mcp` using Streamable HTTP.
- [ ] Implement both tools by calling the same retrieval/document services as REST.
- [ ] Write a small MCP client script that connects, lists tools, invokes search, and prints sources.
- [ ] Run the client against the local server and compare returned sources with REST retrieval.

### 5. Verify and deploy the server

- [ ] Run unit and PostgreSQL integration tests; confirm CORS accepts the configured client origin and rejects other origins.
- [ ] Compare current backend-host and managed PostgreSQL options for cost, Node support, pgvector support, connection limits, and sleep behavior; record the selected provider before deployment.
- [ ] Deploy the API and database, configure environment secrets, and confirm health, upload, chat, and MCP endpoint access over HTTPS.
- [ ] Run an integration smoke test from the deployed Vercel client.

## Out of scope

- Authentication, multi-tenant isolation, PDF parsing, URL crawling, background queues, hybrid search, reranking, LangGraph, and production-scale HNSW tuning.
- A paid embeddings API. If local embeddings cannot run reliably, stop and ask before adding a paid provider.
