import { describe, expect, it } from "vitest";
import {
  ABSTENTION_ANSWER,
  ChatGenerationError,
  ChatModelNotConfiguredError,
  answerQuestion,
  resolveChatModelConfig,
} from "./answer.js";
import type { AnswerDeps, ChatSettingsSource } from "./answer.js";
import { SearchValidationError } from "./search.js";
import type { SearchHit } from "./search.js";

const sampleHit = (overrides: Partial<SearchHit> = {}): SearchHit => ({
  documentId: "f1e2d3c4-0000-4000-8000-000000000001",
  filename: "handbook.md",
  chunkIndex: 0,
  content: "Mitochondria are the powerhouse of the cell.",
  relevance: 0.82,
  ...overrides,
});

type ModelScript = (messages: unknown[]) => string | Promise<string>;

/**
 * Test deps with a scripted model. When no script is given the model must not
 * be called; doing so fails the test through the thrown error.
 */
function makeDeps(hits: SearchHit[], script?: ModelScript) {
  const modelCalls: unknown[][] = [];
  const deps: AnswerDeps = {
    search: async () => hits,
    getModel: () => ({
      invoke: async (messages) => {
        modelCalls.push(messages);
        if (!script) {
          throw new Error("model must not be called");
        }
        return { content: await script(messages) };
      },
    }),
  };
  return { deps, modelCalls };
}

describe("answerQuestion", () => {
  it("rejects an empty question", async () => {
    const { deps, modelCalls } = makeDeps([sampleHit()]);

    await expect(answerQuestion("   ", deps)).rejects.toBeInstanceOf(
      SearchValidationError,
    );
    expect(modelCalls).toHaveLength(0);
  });

  it("abstains without calling the model when retrieval finds nothing", async () => {
    const { deps, modelCalls } = makeDeps([]);

    const result = await answerQuestion(
      "What is the powerhouse of the cell?",
      deps,
    );

    expect(result.answer).toBe(ABSTENTION_ANSWER);
    expect(result.citations).toEqual([]);
    expect(result.retrievedChunks).toEqual([]);
    expect(modelCalls).toHaveLength(0);
  });

  it("answers from evidence and maps [chunk-N] markers to citations", async () => {
    const hits = [
      sampleHit(),
      sampleHit({
        documentId: "f1e2d3c4-0000-4000-8000-000000000002",
        filename: "pgvector.md",
        chunkIndex: 1,
        content: "PGVector stores embeddings in PostgreSQL.",
      }),
    ];
    const { deps } = makeDeps(
      hits,
      () =>
        "Embeddings live in PostgreSQL [chunk-2], and cells need mitochondria [chunk-1].",
    );

    const result = await answerQuestion("Where are embeddings stored?", deps);

    expect(result.answer).toContain("[chunk-2]");
    expect(result.citations).toEqual([
      {
        documentId: "f1e2d3c4-0000-4000-8000-000000000002",
        filename: "pgvector.md",
        chunkIndex: 1,
      },
      {
        documentId: "f1e2d3c4-0000-4000-8000-000000000001",
        filename: "handbook.md",
        chunkIndex: 0,
      },
    ]);
    expect(result.retrievedChunks).toEqual(hits);
  });

  it("validates citation IDs and drops ones outside the retrieved set", async () => {
    const hits = [sampleHit()];
    const { deps } = makeDeps(
      hits,
      () => "Cells [chunk-1], again [chunk-1], and nowhere [chunk-9].",
    );

    const result = await answerQuestion("q", deps);

    expect(result.citations).toEqual([
      {
        documentId: hits[0]!.documentId,
        filename: "handbook.md",
        chunkIndex: 0,
      },
    ]);
  });

  it("sends the question and numbered evidence to the model", async () => {
    const hits = [
      sampleHit(),
      sampleHit({ chunkIndex: 1, content: "A second piece of evidence." }),
    ];
    const { deps, modelCalls } = makeDeps(hits, () => "ok [chunk-1]");

    await answerQuestion("Where is the mitochondrion?", deps);

    expect(modelCalls).toHaveLength(1);
    const prompt = JSON.stringify(modelCalls[0]);
    expect(prompt).toContain("[chunk-1]");
    expect(prompt).toContain("[chunk-2]");
    expect(prompt).toContain("Mitochondria are the powerhouse of the cell.");
    expect(prompt).toContain("A second piece of evidence.");
    expect(prompt).toContain("Where is the mitochondrion?");
  });

  it("reports a missing model configuration", async () => {
    const deps: AnswerDeps = {
      search: async () => [sampleHit()],
      getModel: () => {
        throw new ChatModelNotConfiguredError("chat model is not configured");
      },
    };

    await expect(answerQuestion("q", deps)).rejects.toBeInstanceOf(
      ChatModelNotConfiguredError,
    );
  });

  it("wraps model errors (including timeouts) in ChatGenerationError", async () => {
    const { deps } = makeDeps([sampleHit()], () => {
      const error = new Error("request timed out");
      error.name = "APIConnectionTimeoutError";
      throw error;
    });

    await expect(answerQuestion("q", deps)).rejects.toBeInstanceOf(
      ChatGenerationError,
    );
  });

  it("rejects an empty completion", async () => {
    const { deps } = makeDeps([sampleHit()], () => "");

    await expect(answerQuestion("q", deps)).rejects.toBeInstanceOf(
      ChatGenerationError,
    );
  });
});

describe("resolveChatModelConfig", () => {
  const configured: ChatSettingsSource = {
    CHAT_BASE_URL: "https://example.test/v1",
    CHAT_API_KEY: "test-key",
    CHAT_MODEL: "test-model",
  };

  it("reads the provider-agnostic chat settings", () => {
    expect(resolveChatModelConfig(configured)).toEqual({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
  });

  it("reports a missing base URL as unconfigured", () => {
    expect(
      resolveChatModelConfig({ ...configured, CHAT_BASE_URL: undefined }),
    ).toBeUndefined();
  });

  it("reports a missing API key as unconfigured", () => {
    expect(
      resolveChatModelConfig({ ...configured, CHAT_API_KEY: undefined }),
    ).toBeUndefined();
  });

  it("reports a missing model as unconfigured", () => {
    expect(
      resolveChatModelConfig({ ...configured, CHAT_MODEL: undefined }),
    ).toBeUndefined();
  });

  it("treats blank settings as unconfigured", () => {
    expect(
      resolveChatModelConfig({ ...configured, CHAT_API_KEY: "   " }),
    ).toBeUndefined();
  });
});
