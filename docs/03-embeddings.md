# 3. Embeddings

> Text to vectors, computed in-process with Transformers.js — no embedding API,
> no per-token cost, and one 384-number contract shared by the schema, the store,
> and retrieval.

## What it does

Turns a string into a normalized 384-dimension float vector, locally. It is used
in exactly three places: embedding chunks during ingestion, embedding the query
during search, and the throwaway probe that tells the vector store its own
dimension.

## How it works

`src/rag/embeddings.ts` is a thin adapter over a Transformers.js pipeline, in the
shape LangChain expects:

```ts
export class LocalEmbeddings extends Embeddings {
  private readonly model: string;
  private extractorPromise?: Promise<FeatureExtractionPipeline>;

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedDocuments([text]);
    if (!embedding) throw new Error("embedding model returned no vector");
    return embedding;
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    this.extractorPromise ??= pipeline("feature-extraction", this.model);
    return this.extractorPromise;
  }
}
```

Four decisions are visible in those twenty lines:

1. **`extractorPromise ??=` — load the model once, lazily.** The pipeline is
   created on first use and the *promise* is cached, not the resolved value, so
   concurrent first requests share one load instead of racing to build several.
2. **`pooling: "mean", normalize: true`** — every token vector in the sequence
   is averaged into one sentence vector, then L2-normalized. This is how
   sentence-transformers models are meant to be used, and it is what makes the
   cosine distance the store computes meaningful.
3. **`embedQuery` delegates to `embedDocuments`.** One code path, so a query can
   never be embedded differently from a chunk. The alternative — a separate
   single-text call — would be the obvious place for the two to drift.
4. **The model name comes from `env.EMBEDDING_MODEL`,** defaulting to
   `Xenova/all-MiniLM-L6-v2`.

### The dimension probe

`src/rag/vector-store.ts` asks this class for its width rather than hard-coding
it ([Database and schema](02-database-and-schema.md)):

```ts
const dimensions = (await localEmbeddings.embedQuery("dimension probe")).length;
```

The probe is not free — it loads the model — but it runs once per process, and
in exchange no number is written down twice.

### Warming the model at build time

`scripts/warm-model.ts` is nine lines:

```ts
const model = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
await pipeline("feature-extraction", model);
console.log(`embedding model ready: ${model}`);
```

`render.yaml` runs it as the last step of the build
(`pnpm install --prod=false && pnpm build && pnpm warm-model`). Without it, the
first request after a cold start would spend ~100 MB of download before it could
embed anything. With it, the weights are already on disk in the deployed
container's cache, and the first request pays only for loading them into memory.

### Why the install scripts are blocked

`pnpm-workspace.yaml` blocks three postinstall scripts:

```yaml
allowBuilds:
  esbuild: false
  onnxruntime-node: false
  protobufjs: false
```

`onnxruntime-node` and `protobufjs` are dependencies of Transformers.js, and both
normally run install scripts to fetch or compile native artifacts. This project
verified — in Node, with the real model — that MiniLM loads and produces a
384-dimension normalized embedding without them, so the scripts are blocked to
keep installs fast and reproducible. The comment in the file records that
verification; the decision becomes wrong the moment a *different* model needs the
native runtime path, and that is where to look first if loading breaks.

## Decisions and rejected alternatives

- **Local embeddings over an embedding API.** The constraints rule out a paid
  embeddings provider, and a free one would add a second vendor key, a second
  rate limit, and a second region-block risk to a project that already had one
  provider switch forced on it (see the provider history in `../PLAN.md`). The
  cost of the local choice is a ~100 MB model, CPU time per embedding, and a
  build step.
- **A LangChain `Embeddings` subclass rather than calling the pipeline
  directly.** `PGVectorStore` requires an `Embeddings` instance; the subclass is
  the seam that lets ingestion and search share one implementation.
- **Throw on an empty vector.** `embedQuery` failing loudly is better than
  returning `[]`, which would reach pgvector as a dimension error somewhere
  further from the cause.
- **No caching layer for repeat embeddings.** Ingestion embeds each chunk once
  and stores the vector; search embeds one short query per request. A cache would
  optimise a cost that is not currently the bottleneck.

## Where it can bite you

- **The first embedding after a cold start loads the model into memory,** which
  takes seconds on a free instance even with the weights cached. That is the
  dominant part of the first request's latency, not the SQL.
- **Every concurrent request shares one pipeline.** Transformers.js sessions are
  not documented as re-entrant here; at demo concurrency this is untested, and
  if requests are ever serialized in production, this is why.
- **Changing `EMBEDDING_MODEL` is a migration, not a config change.** The column
  is `vector(384)`; a different width fails on insert. Same width but a different
  model would silently mix incompatible vectors in one table, which is worse —
  it needs a re-index.
- **`Xenova/all-MiniLM-L6-v2` is trained mostly on English text.** Retrieval
  quality on a corpus in another language is not measured by this project, and
  the relevance numbers it produces for such text should not be trusted to mean
  the same thing.
- **The vector is normalized, so relevance is cosine similarity.** Anything that
  bypasses this class and inserts an unnormalized vector makes
  `1 - distance` incomparable with the threshold in
  [Retrieval and relevance](05-retrieval-and-relevance.md).

## Questions this invites

**Why compute embeddings locally instead of calling a provider?**
Cost and availability: the free-tier constraint forbids a paid embedding API, and
the project already lost one chat provider to a regional block. Local embeddings
remove a dependency rather than adding one — at the price of a model download and
CPU time.

**Why is the model an environment variable if changing it requires a re-index?**
Because pinning it in code would not make the migration safer; it would only hide
the fact that the value is part of the data's identity. As a variable, the
deployed model and the schema can be checked against each other in one place.

**What does `normalize: true` actually buy?**
It makes cosine similarity and dot product agree, and it keeps `1 - distance`
inside a stable range, so a threshold calibrated once (0.35) keeps its meaning
across queries. Without normalization, the same threshold would be comparing
vectors of different magnitudes.

**Where is the "384" written down?**
Twice, deliberately: in `schema.sql` as `vector(384)` for the database to
enforce, and implicitly by the probe in `vector-store.ts`. Test
`ingest.test.ts` ("stores 384-dimension normalized vectors for every chunk")
asserts the vectors that actually land in the table match.

## Related

- [Database and schema](02-database-and-schema.md) — the `vector(384)` column and
  why the dimension is not hard-coded in code.
- [Document ingestion](04-document-ingestion.md) — the write path.
- [Retrieval and relevance](05-retrieval-and-relevance.md) — the read path, and
  where the vectors become a number a person can read.
- [Deployment and operations](09-deployment-and-operations.md) — the build-time
  warm-up in context.
