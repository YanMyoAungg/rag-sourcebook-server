-- Schema for RAG Sourcebook.
--
-- Local embedding model: Xenova/all-MiniLM-L6-v2 via Transformers.js.
-- Verified dimension: 384, L2-normalized vectors. If EMBEDDING_MODEL changes,
-- update the dimension below and re-index every chunk.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chunk vectors. Mirrors the table LangChain's PGVectorStore creates in
-- initialize() (id/content/metadata/vector) so the store's own
-- CREATE TABLE IF NOT EXISTS becomes a no-op.
CREATE TABLE IF NOT EXISTS chunks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  content text,
  metadata jsonb,
  vector vector(384)
);
