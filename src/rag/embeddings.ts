import { Embeddings } from "@langchain/core/embeddings";
import { pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { env } from "../config/env.js";

/**
 * LangChain Embeddings adapter over a local Transformers.js feature-extraction
 * pipeline. Vectors are mean-pooled and L2-normalized, matching how the
 * pgvector store queries them (cosine distance).
 */
export class LocalEmbeddings extends Embeddings {
  private readonly model: string;
  private extractorPromise?: Promise<FeatureExtractionPipeline>;

  constructor(model: string) {
    super({});
    this.model = model;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedDocuments([text]);
    if (!embedding) {
      throw new Error("embedding model returned no vector");
    }
    return embedding;
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    this.extractorPromise ??= pipeline("feature-extraction", this.model);
    return this.extractorPromise;
  }
}

export const localEmbeddings = new LocalEmbeddings(env.EMBEDDING_MODEL);
