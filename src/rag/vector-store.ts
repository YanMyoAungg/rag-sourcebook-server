import { PGVectorStore } from "@langchain/pgvector";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { localEmbeddings } from "./embeddings.js";

/**
 * Builds the pgvector store over the given pool. The vector dimension is
 * derived from the embedding model itself so the two cannot drift.
 *
 * Note: PGVectorStore.initialize() checks out one client for the store's
 * lifetime and end() terminates the pool it was given — pass it a pool used
 * by nothing else.
 */
export async function createVectorStore(
  storePool: Pool,
): Promise<PGVectorStore> {
  const dimensions = (await localEmbeddings.embedQuery("dimension probe"))
    .length;
  return PGVectorStore.initialize(localEmbeddings, {
    pool: storePool,
    tableName: "chunks",
    columns: {
      idColumnName: "id",
      vectorColumnName: "vector",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    dimensions,
  });
}

let defaultStore: Promise<PGVectorStore> | undefined;
const ended = new WeakSet<PGVectorStore>();

async function endStore(store: PGVectorStore): Promise<void> {
  if (ended.has(store)) {
    return;
  }
  ended.add(store);
  await store.end();
}

/**
 * The store holds a checked-out client for its whole lifetime. Neon closes idle
 * connections when its compute suspends, which kills that client; the store
 * can then no longer query. A lost connection drops the cached store so the
 * next request opens a fresh one over a fresh pool.
 */
async function openStore(): Promise<PGVectorStore> {
  const storePool = createPool("vector store");
  let store: PGVectorStore;
  try {
    store = await createVectorStore(storePool);
  } catch (error) {
    // initialize() may have connected before it failed. End the pool in the
    // background rather than blocking the error on a client it never released.
    void storePool.end().catch(() => undefined);
    throw error;
  }

  const pending = defaultStore;
  store.client?.on("error", () => {
    if (defaultStore === pending) {
      defaultStore = undefined;
    }
    void endStore(store).catch((error) => {
      console.error("vector store: failed to close a dead store", error);
    });
  });

  return store;
}

/** Lazily initialized store bound to the application's database. */
export function getVectorStore(): Promise<PGVectorStore> {
  defaultStore ??= openStore();
  return defaultStore;
}

/** Releases the store's held client and the pool it owns. */
export async function closeVectorStore(): Promise<void> {
  const store = defaultStore;
  defaultStore = undefined;
  if (store === undefined) {
    return;
  }
  await endStore(await store);
}
