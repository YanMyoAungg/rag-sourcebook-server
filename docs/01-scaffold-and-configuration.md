# 1. Scaffold and configuration

> How a request enters the process, what the environment contract is, why CORS
> is restricted to one origin, and how shutdown releases the pools.

## What it does

Creates the Node process, the Hono application, and the rules every request
passes through:

- The process refuses to start on invalid configuration (fail fast).
- `/api/*` accepts browser requests from exactly one origin.
- `/api/health` answers a liveness probe.
- Unmatched paths and unexpected errors return JSON, never HTML.
- `SIGINT`/`SIGTERM` closes the HTTP server and both database pools before exit.

## How it works

1. **`src/index.ts`** imports the app and calls `serve({ fetch: app.fetch, port: env.PORT })`
   from `@hono/node-server`. Node's HTTP server is created and, once listening,
   logs the port it bound.
2. Any module that imports `src/config/env.ts` triggers environment validation.
   `import "dotenv/config"` loads `.env` in development; then `envSchema.parse(process.env)`
   runs. Zod either returns a fully-typed `env` object or throws at import time.
3. **`src/app.ts`** builds the request pipeline:
   `cors` on `/api/*` → `/api/health` → documents router → chat router → MCP
   sub-app at `/` → `notFound` → `onError`.
4. A shutdown handler guards against re-entry with a `shuttingDown` flag, stops
   accepting connections with `server.close`, then waits for
   `closeVectorStore()` and `pool.end()` with `Promise.allSettled`, then exits 0.

### Key files

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Serve the app, wire signal handlers, release resources on exit. |
| `src/config/env.ts` | The environment contract, validated once at import. |
| `src/app.ts` | Middleware order, route mounting, JSON 404 and 500 handlers. |
| `src/app.test.ts` | Proves the health route, the allowed origin, other origins, and preflight. |
| `package.json` | `dev`, `build`, `start`, `test`, `typecheck`, `warm-model` scripts. |
| `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` | Compile and test settings. |

### The environment contract

```ts
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default("postgresql://localhost:5432/rag_sourcebook"),
  CLIENT_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  EMBEDDING_MODEL: z.string().min(1).default("Xenova/all-MiniLM-L6-v2"),
  // Chat generation goes through any OpenAI-compatible endpoint, so no
  // provider is baked in as a default: unset values mean chat answers report
  // "not configured" (503) until a provider is configured.
  CHAT_BASE_URL: z.string().optional(),
  CHAT_API_KEY: z.string().optional(),
  CHAT_MODEL: z.string().optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
});
```

The `CHAT_*` values are optional on purpose. A server with no generation
configured still ingests documents, still serves retrieval, and still exposes
MCP — it answers chat with `503` and a message naming the three variables it
needs. That is a working state, not a crash.

### One allowed origin

```ts
app.use("/api/*", cors({
  origin: env.CLIENT_ORIGIN,
  allowMethods: ["GET", "POST", "OPTIONS"],
}));
```

`CLIENT_ORIGIN` is a single origin, not a list. The browser sends an `Origin`
header on cross-origin requests; Hono's `cors` echoes the configured value when
it matches and omits the header otherwise. `src/app.test.ts` asserts both
directions: the configured origin is echoed, `https://evil.example` is not, and
the preflight for `POST` is answered with the allowed methods.

### Failure handlers

```ts
app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((error, c) => {
  console.error("unhandled request error", error);
  return c.json({ error: "internal server error" }, 500);
});
```

The error is logged with its stack for the operator and replaced with a generic
message for the caller. Nothing internal is echoed back.

### Clean shutdown

```ts
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    void Promise.allSettled([closeVectorStore(), pool.end()]).finally(() => {
      process.exit(0);
    });
  });
};
```

There are two pools to release (see [Database and schema](02-database-and-schema.md)),
and one of them is held by the vector store, so it is closed first. `allSettled`
rather than `all`: a pool that is already closed must not prevent the process
from exiting.

## Decisions and rejected alternatives

- **Hono over Express or Fastify.** The MCP TypeScript SDK ships a Hono
  integration and the transport is built on Web-standard `Request`/`Response`.
  Hono is that model natively, so `app.fetch` can be handed straight to both
  `@hono/node-server` and the MCP transport.
- **Validate the environment at import, not at first use.** A deploy with a
  malformed value dies during boot, which Render reports as a failed deploy. The
  alternative — lazy reads scattered through the code — turns a typo into a 500
  on the one request that happens to need that value.
- **Zod for the environment as well as for requests.** One validation library
  for both, and the parsed object is the only way the rest of the code reads
  configuration, so no `process.env` lookups leak into business logic.
- **A single `CLIENT_ORIGIN` instead of a list.** Only one browser app consumes
  this API. The cost is real and worth naming: each Vercel *preview* deployment
  has its own origin, so previews are refused by CORS until `CLIENT_ORIGIN` is
  pointed at them. Production (the alias) is stable, so it works there.
- **No request logger.** Render captures stdout; the two routes that matter
  (`chat`, `documents`) log failures explicitly with context instead of logging
  every request.

## Where it can bite you

- **ESM with `NodeNext` requires explicit `.js` extensions** in relative
  imports (`./config/env.js` for `./config/env.ts`). Omitting one is a *compile*
  error (`TS2835`: relative import paths need explicit file extensions under
  `node16`/`nodenext` resolution), so `pnpm typecheck` catches it before a build
  ever runs.
- **Two tsconfigs.** `tsconfig.json` includes `src` **and** `scripts` and is what
  `pnpm typecheck` runs (`tsc --noEmit`). `tsconfig.build.json` extends it,
  narrows `rootDir` to `src`, and excludes `*.test.ts`, so the shipped `dist/`
  contains no tests.
- **CORS covers `/api/*` only.** `/mcp` is not called by browsers, and the MCP
  integration enforces its own host-header validation instead
  ([MCP endpoint](08-mcp-endpoint-and-shared-tools.md)).
- **`process.exit(0)` in the shutdown handler** means an in-flight request is cut
  off once `server.close`'s callback fires. Acceptable for a demo; a real
  deployment would add a drain window.
- **The `PORT` default of 3000** is local convenience. Render injects `PORT`
  itself, and the deployed service logs whatever it was given.

## Questions this invites

**Why does the health route exist at all?**
It is the platform's liveness probe: `render.yaml` sets
`healthCheckPath: /api/health`, so Render uses it to decide whether a deploy is
live, and it is the cheapest way to check a cold instance from a terminal.

**Why can't `CHAT_API_KEY` be a required variable?**
Because a missing key is a degraded but coherent state: retrieval, ingestion, and
MCP all still work. Requiring it would make it impossible to run the server as a
pure retrieval service, and would turn a key rotation into a startup failure.

**What happens if the embedding model is not in the local cache on a cold start?**
Transformers.js downloads ~100 MB from the Hugging Face Hub on first use. That is
why the build runs `pnpm warm-model`
([Embeddings](03-embeddings.md)).

**Why is `app.request()` used in tests instead of starting a server?**
Hono's `app.request(path)` runs the real pipeline in-process — middleware, CORS
headers, routing, handlers — without binding a port, so the CORS assertions are
testing the same code path a browser hits.

## Related

- [Database and schema](02-database-and-schema.md) — the pools released on shutdown.
- [Chat API and event streaming](07-chat-api-and-event-streaming.md) — why the
  500 handler rarely fires.
- [Deployment and operations](09-deployment-and-operations.md) — where each of
  these variables is set in production.
