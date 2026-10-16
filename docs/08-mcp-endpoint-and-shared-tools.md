# 8. MCP endpoint and shared tool definitions

> `search_documents` and `get_document` over MCP Streamable HTTP, served from the
> same definitions the answering pipeline calls — and the one place the two
> policies deliberately differ.

## What it does

Exposes the retrieval services to any MCP client at `POST /mcp`, using the
official Streamable HTTP transport. Two tools, no sessions, no auth:

- `search_documents({ query, limit? })` — ranked chunks with filename, chunk
  index, relevance, and content.
- `get_document({ documentId })` — one document's metadata plus its full
  original content.

## How it works

### The definitions live in one file

`src/rag/tools.ts` holds both tools. It is short, and every part of it is
load-bearing:

```ts
const searchDocumentsInput = z.object({
  query: z.string().min(1).describe("Natural-language search query"),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional()
    .describe(`Maximum number of chunks to return (default ${DEFAULT_SEARCH_LIMIT})`),
});

export const searchDocumentsTool = {
  name: "search_documents",
  title: "Search documents",
  description: "Semantic search over the indexed documents. Returns the best-matching " +
    "chunks with filename, chunk index, relevance, and content.",
  inputSchema: searchDocumentsInput,
  /**
   * Ranked hits, unfiltered. A relevance floor is the answering pipeline's
   * decision, not the tool's: an MCP client asking for the best matches gets
   * them whether or not they clear an answering threshold.
   */
  run: (input: SearchDocumentsInput, deps: SearchDeps): Promise<SearchHit[]> =>
    searchDocuments(input.query, { limit: input.limit }, deps),
};

export const getDocumentTool = {
  name: "get_document",
  title: "Get document",
  description: "Fetch one indexed document by id: metadata plus the full original content.",
  inputSchema: getDocumentInput,   // { documentId: string }
  run: (input, deps: { pool: Pool }): Promise<IndexedDocument | null> =>
    getDocument(deps.pool, input.documentId),
};
```

Each definition carries four things: a `name` a client calls, the Zod
`inputSchema` (which becomes the tool's JSON Schema over the wire *and* the
validator), a description the client's model reads, and a `run` that is the real
implementation. There is no adapter object and no second copy.

Three consequences follow directly from putting them here:

1. **The answering pipeline calls `searchDocumentsTool.run`** in
   `answer.ts`'s `defaultDeps`, so the pipeline and an MCP client exercise the
   same retrieval function.
2. **The trace names the tool from the definition** — `searchDocumentsTool.name`,
   not a literal — so the name in the UI is by construction the name a client
   calls.
3. **The schema bound is shared.** `limit` is `.max(MAX_SEARCH_LIMIT)`, the same
   constant `searchDocuments` enforces, so an MCP client asking for 500 is
   refused by validation and always by the same number.

The floor's location is the deliberate asymmetry, restated because it is easy to
misread: `searchDocuments` itself defaults `minRelevance` to `0`. The `0.35`
floor lives in the answering pipeline's `search` wrapper
([Retrieval and relevance](05-retrieval-and-relevance.md)).
`src/rag/tools.test.ts` proves it from the tool's side with a test literally
named *"returns ranked hits even when they would be below the answering
threshold"*.

### Registration and formatting

```ts
export function createMcpServer(deps: McpDeps = defaultMcpDeps()): McpServer {
  const server = new McpServer({ name: "rag-sourcebook", version: "0.1.0" });

  server.registerTool(searchDocumentsTool.name, {
    title: searchDocumentsTool.title,
    description: searchDocumentsTool.description,
    inputSchema: searchDocumentsTool.inputSchema,
  }, async (input) => {
    try {
      const hits = await searchDocumentsTool.run(input, deps.searchDeps);
      if (hits.length === 0)
        return { content: [{ type: "text" as const, text: "No matching chunks were found." }] };
      const text = hits
        .map((hit, index) =>
          `${index + 1}. ${hit.filename} (chunk ${hit.chunkIndex}, ` +
          `relevance ${hit.relevance.toFixed(3)})\n${hit.content}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      if (error instanceof SearchValidationError)
        return { content: [{ type: "text" as const, text: error.message }], isError: true };
      throw error;
    }
  });

  server.registerTool(getDocumentTool.name, { … }, async (input) => {
    const document = await getDocumentTool.run(input, { pool: deps.pool });
    if (!document)
      return { content: [{ type: "text" as const, text: `No document with id ${input.documentId}.` }],
               isError: true };
    return { content: [{ type: "text" as const, text:
      `# ${document.filename}\n\nid: ${document.id}\nindexed: ${document.createdAt}\n` +
      `chunks: ${document.chunkCount}\n\n${document.content}` }] };
  });

  return server;
}
```

The handler's job is formatting, not logic — it calls `run` and turns the result
into a text block. Three details matter:

- **Relevance is printed with `toFixed(3)`** so results line up in a terminal and
  a client's model can compare them character by character.
- **"Nothing found" is a successful result, not an error.** Zero hits is an
  answer; it is returned as normal content.
- **Validation failures are `isError: true` tool results, not thrown errors.**
  A bad argument is reported back to the calling model so it can correct itself,
  rather than becoming a transport-level failure. Unexpected errors *are*
  rethrown — bugs should not masquerade as tool feedback.

`get_document`'s output is a small Markdown header followed by the document
verbatim, so the caller sees provenance (`id`, `indexed`, `chunks`) before the
text.

### The endpoint is stateless, one server per request

```ts
export function createMcpApp(deps: McpDeps = defaultMcpDeps()): Hono {
  const allowedHosts = resolveAllowedHosts({
    MCP_ALLOWED_HOSTS: env.MCP_ALLOWED_HOSTS,
    RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  });

  const mcpApp = createMcpHonoApp(allowedHosts ? { allowedHosts } : {});

  mcpApp.all("/mcp", async (c) => {
    const server = createMcpServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: c.get("parsedBody") });
  });

  return mcpApp;
}
```

- **A fresh `McpServer` and transport per request.** `sessionIdGenerator:
  undefined` is the SDK's stateless mode: no session id is issued, no server-side
  state survives the request. That is what makes the endpoint compatible with a
  free instance that spins down and with any future horizontal scaling — there
  is nothing to lose between requests.
- **`createMcpHonoApp()` provides the plumbing** (body parsing, host validation)
  and this file supplies the handler. The `declare module "hono"` augmentation at
  the top of the file exists because that package stashes the parsed JSON body on
  the Hono context without widening the context type itself.
- **`parsedBody` is passed through explicitly** so the transport does not have to
  read a body that has already been consumed.

### Host-header validation

```ts
export function resolveAllowedHosts(source: {
  MCP_ALLOWED_HOSTS?: string; RENDER_EXTERNAL_HOSTNAME?: string;
}): string[] | undefined {
  const configured = (source.MCP_ALLOWED_HOSTS ?? "")
    .split(",").map((host) => host.trim()).filter((host) => host.length > 0);
  if (configured.length > 0) return configured;

  const platformHostname = source.RENDER_EXTERNAL_HOSTNAME?.trim();
  return platformHostname && platformHostname.length > 0 ? [platformHostname] : undefined;
}
```

The MCP integration rejects requests whose `Host` header is not on an allow list —
DNS-rebinding protection for a protocol that a local agent may reach through a
browser-adjacent runtime. Precedence:

| Situation | Allowed hosts |
| --- | --- |
| `MCP_ALLOWED_HOSTS` set | that comma-separated list, trimmed, blanks dropped |
| On Render, nothing set | the service's own `RENDER_EXTERNAL_HOSTNAME` |
| Neither | `undefined` → the integration's localhost-class default (dev) |

`src/mcp/server.test.ts` covers all four branches, including "prefers the
explicit list over the platform hostname".

### Proving it works

`scripts/mcp-smoke.ts` is a real MCP client in 38 lines: it connects, prints the
endpoint and the tool names it discovers, calls `search_documents` with the query
from `argv[2]` and a hard-coded `limit: 3`, prints the returned text blocks, and
exits non-zero on `isError`.

```sh
# local
pnpm exec tsx scripts/mcp-smoke.ts "How does pgvector store embeddings?"

# deployed
MCP_URL=https://rag-sourcebook-server.onrender.com/mcp \
  pnpm exec tsx scripts/mcp-smoke.ts "purple lantern worker deploy retries"
```

Because the script does **not** apply a relevance floor, its output is the
cleanest demonstration of the boundary: a deployed run printed the correct
document at `0.602` alongside hits at `0.117` and `0.085` — the two the
answering pipeline would discard.

## Decisions and rejected alternatives

- **One definition, two consumers.** The alternative is the common one: a service
  layer for the pipeline plus a separate MCP wrapper that repeats the schemas.
  That duplicates the knowledge of what a tool accepts and what it is called —
  and the tool name is *exactly* what the UI reports to the user, so a drift
  would be user-visible.
- **The floor stays out of the tool.** Reasoning in
  [Retrieval and relevance](05-retrieval-and-relevance.md): the floor encodes
  "don't answer without evidence", which is a policy about writing answers, not
  about searching an index.
- **Stateless Streamable HTTP, not long-lived sessions.** The deployment target
  is a process that may not exist in fifteen minutes. Sessions would make every
  request's success depend on a warm instance and would need shared storage to
  survive a restart.
- **Text content blocks rather than a custom payload.** Text is what every MCP
  client can render, and it is what the calling model reads. The formatting is
  therefore tuned for reading, not for parsing — a deliberate choice: callers who
  need structure should use the REST API, whose `retrievedChunks` are typed.
- **`get_document` returns the original content, not chunks.** The chunks are
  reconstructible and lossy; the original is what makes this tool worth having.
- **No auth on `/mcp`, and none on `/api` either.** This is a public demo whose
  corpus is public. Naming it explicitly matters, because the *absence* of auth
  is a decision, not an oversight ([Deployment](09-deployment-and-operations.md)).

## Where it can bite you

- **Anyone with the URL can read the whole corpus.** `get_document` returns full
  document text and `search_documents` returns any chunk that matches. There is
  no API key on either surface. Do not put anything private in this sourcebook.
- **The host allow list must be right off Render.** On any other platform, with
  `MCP_ALLOWED_HOSTS` unset, the integration falls back to localhost-class hosts
  and a deployed client gets rejected. The failure looks like a broken endpoint
  rather than a header check.
- **A fresh server per request re-registers both tools every time.** Cheap, but
  it means there is no place to hold per-client state, and nothing server-pushed
  (MCP notifications, subscriptions) can exist.
- **`declare module "hono"` is a global augmentation.** It widens
  `ContextVariableMap` for the whole project. That is how the package intends it,
  but it is why `c.get("parsedBody")` type-checks anywhere in the codebase.
- **The two surfaces can disagree about a passage, and that is by design.** MCP
  will show a hit at `0.117` that the chat pipeline refuses to use. Anyone
  comparing the two has to know the floor exists and where it lives, or it looks
  like an inconsistency.
- **Tool results are not truncated.** `limit` is capped at 20 chunks and a chunk
  is ~1000 characters, but `get_document` returns a whole document — up to 1 MiB.
  A client's context window is the only limit.
- **No `resources`, `prompts`, or streaming tool results.** The endpoint
  registers two tools and nothing else; adding either is a feature, not a
  configuration.

## Questions this invites

**Why does the chat pipeline not become an MCP client of its own endpoint?**
It calls the same function directly. A self-call over HTTP would add a network
hop, a second failure mode, and a dependency on the service's own reachability,
to reach code that is already in the process. The shared *definition* is what
matters; the transport is irrelevant.

**Why is `limit` bounded in the schema as well as in the search function?**
The schema is what the client's model sees, so a bounded schema prevents the bad
call from being made at all. The function's check is the backstop for callers that
bypass validation. Neither is redundant: one is a contract, one is an invariant.

**Why `isError: true` instead of throwing for a bad argument?**
Because the calling model can read a tool error and try again — that is the MCP
feedback loop. A thrown error terminates the request and teaches the caller
nothing about what it did wrong.

**What does a client actually receive for `search_documents`?**
One text block: numbered hits, each a line of `filename (chunk N, relevance
0.602)` followed by the chunk's text, separated by blank lines. No JSON, no
structured fields.

**What is the smallest change that would add authentication?**
A token check on the Hono sub-app before `transport.handleRequest` — the
transport is handed `c.req.raw`, so a guard that returns 401 early protects the
MCP surface without touching the tool definitions.

**How would a third tool be added?**
Define it in `src/rag/tools.ts` with name, schema, description, and `run`, then
register it in `createMcpServer` with its formatting. Anything the answering
pipeline should trace would call the same `run`.

## Related

- [Retrieval and relevance](05-retrieval-and-relevance.md) — why the floor is not
  here.
- [Grounded answering](06-grounded-answering.md) — the other consumer, which
  traces the name defined here.
- [Deployment and operations](09-deployment-and-operations.md) — the production
  hostname and how it reaches `resolveAllowedHosts`.
