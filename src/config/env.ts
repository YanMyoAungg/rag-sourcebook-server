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
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
