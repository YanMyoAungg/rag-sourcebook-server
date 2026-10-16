import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  ChatGenerationError,
  ChatModelNotConfiguredError,
  answerQuestion,
  streamAnswer,
} from "../rag/answer.js";
import { SearchValidationError } from "../rag/search.js";

const chatSchema = z.object({
  question: z.string(),
});

const invalidBody = (c: { json: (body: unknown, status: 400) => Response }) =>
  c.json({ error: "request body must be JSON { question: string }" }, 400);

interface ChatFailure {
  status: 400 | 502 | 503 | 500;
  message: string;
}

/**
 * The one mapping from pipeline failures to a status and a client-safe message.
 * The JSON route reports it as a status code; the streaming route has already
 * sent its headers, so it reports the same message as an event.
 */
function describeChatFailure(error: unknown): ChatFailure {
  if (error instanceof SearchValidationError) {
    return { status: 400, message: error.message };
  }
  if (error instanceof ChatModelNotConfiguredError) {
    return { status: 503, message: error.message };
  }
  if (error instanceof ChatGenerationError) {
    console.error("answer generation failed", error);
    return { status: 502, message: "answer generation failed" };
  }
  console.error("chat request failed", error);
  return { status: 500, message: "internal server error" };
}

export const chatRouter = new Hono();

chatRouter.post(
  "/chat",
  zValidator("json", chatSchema, (result, c) => {
    if (!result.success) {
      return invalidBody(c);
    }
  }),
  async (c) => {
    const { question } = c.req.valid("json");

    try {
      const result = await answerQuestion(question);
      return c.json(result);
    } catch (error) {
      const failure = describeChatFailure(error);
      return c.json({ error: failure.message }, failure.status);
    }
  },
);

// A reasoning model can spend a long time before its first token, so the
// connection is kept warm rather than left idle for the whole model call.
const SSE_HEARTBEAT_MS = 15_000;

chatRouter.post(
  "/chat/stream",
  zValidator("json", chatSchema, (result, c) => {
    if (!result.success) {
      return invalidBody(c);
    }
  }),
  async (c) => {
    const { question } = c.req.valid("json");
    if (question.trim().length === 0) {
      // Checked before the stream opens, so an empty question is still a
      // plain 400 rather than an error event.
      return c.json({ error: "question must not be empty" }, 400);
    }

    // Proxy hint: Hono's streamSSE sets the other cache headers, and a proxy
    // that buffers a text/event-stream response would hold the whole answer
    // back until the model finished.
    c.header("x-accel-buffering", "no");

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());

      const heartbeat = setInterval(() => {
        // An SSE comment: ignored by clients, read by anything watching for an
        // idle connection.
        void stream.write(": keep-alive\n\n");
      }, SSE_HEARTBEAT_MS);

      try {
        for await (const event of streamAnswer(question, undefined, {
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) {
            break;
          }
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          // The client hung up; there is no one left to report to.
          return;
        }
        const failure = describeChatFailure(error);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: failure.message }),
        });
      } finally {
        clearInterval(heartbeat);
      }
    });
  },
);
