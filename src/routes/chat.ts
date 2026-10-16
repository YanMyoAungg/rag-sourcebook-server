import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  ChatGenerationError,
  ChatModelNotConfiguredError,
  answerQuestion,
} from "../rag/answer.js";
import { SearchValidationError } from "../rag/search.js";

const chatSchema = z.object({
  question: z.string(),
});

export const chatRouter = new Hono();

chatRouter.post(
  "/chat",
  zValidator("json", chatSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "request body must be JSON { question: string }" },
        400,
      );
    }
  }),
  async (c) => {
    const { question } = c.req.valid("json");

    try {
      const result = await answerQuestion(question);
      return c.json(result);
    } catch (error) {
      if (error instanceof SearchValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof ChatModelNotConfiguredError) {
        return c.json({ error: error.message }, 503);
      }
      if (error instanceof ChatGenerationError) {
        console.error("answer generation failed", error);
        return c.json({ error: "answer generation failed" }, 502);
      }
      console.error("chat request failed", error);
      return c.json({ error: "internal server error" }, 500);
    }
  },
);
