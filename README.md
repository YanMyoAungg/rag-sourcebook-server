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

## API contract

- `GET /api/health` → `{ "status": "ok" }`
- `GET /api/documents` → `{ documents: DocumentSummary[] }`
- `POST /api/documents` (JSON `{ filename, content }`) → indexed document summary
- `POST /api/chat` (JSON `{ question }`) → `{ answer, citations, retrievedChunks }`
- `/mcp` → MCP Streamable HTTP endpoint with `search_documents` and `get_document` tools

## Status

Implemented so far: health route, environment validation, CORS, database pool,
and base schema. Document ingestion, retrieval/chat, and MCP land in the
following tasks (see `PLAN.md`).
