# 5. Retrieval and relevance

> Semantic search over chunks, a normalized score a person can read, and the one
> threshold that decides whether a question gets answered at all.

## What it does

Given a question, embeds it, asks pgvector for the nearest chunk vectors, and
returns them ranked with their source (`filename`, `chunkIndex`) and a relevance
score normalized so that **larger means more relevant**. It does not decide what
counts as good enough to answer — that is a separate decision made by the
answering pipeline.

## How it works

```ts
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
export const RELEVANCE_THRESHOLD = 0.35;

export async function searchDocuments(query, options = {}, deps = defaultDeps()): Promise<SearchHit[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) throw new SearchValidationError("query must not be empty");

  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT)
    throw new SearchValidationError(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);

  const minRelevance = options.minRelevance ?? 0;

  const store = await deps.getVectorStore();
  const results = await store.similaritySearchWithScore(trimmedQuery, limit);

  const hits: SearchHit[] = [];
  for (const [document, distance] of results) {
    const { documentId, filename, chunkIndex } = document.metadata;
    if (typeof documentId !== "string" || typeof filename !== "string" || typeof chunkIndex !== "number")
      continue;                                   // a row not written by this app's ingestion

    const relevance = 1 - distance;
    if (relevance < minRelevance) continue;

    hits.push({ documentId, filename, chunkIndex, content: document.pageContent, relevance });
  }
  return hits;
}
```

Read in order, the function does five things:

1. **Trims, then rejects an empty query.** Whitespace is not a question.
2. **Bounds the limit** to `1..20`, throwing rather than clamping. A caller that
   asked for 500 results has a bug, and silently returning 20 would hide it.
3. **Asks the store for the nearest vectors.** `similaritySearchWithScore`
   returns `[Document, distance]` pairs ordered by ascending distance, so index 0
   is the best match. The store's default distance strategy is cosine, which is
   what makes the next step valid.
4. **Turns distance into relevance:** `relevance = 1 - distance`. Cosine distance
   runs 0 (identical direction) to 2 (opposite); after the conversion, 1 is a
   perfect match and 0 is orthogonal. This is the "normalize so larger is more
   relevant" rule from the plan, applied at the one place the numbers are read.
5. **Filters by `minRelevance` and drops unreadable rows.** A chunk whose
   metadata is missing one of the three keys is skipped rather than guessed at —
   it was not written by this application's ingestion, so its provenance cannot
   be reported honestly.

### Where the 0.35 comes from

```ts
// Calibrated against three answerable and three unrelated questions over the
// seeded corpus (search.test.ts): answerable top scores were 0.64-0.74,
// unrelated ones 0.01-0.10. 0.35 sits mid-gap.
export const RELEVANCE_THRESHOLD = 0.35;
```

That is a measurement, not a guess, and `src/rag/search.test.ts` re-runs it: the
test seeds a three-document corpus (`pgvector.md`, `espresso.md`, `eclipses.txt`),
asks three answerable questions and three unrelated ones, and asserts the top hit
for each answerable question is the right file while every unrelated question
filters down to **zero** hits.

### The floor is the pipeline's decision, not the tool's

This is the single most important boundary in the retrieval code:

```ts
// src/rag/answer.ts
function defaultDeps(): AnswerDeps {
  return {
    search: async (input) => {
      const hits = await searchDocumentsTool.run(input, { getVectorStore });
      return hits.filter((hit) => hit.relevance >= RELEVANCE_THRESHOLD);
    },
    getModel: getChatModel,
  };
}
```

`searchDocuments` itself defaults `minRelevance` to `0` and returns everything
ranked. The `0.35` floor is applied one layer up, inside the answering pipeline.
That is why the same function can serve two consumers with different policies:

| Consumer | Policy | Why |
| --- | --- | --- |
| Answering pipeline (`POST /api/chat`) | Hits below 0.35 are discarded; no hits means abstain, no model call | The project's rule is a grounded answer or an explicit "I couldn't find it" |
| MCP `search_documents` | No floor — the ranked hits, whatever they scored | An MCP client is a developer inspecting the index; they decide what is good enough |

The practical consequence is visible in `scripts/mcp-smoke.ts` output: a query
that scores `0.602` for the right document also returns hits at `0.117` and
`0.085` — the script asks for three, and both of the weak ones are in the result
set the answering pipeline would have emptied.

## Decisions and rejected alternatives

- **Normalize to "larger is better" at the boundary.** pgvector's cosine distance
  is 0-is-best, which inverts every comparison anyone writes afterwards. Doing
  the flip once, where the raw pairs are destructured, means everything
  downstream (the threshold, the UI's relevance column, the trace) shares one
  direction.
- **Throw on an out-of-range limit instead of clamping.** See above: silent
  clamping converts a caller bug into a mystery.
- **Skip rows with unknown metadata instead of failing the search.** A single
  odd row should not break retrieval for every other document. The cost is
  silence, which is noted under "where it can bite you".
- **A per-hit floor rather than "keep the top N"**. Filtering each hit means a
  weak question can legitimately produce zero evidence — which is the point. A
  "keep the best 3" rule would always hand the model three passages, including
  ones that have nothing to do with the question, and the model would then be
  asked to answer from noise.
- **No hybrid search, no reranking, no HNSW index.** All three are listed as out
  of scope for this project. A reranker in particular would mean a second model
  and a second latency budget for a demo corpus small enough to rank exactly.
- **`DEFAULT_SEARCH_LIMIT = 5`.** Five chunks is enough evidence for a
  three-sentence answer and keeps the prompt small; `MAX_SEARCH_LIMIT = 20`
  bounds what a single request can put in front of the model.

## Where it can bite you

- **The threshold is phrasing-sensitive, and this has been observed.** During
  verification, "How long does a sleeping Render instance take to wake up?"
  scored **0.280** against a document that answers it, so it abstained — an
  in-scope question lost to wording rather than to missing content. Embedding
  similarity measures closeness of meaning *as phrased*, not whether an answer
  exists.
- **The calibration is only as broad as its corpus.** Three short documents with
  clearly separated topics produce a wide gap (0.64+ versus 0.10-). A larger
  corpus with overlapping topics compresses that gap, and 0.35 would then be
  wrong in both directions. Re-run the calibration test if the corpus changes
  character.
- **`relevance = 1 - distance` assumes normalized vectors and cosine distance.**
  Both hold here ([Embeddings](03-embeddings.md)); a different distance strategy
  or an unnormalized vector would make the number, and the threshold, meaningless.
- **Malformed metadata rows are dropped in silence.** If a chunk is ever inserted
  by another tool, it simply never appears in results and nothing logs why.
- **Zero hits means no model call at all.** That is the desired behaviour for the
  answering pipeline, but it also means the threshold doubles as the "is this
  question answerable" classifier — a single number standing in for a decision
  that a real system might separate.

## Questions this invites

**Why is relevance a subtraction rather than a similarity function?**
Because pgvector ranks by *distance*, and `similaritySearchWithScore` exposes
that. `1 - distance` converts it to the direction the rest of the code and the
UI assume, in one place, instead of at every comparison.

**Why does MCP not apply the 0.35 floor?**
Because the floor is an *answering* policy — "don't write an answer without
evidence". An MCP client is inspecting the index, not asking for a written
answer, so hiding hits below a threshold would be withholding data the caller can
interpret. It is deliberately possible for MCP search and `POST /api/chat` to
disagree about a passage: one surfaces it, the other refuses to use it.

**What would you change if retrieval quality were the complaint?**
In order of cost: lower the threshold (cheap, raises false positives), increase
the limit so the model sees more candidates (cheap, costs tokens), add a
reranker (a second model and a real latency budget), or move to hybrid BM25 +
vector (a schema change to store the lexical index). The measurement to justify
any of them is the same calibration test that produced 0.35.

**Why is `minRelevance` a parameter at all if only one caller uses a non-zero
value?**
Because it is the tool's own API surface: the MCP path uses the default `0`, the
pipeline passes nothing and filters above, and the test passes `RELEVANCE_THRESHOLD`
directly to prove the calibration. It is the seam that keeps the number out of
the search function itself.

**What stops a caller asking for 500 chunks?**
`MAX_SEARCH_LIMIT` — and the same bound is declared in the tool's Zod schema, so
an MCP client is refused by schema validation before the handler runs
([MCP endpoint](08-mcp-endpoint-and-shared-tools.md)).

## Related

- [Embeddings](03-embeddings.md) — why the vectors are normalized.
- [Grounded answering](06-grounded-answering.md) — the consumer that applies the
  floor and abstains.
- [MCP endpoint and shared tools](08-mcp-endpoint-and-shared-tools.md) — the
  consumer that does not.
