import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IngestValidationError, ingestDocument } from "../documents/ingest.js";
import { listDocuments } from "../documents/repository.js";
import { pool } from "../db/pool.js";

const uploadSchema = z.object({
  filename: z.string(),
  content: z.string(),
});

export const documentsRouter = new Hono();

documentsRouter.get("/documents", async (c) => {
  const documents = await listDocuments(pool);
  return c.json({ documents });
});

documentsRouter.post(
  "/documents",
  zValidator("json", uploadSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error:
            "request body must be JSON { filename: string, content: string }",
        },
        400,
      );
    }
  }),
  async (c) => {
    const { filename, content } = c.req.valid("json");

    try {
      const summary = await ingestDocument({ filename, content });
      return c.json(summary, 201);
    } catch (error) {
      if (error instanceof IngestValidationError) {
        return c.json({ error: error.message }, 400);
      }
      console.error("document ingestion failed", error);
      return c.json({ error: "failed to index document" }, 500);
    }
  },
);
