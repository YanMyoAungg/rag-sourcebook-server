import { PGVectorStore } from "@langchain/pgvector";
import type { Pool } from "pg";
import { vectorStorePool } from "../db/pool.js";
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

/** Lazily initialized store bound to the application's database. */
export function getVectorStore(): Promise<PGVectorStore> {
  defaultStore ??= createVectorStore(vectorStorePool);
  return defaultStore;
}

/** Releases the store's held client and pool (or the idle pool if unused). */
export async function closeVectorStore(): Promise<void> {
  const store = defaultStore;
  defaultStore = undefined;
  if (store) {
    await (await store).end();
  } else {
    await vectorStorePool.end();
  }
}
