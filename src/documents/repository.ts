import type { Pool } from "pg";

export interface DocumentSummary {
  id: string;
  filename: string;
  chunkCount: number;
  createdAt: string;
}

export async function insertDocument(
  pool: Pool,
  input: { filename: string; content: string },
): Promise<{ id: string; createdAt: string }> {
  const result = await pool.query<{ id: string; created_at: Date }>(
    "INSERT INTO documents (filename, content) VALUES ($1, $2) RETURNING id, created_at",
    [input.filename, input.content],
  );
  // INSERT ... RETURNING always yields exactly one row.
  const row = result.rows[0]!;
  return { id: row.id, createdAt: row.created_at.toISOString() };
}

export async function deleteDocument(pool: Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM documents WHERE id = $1", [id]);
}

export async function deleteChunksForDocument(
  pool: Pool,
  documentId: string,
): Promise<void> {
  await pool.query("DELETE FROM chunks WHERE metadata->>'documentId' = $1", [
    documentId,
  ]);
}

export async function listDocuments(pool: Pool): Promise<DocumentSummary[]> {
  const result = await pool.query<{
    id: string;
    filename: string;
    created_at: Date;
    chunk_count: number;
  }>(
    `SELECT d.id, d.filename, d.created_at, count(c.id)::int AS chunk_count
     FROM documents d
     LEFT JOIN chunks c ON c.metadata->>'documentId' = d.id::text
     GROUP BY d.id
     ORDER BY d.created_at DESC, d.filename`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    chunkCount: row.chunk_count,
    createdAt: row.created_at.toISOString(),
  }));
}
