# 4. Document ingestion

> The write path: refuse the wrong files cheaply, store the original text, split
> it, embed the pieces, and leave nothing behind if embedding fails.

## What it does

Takes `{ filename, content }`, checks it against the project's upload rules,
stores the document, splits it into overlapping chunks, embeds each chunk, writes
the vectors, and returns a summary of what was indexed.

## How it works

### The rules, checked before anything is written

```ts
const MAX_CONTENT_BYTES = 1024 * 1024;
const ACCEPTED_EXTENSIONS = [".txt", ".md"] as const;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

export function assertValidUpload(input: UploadInput): void {
  const filename = input.filename.trim();
  if (filename.length === 0) throw new IngestValidationError("filename must not be empty");

  const lowerCaseFilename = filename.toLowerCase();
  const hasAcceptedExtension = ACCEPTED_EXTENSIONS.some((e) => lowerCaseFilename.endsWith(e));
  if (!hasAcceptedExtension) throw new IngestValidationError(
    `unsupported file type "${input.filename}" (accepts ${ACCEPTED_EXTENSIONS.join(", ")})`);

  if (input.content.trim().length === 0)
    throw new IngestValidationError("content must not be empty");

  const byteLength = Buffer.byteLength(input.content, "utf8");
  if (byteLength > MAX_CONTENT_BYTES)
    throw new IngestValidationError(`content exceeds the 1 MiB limit (${byteLength} bytes)`);
}
```

Four checks: a non-blank filename, an extension in the allowed set
(case-insensitively, so `NOTES.MD` passes), content that is not just whitespace,
and a size measured in UTF-8 **bytes**. The distinct error messages exist so the
client can show the server's reason verbatim rather than inventing one.

### The write order

```ts
export async function ingestDocument(input, deps = defaultDeps()) {
  assertValidUpload(input);

  const { id, createdAt } = await insertDocument(deps.pool, input);

  try {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });
    const pieces = await splitter.splitText(input.content);
    const chunks = pieces.map((piece, chunkIndex) => new Document({
      pageContent: piece,
      metadata: { documentId: id, filename: input.filename, chunkIndex },
    }));

    const store = await deps.getVectorStore();
    await store.addDocuments(chunks);

    return { id, filename: input.filename, chunkCount: chunks.length, createdAt };
  } catch (error) {
    try {
      await deleteChunksForDocument(deps.pool, id);
      await deleteDocument(deps.pool, id);
    } catch (cleanupError) {
      console.error("failed to clean up after ingestion error", cleanupError);
    }
    throw error;
  }
}
```

Step by step:

1. **Validate.** Nothing is written if this throws.
2. **Insert the document row first** to get its `id`, the creation timestamp, and
   a row to clean up later. This is the decision that makes the rest work: every
   chunk's metadata carries `documentId: id`.
3. **Split** with `RecursiveCharacterTextSplitter` at 1000 characters with 150
   characters of overlap. The splitter prefers paragraph and sentence boundaries
   and only falls back to a hard character cut when a single run of text has no
   separator — so chunks usually end where prose ends.
4. **Build LangChain `Document`s** whose `pageContent` is the piece and whose
   `metadata` is `{ documentId, filename, chunkIndex }`. This metadata is what
   retrieval later reports and what the two-table join counts.
5. **Write the vectors** through the store. `addDocuments` embeds every chunk and
   inserts the rows.
6. **Return a summary** — `{ id, filename, chunkCount, createdAt }` — not the
   content, so the response stays small no matter how large the upload was.

If any step from 3 onwards throws, the catch deletes the chunks and then the
document and rethrows. A failed cleanup is logged and does not mask the original
error, because the original error is what the caller needs to see.

### Dependencies are injected, with real defaults

```ts
export interface IngestDeps {
  pool: Pool;
  getVectorStore: () => Promise<VectorWriter>;
}

export interface VectorWriter {
  addDocuments(documents: Document[]): Promise<void>;
}
```

`Pool` and a one-method `VectorWriter` are the only things this function needs.
Tests pass a fake writer that throws to exercise the cleanup path
(`ingest.test.ts`: "cleans up the document and partial chunks when vector storage
fails"), so the failure branch is proven without corrupting a real store.

### The route

```ts
documentsRouter.post("/documents",
  zValidator("json", uploadSchema, (result, c) => {
    if (!result.success)
      return c.json({ error: "request body must be JSON { filename: string, content: string }" }, 400);
  }),
  async (c) => {
    const { filename, content } = c.req.valid("json");
    try {
      return c.json(await ingestDocument({ filename, content }), 201);
    } catch (error) {
      if (error instanceof IngestValidationError) return c.json({ error: error.message }, 400);
      console.error("document ingestion failed", error);
      return c.json({ error: "failed to index document" }, 500);
    }
  });
```

Three status outcomes, and the split between them matters: a body that is not
`{ filename, content }` at all is a `400` from the validator; a body that parses
but breaks a rule is a `400` carrying the rule's own message; anything else —
the database being unreachable, the embedding model failing to load — is a
logged `500` with a generic message.

## Decisions and rejected alternatives

- **Insert the document before embedding it.** The alternative (embed first, then
  insert) would need the id generated client-side or a second round trip, and
  would leave an untagged chunk if the insert failed after the vectors were
  written. Writing the parent first means orphaned chunks are always detectable
  by their `documentId`.
- **Validate inside `ingestDocument`, not only in the route.** The rules are
  properties of ingestion, so any future caller inherits them; the route only
  translates the typed error into a status code.
- **JSON `{ filename, content }`, not `multipart/form-data`.** The contract was
  fixed before the client existed, and it makes the server's rules identical for
  every caller — a browser reading a file with `file.text()` and a script
  posting a string take the same path. The cost is that the whole file is read
  into memory on both sides.
- **1000 characters with 150 of overlap.** For English prose that is roughly
  200–250 tokens — comfortably inside MiniLM's 512-token window. For text whose
  script the tokenizer splits per character (Chinese, Japanese, Korean), a full
  1000-character chunk can exceed that window and be truncated before embedding,
  so the limit is tuned for the corpus it was written against rather than for
  every input the rules accept. The overlap keeps a sentence that straddles a
  boundary retrievable from at least one chunk in full.
- **`RecursiveCharacterTextSplitter` over a fixed-size window.** A blind 1000-
  character cut splits mid-sentence and produces chunks whose embeddings are
  about two half-thoughts. The recursive splitter costs a little CPU and keeps
  boundaries meaningful.
- **Delete on failure rather than leaving a partial document.** A document row
  with half its chunks is worse than no document: answers would cite a subset and
  the library would still show it. Cleanup keeps the corpus honest.

## Where it can bite you

- **Ingestion is not one transaction.** The document insert commits, then the
  store writes chunk rows one at a time. Cleanup only runs for errors that are
  *caught*; if the process dies mid-ingest (a deploy, an out-of-memory kill), the
  document row survives with fewer chunks than it should have. Nothing hides
  this: `GET /api/documents` reports the real chunk count, so a `0 chunks` entry
  is a visible symptom.
- **A 1 MiB upload is ~1200 embeddings.** All of it happens inside one request,
  on CPU, and the client shows "Indexing…" with no progress. Expect tens of
  seconds on a free instance; large uploads are where a request timeout would
  show up first.
- **The 1 MiB limit is bytes, not characters.** A file of non-ASCII text reaches
  the limit at roughly a third of the character count, since most non-ASCII
  characters take 2–3 bytes in UTF-8.
- **There is no delete endpoint and no deduplication.** Uploading the same file
  twice yields two documents, and removing one means SQL — the project's
  documentation records the exact statements to use.
- **A single enormous unbroken line** (a minified file, a very long URL) has no
  separator to split on, so it is cut at 1000 characters regardless of meaning.

## Questions this invites

**Why is the document stored twice — once whole, once as chunks?**
They answer different questions. `documents.content` is the original, returned
verbatim by the MCP `get_document` tool; `chunks` is the searchable index. Chunk
text carries overlap and loses formatting, so it cannot reconstruct the original.

**What is actually returned to the client after an upload?**
`{ id, filename, chunkCount, createdAt }` with a `201`. Not the content, and not
the vectors.

**Why does the client validate the file at all if the server does?**
To avoid uploading a file that will obviously be rejected — the checks are
duplicated deliberately, and the server remains the authority. The client's copy
lives in `src/api/documents.ts` and covers exactly the three things knowable from
the `File` object alone: name, type by extension, and size.

**Where would a retry or a background job go?**
Between step 5 and the return. The natural shape is: insert the document, enqueue
a job, answer `202`, and let a worker split and embed — which is precisely why
`ingestDocument` takes its dependencies as arguments instead of reaching for
globals.

**What happens to the vectors if two documents contain overlapping text?**
Nothing special: each chunk belongs to one document and retrieval may return
both. Relevance is a property of the question, not of uniqueness of the text.

## Related

- [Embeddings](03-embeddings.md) — what `addDocuments` calls underneath.
- [Database and schema](02-database-and-schema.md) — the two tables and the
  explicit two-statement delete.
- [Retrieval and relevance](05-retrieval-and-relevance.md) — how chunks are found
  again after this.
- [MCP endpoint](08-mcp-endpoint-and-shared-tools.md) — `get_document`, the one
  reader of the stored original text.
