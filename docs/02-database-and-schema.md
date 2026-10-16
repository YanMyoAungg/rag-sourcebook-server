# 2. Database and schema

> Two tables, one vector column, two connection pools — and why the chunk table
> deliberately has no foreign key.

## What it does

Holds the corpus. `documents` stores what was uploaded (metadata plus the
original text, byte for byte); `chunks` stores the pieces of that text that were
embedded, their vectors, and enough metadata to point back at the document they
came from.

## How it works

### The schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  content text,
  metadata jsonb,
  vector vector(384)
);
```

Three things about this file are load-bearing:

1. **`chunks` mirrors the table LangChain's `PGVectorStore` creates in
   `initialize()`** — same column names (`id`, `content`, `metadata`, `vector`).
   The store issues its own `CREATE TABLE IF NOT EXISTS` when it starts, so a
   definition that matched would be a no-op. Keeping them aligned means the
   project owns its schema and the library agrees with it, rather than the other
   way round.
2. **`vector(384)`** is the embedding dimension, recorded in the file and
   restated in the header comment with the rule that follows from it: change
   `EMBEDDING_MODEL` and you must update this number *and* re-index.
3. **`metadata jsonb`** is where the foreign key would otherwise be. Ingestion
   writes `{ documentId, filename, chunkIndex }` into it per chunk, which is what
   makes retrieval able to name its source.

### Where the dimension actually comes from

`src/rag/vector-store.ts` does not hard-code 384 in code:

```ts
const dimensions = (await localEmbeddings.embedQuery("dimension probe")).length;
return PGVectorStore.initialize(localEmbeddings, {
  pool: storePool, tableName: "chunks",
  columns: { idColumnName: "id", vectorColumnName: "vector",
             contentColumnName: "content", metadataColumnName: "metadata" },
  dimensions,
});
```

It embeds one throwaway string and measures the result, so the store's idea of
the dimension cannot drift from the model's. The number in `schema.sql` is the
same fact written down for the database to enforce.

Note what this does **not** do: because the table already exists,
`CREATE TABLE IF NOT EXISTS` never runs, so a new `EMBEDDING_MODEL` with a
different width would fail on insert with a dimension mismatch rather than
migrating the column. That failure is loud and immediate, which is the intent —
it is why the model is documented as requiring a re-index.

### The two pools

```ts
export const pool = new Pool({ connectionString: env.DATABASE_URL });

/**
 * Dedicated pool for the pgvector store. PGVectorStore holds one checked-out
 * client for its whole lifetime and its end() terminates the entire pool, so
 * it must not share the application pool.
 */
export const vectorStorePool = new Pool({ connectionString: env.DATABASE_URL });
```

`pool` serves ordinary queries (insert a document, list documents, count chunks,
fetch one document). `vectorStorePool` is handed to `PGVectorStore.initialize`
and never used for anything else. If the store shared `pool`, calling the
store's `end()` — which happens during shutdown — would terminate connections
the rest of the app is still using.

### Reads that count chunks

Listing and fetching both join the chunk table on the jsonb key:

```sql
SELECT d.id, d.filename, d.created_at, count(c.id)::int AS chunk_count
FROM documents d
LEFT JOIN chunks c ON c.metadata->>'documentId' = d.id::text
GROUP BY d.id
ORDER BY d.created_at DESC, d.filename
```

The `LEFT JOIN` keeps a document that produced zero chunks visible instead of
hiding it, `count(c.id)::int` counts chunks rather than rows, and the index on
`d.id` in `GROUP BY d.id` is what makes the grouping legal alongside the
non-aggregated `d.filename`.

### Deleting

Because there is no foreign key, deletion is explicit and ordered:

```ts
export async function deleteChunksForDocument(pool: Pool, documentId: string) {
  await pool.query("DELETE FROM chunks WHERE metadata->>'documentId' = $1", [documentId]);
}
export async function deleteDocument(pool: Pool, id: string) {
  await pool.query("DELETE FROM documents WHERE id = $1", [id]);
}
```

Chunks first, then the document. `ingestDocument` calls both in its error path
for exactly this reason ([Document ingestion](04-document-ingestion.md)).

## Decisions and rejected alternatives

- **No foreign key from `chunks` to `documents`,** even though it would make
  `ON DELETE CASCADE` free. `chunks` is the table the vector store manages, and
  a constraint the library does not know about would be silently dropped by any
  library-driven rebuild of that table. The link lives in `metadata`, where
  LangChain's own filtering can use it. The cost is the explicit two-statement
  delete above.
- **No ORM.** `pg` plus SQL files, per the project constraints. The queries are
  short, the types are declared at each call site (`pool.query<{…}>`), and there
  is no mapping layer to reason about.
- **Store the original text, not just chunks.** `get_document` exists to return
  the whole document; reconstructing it by concatenating chunks would lose the
  original formatting and the overlap between chunks would duplicate text.
- **`gen_random_uuid()` in DDL rather than an application-side UUID.** Since
  PostgreSQL 13 it is a core function, so no extension is needed, and ids are
  generated inside the transaction that inserts the row.
- **No vector index configured.** At this corpus size a sequential scan ordered
  by `<=>` is fast enough, and an index is a tuning knob with its own build cost.
  Production-scale HNSW tuning is listed as out of scope in `../PLAN.md`; adding
  `CREATE INDEX … USING hnsw` is the first thing to reach for if the corpus grows.

## Where it can bite you

- **`metadata->>'documentId'` compares text to text.** The `->>` operator
  extracts a jsonb value as `text`, and `d.id::text` casts the uuid to match.
  Comparing a uuid column directly to a jsonb extraction would not use an index
  and, in some PostgreSQL versions, would fail to resolve the operator at all.
- **Chunk counts come from a join, not a stored counter.** A document whose
  chunks were deleted but whose row survived would report zero chunks, not a
  stale number. That is the reason the counter is not cached.
- **`chunks.content` and `metadata` are nullable** — LangChain's own definition.
  Retrieval therefore validates metadata before using it and skips rows it did
  not write ([Retrieval and relevance](05-retrieval-and-relevance.md)).
- **The tests truncate both tables.** `fileParallelism: false` in
  `vitest.config.ts` exists because every test file shares one test database and
  parallel truncate/seed steps would race each other.

## Questions this invites

**Why is there a separate pool just for the vector store?**
Because `PGVectorStore` holds one client for its lifetime and its `end()`
terminates the pool it was given. Sharing the application pool would mean
shutting down the store kills unrelated queries.

**What happens if the same document is uploaded twice?**
Two rows, two sets of chunks, no deduplication. Documents are immutable and
identified by id, so a re-upload is a new document that happens to have the same
filename — and retrieval may return chunks from both.

**Why is the relevance score not stored?**
Relevance is a property of a *query*, not of a chunk. `1 - cosine_distance` is
computed per search in `searchDocuments`, so storing it would be meaningless as
soon as a second question was asked.

**Why not use `ON DELETE CASCADE`?**
Because the table that would need the constraint is created by a library. Storing
the link in `metadata` keeps the schema honest about who owns which table.

## Related

- [Embeddings](03-embeddings.md) — where the 384 numbers come from.
- [Document ingestion](04-document-ingestion.md) — the writer of both tables.
- [Retrieval and relevance](05-retrieval-and-relevance.md) — the reader of
  `chunks`, and why it skips rows it does not recognise.
