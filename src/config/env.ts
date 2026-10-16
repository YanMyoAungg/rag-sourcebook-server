import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://localhost:5432/rag_sourcebook"),
  CLIENT_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  EMBEDDING_MODEL: z.string().min(1).default("Xenova/all-MiniLM-L6-v2"),
  OPENCODE_INFERENCE_BASE_URL: z
    .string()
    .min(1)
    .default("https://opencode.ai/inference/go/openai/v1"),
  // Optional at boot; chat answers are reported as "not configured" without it.
  OPENCODE_INFERENCE_API_KEY: z.string().optional(),
  CHAT_MODEL: z.string().default("cat-jam-free"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
