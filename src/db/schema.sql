-- Base schema for RAG Sourcebook.
-- Chunk/vector tables are added by the ingestion task once the local
-- embedding model and its vector dimension are confirmed.

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
