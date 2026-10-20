# 9. Deployment and operations

> Render free web service plus Neon free PostgreSQL: what the blueprint declares,
> every environment variable, why the build warms the embedding model, and the
> limits a free tier imposes on the design.

## What it does

Runs the server in production at
**<https://rag-sourcebook-server.onrender.com>** with a database on Neon and
generation on OpenRouter's free tier. Total cost: zero. The price is paid in cold
starts and quotas, and this document names all of them.

## How it works

### The blueprint

`render.yaml` is committed, so the service is created from it rather than clicked
together:

```yaml
services:
  - type: web
    name: rag-sourcebook-server
    runtime: node
    plan: free
    buildCommand: pnpm install --prod=false && pnpm build && pnpm warm-model
    startCommand: node dist/index.js
    healthCheckPath: /api/health
    envVars:
      - key: DATABASE_URL
        sync: false
      - key: CHAT_API_KEY
        sync: false
      - key: CLIENT_ORIGIN
        sync: false
      - key: CHAT_BASE_URL
        value: https://openrouter.ai/api/v1
      - key: CHAT_MODEL
        value: nvidia/nemotron-3.5-lightning:free
      - key: EMBEDDING_MODEL
        value: Xenova/all-MiniLM-L6-v2
```

Line by line:

- **`pnpm install --prod=false`** — the build needs devDependencies. `tsc` is
  one, and `pnpm warm-model` runs through `tsx`, which is another. Without this
  flag the build step would have no compiler.
- **`pnpm build`** — `tsc -p tsconfig.build.json`, producing `dist/` with no
  test files in it.
- **`pnpm warm-model`** — downloads the embedding model during the build. See
  below; this is the single most valuable line for user-visible latency.
- **`node dist/index.js`** — runs compiled JavaScript, not `tsx`, so the start
  path has no transpiler in it.
- **`healthCheckPath: /api/health`** — Render calls it to decide whether a
  deploy is live. A deploy that boots with bad configuration fails here, which is
  the payoff for validating the environment at import time
  ([Scaffold and configuration](01-scaffold-and-configuration.md)).
- **`sync: false`** — the value is a secret, so Render prompts for it on first
  apply and never reads it from the repository.

### The environment in production

| Variable | Production value | Set where |
| --- | --- | --- |
| `PORT` | injected by Render | platform |
| `DATABASE_URL` | `postgresql://…@…neon.tech/neondb?sslmode=require` | Render dashboard (secret) |
| `CLIENT_ORIGIN` | `https://rag-sourcebook-client.vercel.app` | Render dashboard (secret) |
| `CHAT_BASE_URL` | `https://openrouter.ai/api/v1` | `render.yaml` |
| `CHAT_API_KEY` | an OpenRouter key | Render dashboard (secret) |
| `CHAT_MODEL` | `nvidia/nemotron-3.5-lightning:free` | `render.yaml` |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | `render.yaml` |
| `MCP_ALLOWED_HOSTS` | not set | `RENDER_EXTERNAL_HOSTNAME` is used automatically |

Locally the same names live in `.env`, created from `.env.example`; that file is
untracked and `chmod 600`, and the committed example carries every key with a
blank or local value. The production values never exist in the repository —
`sync: false` is what enforces that.

### One-time setup, in order

1. **Neon** — create a project and copy the connection string
   (`postgresql://…?sslmode=require`). `sslmode=require` is what makes `pg` open
   a TLS connection; without it Neon refuses the connection.
2. **GitHub** — push the repository.
3. **Render** — create a Blueprint from the repository. Render reads
   `render.yaml`, prompts for the three `sync: false` values, and builds.
4. **Schema** — apply it once against Neon:
   `psql "postgresql://…?sslmode=require" -f src/db/schema.sql`. There is no
   migration tool and no deploy-time schema step; this is a manual, one-time
   action, and any later schema change is another manual action (see below).
5. **Client origin** — once the Vercel deployment exists, set `CLIENT_ORIGIN` to
   its origin and redeploy (or edit the variable; Render restarts on change).
6. **Verify** — see the probes below.

### Why the build warms the model

`scripts/warm-model.ts` runs `pipeline("feature-extraction", model)` and exits.
Its purpose is to move a ~100 MB download from the first request after every cold
start into the build ([Embeddings](03-embeddings.md)). The build's filesystem is
the one the service runs from, so the downloaded weights are on disk when the
process starts; without the step, the first question after a spin-down would wait
for a download as well as a process start.

If a future platform built and ran in separate filesystems, this line would
silently become decoration — worth knowing when reading it.

### Verification probes

Each one observes something the design claims:

```sh
# 1. Liveness (also what Render's health check calls)
curl -s https://rag-sourcebook-server.onrender.com/api/health

# 2. The streaming route's guard, before any stream opens
curl -s -X POST https://rag-sourcebook-server.onrender.com/api/chat/stream \
  -H 'content-type: application/json' -d '{}'
# → {"error":"request body must be JSON { question: string }"}

# 3. The library the database actually holds
curl -s https://rag-sourcebook-server.onrender.com/api/documents

# 4. Incremental delivery, not a buffered response
curl -sN -X POST https://rag-sourcebook-server.onrender.com/api/chat/stream \
  -H 'content-type: application/json' \
  -d '{"question":"how are chunk vectors stored?"}'
# → a `tool … running` frame within ~1 s, then deltas, then finish

# 5. The MCP surface
MCP_URL=https://rag-sourcebook-server.onrender.com/mcp \
  pnpm exec tsx scripts/mcp-smoke.ts "chunk vectors"
```

Probe 4 is the one that proved Render's proxy does not buffer the SSE response:
the `tool` frame and later the `text-delta` frames arrived separately, with the
first delta seconds after the tool completed.

### Cost control

Free tiers, and what each limit means for behaviour:

| Limit | Value | Consequence in this design |
| --- | --- | --- |
| Render web service | free plan, spins down after ~15 min idle | The next request takes about a minute to wake the instance. |
| Render request handling | no persistent disk | Nothing may be written that must survive a restart; the corpus lives in Neon. |
| Neon | free project tier | Plenty for a demo corpus; the schema is two small tables. |
| OpenRouter free models | 20 requests/minute, 50/day | Shared between the deployed service and any local run using the same key. A one-time $10 credit raises the daily cap to 1000. |
| OpenRouter free terms | prompts may be logged and used for training | Nothing confidential belongs in the corpus. |

Abstention is the design's main cost control: a question that matches nothing
above the relevance floor makes **no** provider call at all, so off-topic traffic
cannot burn the daily quota.

## Decisions and rejected alternatives

- **Render, not a container platform or a serverless host.** The service needs a
  long-lived process with an in-memory embedding model; a request-scoped
  serverless function would reload the model constantly. Render's free tier
  provides exactly that shape.
- **Neon, not a Render-managed database.** Neon's free tier is permanent rather
  than trial-based, supports `pgvector`, and gives an external `psql` connection
  for the one-time schema step.
- **A replaceable connection for the vector store.** `PGVectorStore` holds one
  client for the process's lifetime and calls `end()` on the pool it was given
  ([Database and schema](02-database-and-schema.md)); Neon closes idle
  connections when its compute suspends, and a pooler may recycle one sooner. A
  lost connection drops the cached store and logs it, and the next request opens
  a fresh one — it is not treated as fatal. The application `pool` still opens
  and closes connections as needed.
- **Pin the model in `render.yaml`, keep the key a secret.** The model id is not
  sensitive and belongs in reviewable configuration; the key is only ever in the
  dashboard.
- **A pinned model rather than a router id.** `openrouter/free` picks a different
  model per request, which makes answers non-reproducible and hides which model
  produced a bad one. `README.md` records this explicitly.
- **Manual schema application.** With two tables and no migration tool, a
  `psql -f` step is honest and reviewable. A migration framework would be more
  machinery than the schema has ever needed — at the cost that a schema change
  is a remembered manual step, not an automated one.
- **No authentication.** Public demo, public corpus. Stated plainly rather than
  implied, because the MCP endpoint exposes whole document contents.

## Where it can bite you

- **A cold start is a real user experience.** ~15 minutes idle means the next
  visitor waits about a minute: container start, then loading a ~100 MB model
  from disk, then the answer. The health check is the cheapest way to wake it
  deliberately before demonstrating.
- **A deploy restarts the process.** Everything in memory goes: the cached model
  (reloaded on first use) and the cached `ChatOpenAI` client. Nothing else —
  there is no in-memory state that matters, which is the benefit of the stateless
  design.
- **The daily quota is shared.** 50 requests/day on the free tier covers the
  deployed service *and* local runs on the same key, and every grounded question
  costs one. Exhausting it turns every answer into a 502 (`answer generation
  failed`) while retrieval and MCP keep working.
- **A schema change ships nothing.** Editing `src/db/schema.sql` changes what new
  environments get; the running Neon database is only updated by running the SQL
  by hand. There is no `pnpm migrate` to forget, but there is also no alarm if
  the deployed schema and the repository diverge.
- **No backup story beyond Neon's own.** Deletion is `DELETE FROM` by hand
  ([Database and schema](02-database-and-schema.md)); there is no undo in this
  project.
- **A branch change in the Render dashboard is invisible from here.** The service
  builds whatever branch it is configured to track; `main` carries the shipped
  code, and a mismatch would look like "the deploy is stale" with no error.
- **The client's origin is a hard-coded string on the server.** A Vercel preview
  deployment has a different origin and is refused by CORS until `CLIENT_ORIGIN`
  is updated. Production (the alias) is stable, which is why this trade-off was
  acceptable.

## Questions this invites

**Why is the health check path the same route the client never calls?**
Because a liveness probe wants the cheapest possible route that proves the
process is serving — and `/api/health` does not touch the database or the model,
so it cannot fail because of a downstream outage that the instance could recover
from.

**What exactly gets slower after a spin-down?**
Two things: the process start (seconds) and loading the embedding weights into
memory (seconds). The download is already done, because the build fetched it.
The chat model client is also constructed on first use, but that is a cheap
object.

**Why 800 tokens when the answer is at most three sentences?**
Because the budget must cover a reasoning model's hidden reasoning *before* its
first content token. At 60 the provider returned `content: null`; at 800 the same
model returned a complete cited answer. The number is a measurement, recorded in
`answer.ts` ([Grounded answering](06-grounded-answering.md)).

**How would you deploy this with authentication?**
Add a bearer-token check to `/api/*` and `/mcp` before the routers, keep the token
in Render's environment, and give the client the token at build time — which
immediately raises the question of a browser holding a secret, and is the reason
this demo has none.

**What would break first if the corpus grew to a hundred thousand chunks?**
Retrieval latency: there is no vector index, so every search scans the table
([Database and schema](02-database-and-schema.md)). The first fix is an HNSW
index, which is a schema change plus a re-index — and a cold-start rebuild cost
on a free instance.

**Where is the deploy's own branch configured?**
In the Render dashboard, not in `render.yaml` (the blueprint does not pin one).
That is the one piece of deployment state this repository cannot show you.

## Related

- [Scaffold and configuration](01-scaffold-and-configuration.md) — the
  environment contract these values satisfy.
- [Embeddings](03-embeddings.md) — what `pnpm warm-model` is buying.
- [MCP endpoint and shared tools](08-mcp-endpoint-and-shared-tools.md) — the
  production hostname and host-header validation.
- `../README.md` and `../PLAN.md` — the short deployment steps and the tasks this
  document describes.
