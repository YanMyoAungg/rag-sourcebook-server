import type { Pool } from "pg";
import { z } from "zod";
import { getDocument } from "../documents/repository.js";
import type { IndexedDocument } from "../documents/repository.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchDocuments,
} from "./search.js";
import type { SearchDeps, SearchHit } from "./search.js";

/**
 * The retrieval tools, defined once. The MCP endpoint registers these as tools
 * and the answering pipeline calls `searchDocumentsTool.run`, so the tool name
 * an answer traces is the name an MCP client calls.
 */

const searchDocumentsInput = z.object({
  query: z.string().min(1).describe("Natural-language search query"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(
      `Maximum number of chunks to return (default ${DEFAULT_SEARCH_LIMIT})`,
    ),
});

export type SearchDocumentsInput = z.infer<typeof searchDocumentsInput>;

export const searchDocumentsTool = {
  name: "search_documents",
  title: "Search documents",
  description:
    "Semantic search over the indexed documents. Returns the best-matching " +
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

const getDocumentInput = z.object({
  documentId: z
    .string()
    .describe("Document id (uuid) as returned by search results"),
});

export type GetDocumentInput = z.infer<typeof getDocumentInput>;

export const getDocumentTool = {
  name: "get_document",
  title: "Get document",
  description:
    "Fetch one indexed document by id: metadata plus the full original content.",
  inputSchema: getDocumentInput,
  run: (
    input: GetDocumentInput,
    deps: { pool: Pool },
  ): Promise<IndexedDocument | null> => getDocument(deps.pool, input.documentId),
};
