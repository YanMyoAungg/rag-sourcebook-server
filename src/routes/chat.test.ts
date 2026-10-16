import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rag/answer.js", () => ({
  answerQuestion: vi.fn(),
  ChatGenerationError: class ChatGenerationError extends Error {},
  ChatModelNotConfiguredError: class ChatModelNotConfiguredError extends Error {},
}));

import { app } from "../app.js";
import {
  ChatGenerationError,
  ChatModelNotConfiguredError,
  answerQuestion,
} from "../rag/answer.js";
import { SearchValidationError } from "../rag/search.js";

const answerQuestionMock = vi.mocked(answerQuestion);

async function postChat(body: unknown): Promise<Response> {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  answerQuestionMock.mockReset();
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
