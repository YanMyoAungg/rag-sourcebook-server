import type { Document } from "@langchain/core/documents";
import { getVectorStore } from "./vector-store.js";

export class SearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchValidationError";
  }
}

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
// Calibrated against three answerable and three unrelated questions over the
// seeded corpus (search.test.ts): answerable top scores were 0.64-0.74,
// unrelated ones 0.01-0.10. 0.35 sits mid-gap.
export const RELEVANCE_THRESHOLD = 0.35;

export interface SearchHit {
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity, normalized so larger values are more relevant. */
  relevance: number;
}

export interface SearchOptions {
  limit?: number;
  minRelevance?: number;
}

/** The one store operation search needs, kept narrow for testability. */
export interface VectorSearcher {
  similaritySearchWithScore(
    query: string,
    k: number,
  ): Promise<Array<[Document, number]>>;
}

export interface SearchDeps {
  getVectorStore: () => Promise<VectorSearcher>;
}

function defaultDeps(): SearchDeps {
  return { getVectorStore };
}

export async function searchDocuments(
  query: string,
  options: SearchOptions = {},
  deps: SearchDeps = defaultDeps(),
): Promise<SearchHit[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    throw new SearchValidationError("query must not be empty");
  }

  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new SearchValidationError(
      `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
    );
  }

  const minRelevance = options.minRelevance ?? 0;

  const store = await deps.getVectorStore();
  // PGVectorStore ranks by ascending cosine distance.
  const results = await store.similaritySearchWithScore(trimmedQuery, limit);

  const hits: SearchHit[] = [];
  for (const [document, distance] of results) {
    const { documentId, filename, chunkIndex } = document.metadata;
    if (
      typeof documentId !== "string" ||
      typeof filename !== "string" ||
      typeof chunkIndex !== "number"
    ) {
      // A row not written by this app's ingestion; skip it.
      continue;
    }

    const relevance = 1 - distance;
    if (relevance < minRelevance) {
      continue;
    }

    hits.push({
      documentId,
      filename,
      chunkIndex,
      content: document.pageContent,
      relevance,
    });
  }

  return hits;
}
