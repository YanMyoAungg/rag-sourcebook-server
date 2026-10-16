import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { getVectorStore } from "../rag/vector-store.js";
import type { DocumentSummary } from "./repository.js";
import {
  deleteChunksForDocument,
  deleteDocument,
  insertDocument,
} from "./repository.js";

export class IngestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

const MAX_CONTENT_BYTES = 1024 * 1024;
const ACCEPTED_EXTENSIONS = [".txt", ".md"] as const;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

export interface UploadInput {
  filename: string;
  content: string;
}

export function assertValidUpload(input: UploadInput): void {
  const filename = input.filename.trim();
  if (filename.length === 0) {
    throw new IngestValidationError("filename must not be empty");
  }

  const lowerCaseFilename = filename.toLowerCase();
  const hasAcceptedExtension = ACCEPTED_EXTENSIONS.some((extension) =>
    lowerCaseFilename.endsWith(extension),
  );
  if (!hasAcceptedExtension) {
    throw new IngestValidationError(
      `unsupported file type "${input.filename}" (accepts ${ACCEPTED_EXTENSIONS.join(", ")})`,
    );
  }

  if (input.content.trim().length === 0) {
    throw new IngestValidationError("content must not be empty");
  }

  const byteLength = Buffer.byteLength(input.content, "utf8");
  if (byteLength > MAX_CONTENT_BYTES) {
    throw new IngestValidationError(
      `content exceeds the 1 MiB limit (${byteLength} bytes)`,
    );
  }
}

/** The one store operation ingestion needs, kept narrow for testability. */
export interface VectorWriter {
  addDocuments(documents: Document[]): Promise<void>;
}

export interface IngestDeps {
  pool: Pool;
  getVectorStore: () => Promise<VectorWriter>;
}

function defaultDeps(): IngestDeps {
  return { pool: defaultPool, getVectorStore };
}

export async function ingestDocument(
  input: UploadInput,
  deps: IngestDeps = defaultDeps(),
): Promise<DocumentSummary> {
  assertValidUpload(input);

  const { id, createdAt } = await insertDocument(deps.pool, input);

  try {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });
    const pieces = await splitter.splitText(input.content);
    const chunks = pieces.map(
      (piece, chunkIndex) =>
        new Document({
          pageContent: piece,
          metadata: { documentId: id, filename: input.filename, chunkIndex },
        }),
    );

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
