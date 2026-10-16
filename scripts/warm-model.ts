import { pipeline } from "@huggingface/transformers";

// Pre-download the embedding model during deployment builds so the first
// request after a cold start does not fetch ~100 MB from the Hugging Face Hub.
const model = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";

await pipeline("feature-extraction", model);

console.log(`embedding model ready: ${model}`);
