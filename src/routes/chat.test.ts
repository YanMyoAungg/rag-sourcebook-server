import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rag/answer.js", () => ({
  answerQuestion: vi.fn(),
  streamAnswer: vi.fn(),
  ChatGenerationError: class ChatGenerationError extends Error {},
  ChatModelNotConfiguredError: class ChatModelNotConfiguredError extends Error {},
}));

import { app } from "../app.js";
import {
  ChatGenerationError,
  ChatModelNotConfiguredError,
  answerQuestion,
  streamAnswer,
} from "../rag/answer.js";
import type { AnswerEvent, ChatResult } from "../rag/answer.js";
import { SearchValidationError } from "../rag/search.js";

const answerQuestionMock = vi.mocked(answerQuestion);
const streamAnswerMock = vi.mocked(streamAnswer);

async function postChat(body: unknown): Promise<Response> {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postStream(body: unknown): Promise<Response> {
  return app.request("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RESULT: ChatResult = {
  answer: "Cells need mitochondria [chunk-1].",
  citations: [{ documentId: "d1", filename: "handbook.md", chunkIndex: 0 }],
  retrievedChunks: [
    {
      documentId: "d1",
      filename: "handbook.md",
      chunkIndex: 0,
      content: "Mitochondria are the powerhouse of the cell.",
      relevance: 0.82,
    },
  ],
};

function eventsOf(...events: AnswerEvent[]): AsyncGenerator<AnswerEvent> {
  return (async function* () {
    yield* events;
  })();
}

function failsWith(error: unknown): AsyncGenerator<AnswerEvent> {
  return (async function* () {
    throw error;
  })();
}

beforeEach(() => {
  answerQuestionMock.mockReset();
  streamAnswerMock.mockReset();
});

describe("POST /api/chat", () => {
  it("rejects a body without a question", async () => {
    const res = await postChat({ q: "hello" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it("rejects an empty question", async () => {
    answerQuestionMock.mockRejectedValueOnce(
      new SearchValidationError("question must not be empty"),
    );

    const res = await postChat({ question: "   " });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/question/i),
    });
  });

  it("returns the answer with citations and retrieved chunks", async () => {
    answerQuestionMock.mockResolvedValueOnce({
      answer: "Cells need mitochondria [chunk-1].",
      citations: [{ documentId: "d1", filename: "handbook.md", chunkIndex: 0 }],
      retrievedChunks: [
        {
          documentId: "d1",
          filename: "handbook.md",
          chunkIndex: 0,
          content: "Mitochondria are the powerhouse of the cell.",
          relevance: 0.82,
        },
      ],
    });

    const res = await postChat({ question: "What powers the cell?" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      answer: "Cells need mitochondria [chunk-1].",
      citations: [{ documentId: "d1", filename: "handbook.md", chunkIndex: 0 }],
      retrievedChunks: [
        {
          documentId: "d1",
          filename: "handbook.md",
          chunkIndex: 0,
          content: "Mitochondria are the powerhouse of the cell.",
          relevance: 0.82,
        },
      ],
    });
  });

  it("reports an unconfigured chat model as 503", async () => {
    answerQuestionMock.mockRejectedValueOnce(
      new ChatModelNotConfiguredError("chat model is not configured"),
    );

    const res = await postChat({ question: "hello" });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/not configured/i),
    });
  });

  it("reports generation failures as 502", async () => {
    answerQuestionMock.mockRejectedValueOnce(
      new ChatGenerationError("answer generation failed"),
    );

    const res = await postChat({ question: "hello" });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/generation/i),
    });
  });
});

describe("POST /api/chat/stream", () => {
  it("rejects a body without a question", async () => {
    const res = await postStream({ q: "hello" });

    expect(res.status).toBe(400);
    expect(streamAnswerMock).not.toHaveBeenCalled();
  });

  it("rejects an empty question before opening the stream", async () => {
    const res = await postStream({ question: "   " });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/question/i),
    });
    expect(streamAnswerMock).not.toHaveBeenCalled();
  });

  it("streams the trace, the deltas, and the finished answer as SSE", async () => {
    const args = { query: "hello", limit: 5 };
    streamAnswerMock.mockReturnValue(
      eventsOf(
        {
          type: "tool",
          step: { id: "step-1", tool: "search_documents", args, state: "running" },
        },
        {
          type: "tool",
          step: {
            id: "step-1",
            tool: "search_documents",
            args,
            state: "complete",
            hits: [{ filename: "handbook.md", chunkIndex: 0, relevance: 0.82 }],
            durationMs: 4,
          },
        },
        { type: "text-delta", text: "Cells need " },
        { type: "text-delta", text: "mitochondria [chunk-1]." },
        { type: "finish", result: RESULT, durationMs: 42 },
      ),
    );

    const res = await postStream({ question: "hello" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    const frames = body
      .split("\n\n")
      .filter((frame) => frame.trim().length > 0);

    expect(frames.map((frame) => frame.split("\n")[0])).toEqual([
      "event: tool",
      "event: tool",
      "event: text-delta",
      "event: text-delta",
      "event: finish",
    ]);

    const finishFrame = frames.at(-1)!;
    const dataLine = finishFrame
      .split("\n")
      .find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice("data: ".length))).toEqual({
      type: "finish",
      result: RESULT,
      durationMs: 42,
    });
  });

  it("passes the question, the default deps, and an abort signal to the pipeline", async () => {
    streamAnswerMock.mockReturnValue(
      eventsOf({ type: "finish", result: RESULT, durationMs: 1 }),
    );

    await postStream({ question: "hello" });

    expect(streamAnswerMock).toHaveBeenCalledWith(
      "hello",
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("reports a generation failure as an error event on the open stream", async () => {
    streamAnswerMock.mockReturnValue(
      failsWith(new ChatGenerationError("answer generation failed")),
    );

    const res = await postStream({ question: "hello" });

    // The response already started, so the failure arrives as an event.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain("answer generation failed");
  });

  it("reports an unconfigured model as an error event", async () => {
    streamAnswerMock.mockReturnValue(
      failsWith(new ChatModelNotConfiguredError("chat model is not configured")),
    );

    const res = await postStream({ question: "hello" });

    expect(await res.text()).toContain("chat model is not configured");
  });
});
