# RAG Sourcebook Server

Hono API and MCP server for document Q&A: ingests text and Markdown documents,
stores embeddings in PostgreSQL (pgvector), retrieves relevant chunks, and
returns answers with citations. Part of the `rag-sourcebook` workspace
(see `../PLAN.md`); the React frontend lives in `../client`.

## Stack

Hono on Node.js, TypeScript, Zod, PostgreSQL/pgvector, LangChain.js,
Transformers.js (local sentence embeddings), OpenCode Inference (answer
generation), and the MCP TypeScript SDK.

## Setup

- Node 20+, pnpm, and a PostgreSQL server with the pgvector extension available.
- `pnpm install`
- `cp .env.example .env` and adjust values as needed.
- Create the database referenced by `DATABASE_URL` (default
  `rag_sourcebook`).
- Tests use a separate database (`rag_sourcebook_test` by default; override
  with `TEST_DATABASE_URL`). Create it once with
  `createdb rag_sourcebook_test` — the suite applies `src/db/schema.sql`
  itself.

## Scripts

- `pnpm dev` — start the server with watch mode (tsx).
- `pnpm test` — run the Vitest suite.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm build` — compile to `dist/`; run with `pnpm start`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://localhost:5432/rag_sourcebook` | PostgreSQL/pgvector connection string |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed browser origin for CORS |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Local Transformers.js embedding model (384 dimensions; changing it requires a schema update and re-index) |
| `OPENCODE_INFERENCE_BASE_URL` | `https://opencode.ai/inference/go/openai/v1` | OpenAI-compatible inference endpoint (OpenCode Go) |
| `OPENCODE_INFERENCE_API_KEY` | – | Inference key; chat answers report 503 while unset |
| `CHAT_MODEL` | `cat-jam-free` | Free model ID, selected from the live model list |

## API contract

- `GET /api/health` → `{ "status": "ok" }`
- `GET /api/documents` → `{ documents: DocumentSummary[] }`
- `POST /api/documents` (JSON `{ filename, content }`) → indexed document summary
- `POST /api/chat` (JSON `{ question }`) → `{ answer, citations, retrievedChunks }`
- `/mcp` → MCP Streamable HTTP endpoint with `search_documents` and `get_document` tools

## Status

Implemented so far: health route, environment validation, CORS, database
pools, document ingestion (`POST /api/documents`, `GET /api/documents`) with
local Transformers.js embeddings and pgvector storage, and grounded chat
(`POST /api/chat`) with citations and below-threshold abstention. MCP lands in
the next task (see `PLAN.md`).
