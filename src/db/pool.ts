import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = new Pool({ connectionString: env.DATABASE_URL });

/**
 * Dedicated pool for the pgvector store. PGVectorStore holds one checked-out
 * client for its whole lifetime and its end() terminates the entire pool, so
 * it must not share the application pool.
 */
export const vectorStorePool = new Pool({ connectionString: env.DATABASE_URL });
