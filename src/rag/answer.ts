import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { env } from "../config/env.js";
import {
  DEFAULT_SEARCH_LIMIT,
  RELEVANCE_THRESHOLD,
  SearchValidationError,
} from "./search.js";
import type { SearchHit } from "./search.js";
import { searchDocumentsTool } from "./tools.js";
import type { SearchDocumentsInput } from "./tools.js";
import { getVectorStore } from "./vector-store.js";

export class ChatModelNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatModelNotConfiguredError";
  }
}

export class ChatGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatGenerationError";
  }
}

export const ABSTENTION_ANSWER =
  "I couldn't find an answer to that in the indexed documents.";

export interface Citation {
  documentId: string;
  filename: string;
  chunkIndex: number;
}

export interface ChatResult {
  answer: string;
  citations: Citation[];
  retrievedChunks: SearchHit[];
}

/** A retrieval hit as the trace reports it: no content, so the stream stays small. */
export interface TraceHit {
  filename: string;
  chunkIndex: number;
  relevance: number;
}

/**
 * One tool call in an answer's trace. The same `id` is emitted twice, running
 * then complete, so a client can update the row in place as it fills in.
 */
export interface ToolTrace {
  id: string;
  /** The tool's registered name, as an MCP client would call it. */
  tool: string;
  args: Record<string, unknown>;
  state: "running" | "complete" | "error";
  hits?: TraceHit[];
  durationMs?: number;
}

/** What `streamAnswer` yields, in order. */
export type AnswerEvent =
  | { type: "tool"; step: ToolTrace }
  | { type: "text-delta"; text: string }
  | { type: "finish"; result: ChatResult; durationMs: number };

/**
 * The one model operation answering needs, kept narrow for testability: a
 * stream of chunks, so a client can render the answer as it arrives.
 */
export interface AnswerModel {
  stream(
    messages: Array<SystemMessage | HumanMessage>,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<{ content: unknown }>>;
}

export interface AnswerDeps {
  /** Runs the `search_documents` tool and applies the answering threshold. */
  search: (input: SearchDocumentsInput) => Promise<SearchHit[]>;
  getModel: () => AnswerModel;
}

const CHAT_TIMEOUT_MS = 45_000;
// Reasoning models spend part of this budget on hidden reasoning before any
// content is emitted, so it must cover reasoning + answer. Too small a budget
// returns an empty answer rather than a short one (verified against OpenRouter
// free reasoning models, which returned content: null at max_tokens 60 and a
// complete cited answer at 800).
const MAX_ANSWER_TOKENS = 800;
const APP_USER_AGENT = "rag-sourcebook-server/0.1.0";
const CITATION_PATTERN = /\[chunk-(\d+)\]/g;
const TOOL_STEP_ID = "step-1";

const SYSTEM_PROMPT = [
  "You answer questions strictly from the numbered evidence excerpts provided.",
  "Cite every excerpt you use with its ID in square brackets, e.g. [chunk-2].",
  "If the evidence does not contain the answer, say you cannot answer from the documents.",
  "Never use outside knowledge. Answer in at most three sentences.",
].join(" ");

let defaultModel: ChatOpenAI | undefined;

function getChatModel(): AnswerModel {
  const config = resolveChatModelConfig(env);
  if (!config) {
    throw new ChatModelNotConfiguredError(
      "chat model is not configured: set CHAT_BASE_URL, CHAT_API_KEY and CHAT_MODEL",
    );
  }
  defaultModel ??= new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    temperature: 0,
    maxTokens: MAX_ANSWER_TOKENS,
    timeout: CHAT_TIMEOUT_MS,
    maxRetries: 1,
    configuration: {
      baseURL: config.baseUrl,
      defaultHeaders: {
        "user-agent": APP_USER_AGENT,
      },
    },
  });
  return defaultModel;
}

export interface ChatModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The chat settings the server reads. Env-shaped so tests can inject one. */
export interface ChatSettingsSource {
  CHAT_BASE_URL?: string | undefined;
  CHAT_API_KEY?: string | undefined;
  CHAT_MODEL?: string | undefined;
}

/**
 * Resolves chat settings from an env-shaped source. Any missing or blank value
 * means chat is unconfigured, which surfaces as "not configured" (503) rather
 * than a failed request to a half-specified endpoint.
 */
export function resolveChatModelConfig(
  source: ChatSettingsSource,
): ChatModelConfig | undefined {
  const baseUrl = source.CHAT_BASE_URL?.trim() ?? "";
  const apiKey = source.CHAT_API_KEY?.trim() ?? "";
  const model = source.CHAT_MODEL?.trim() ?? "";
  if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) {
    return undefined;
  }
  return { baseUrl, apiKey, model };
}

function defaultDeps(): AnswerDeps {
  return {
    search: async (input) => {
      const hits = await searchDocumentsTool.run(input, { getVectorStore });
      return hits.filter((hit) => hit.relevance >= RELEVANCE_THRESHOLD);
    },
    getModel: getChatModel,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function toTraceHit(hit: SearchHit): TraceHit {
  return {
    filename: hit.filename,
    chunkIndex: hit.chunkIndex,
    relevance: hit.relevance,
  };
}

/** Maps the `[chunk-N]` markers an answer uses onto the chunks it was given. */
function toCitations(answer: string, hits: SearchHit[]): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<number>();
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const citationNumber = Number(match[1]);
    if (
      !Number.isInteger(citationNumber) ||
      citationNumber < 1 ||
      citationNumber > hits.length ||
      seen.has(citationNumber)
    ) {
      continue;
    }
    seen.add(citationNumber);
    const hit = hits[citationNumber - 1]!;
    citations.push({
      documentId: hit.documentId,
      filename: hit.filename,
      chunkIndex: hit.chunkIndex,
    });
  }
  return citations;
}

/**
 * Answers one question, yielding the trace as it happens: the search tool call,
 * then the answer's text as the model produces it, then the finished result.
 *
 * Throws rather than yielding an error event, so the JSON route keeps mapping
 * failures to status codes and the streaming route can report them on a
 * response whose headers are already sent.
 */
export async function* streamAnswer(
  question: string,
  deps: AnswerDeps = defaultDeps(),
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<AnswerEvent> {
  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length === 0) {
    throw new SearchValidationError("question must not be empty");
  }

  const startedAt = Date.now();
  const call: SearchDocumentsInput = {
    query: trimmedQuestion,
    limit: DEFAULT_SEARCH_LIMIT,
  };
  const tool = { id: TOOL_STEP_ID, tool: searchDocumentsTool.name, args: call };

  yield { type: "tool", step: { ...tool, state: "running" } };

  const searchStartedAt = Date.now();
  let hits: SearchHit[];
  try {
    hits = await deps.search(call);
  } catch (error) {
    yield {
      type: "tool",
      step: {
        ...tool,
        state: "error",
        durationMs: Date.now() - searchStartedAt,
      },
    };
    throw error;
  }

  yield {
    type: "tool",
    step: {
      ...tool,
      state: "complete",
      hits: hits.map(toTraceHit),
      durationMs: Date.now() - searchStartedAt,
    },
  };

  if (hits.length === 0) {
    yield {
      type: "finish",
      result: { answer: ABSTENTION_ANSWER, citations: [], retrievedChunks: [] },
      durationMs: Date.now() - startedAt,
    };
    return;
  }

  const model = deps.getModel();

  const evidence = hits
    .map(
      (hit, index) =>
        `[chunk-${index + 1}] (${hit.filename}, chunk ${hit.chunkIndex}):\n${hit.content}`,
    )
    .join("\n\n");

  let answer = "";
  try {
    const chunks = await model.stream(
      [
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(`Evidence:\n${evidence}\n\nQuestion: ${trimmedQuestion}`),
      ],
      { signal: options.signal },
    );
    for await (const chunk of chunks) {
      const text = extractText(chunk.content);
      if (text.length === 0) {
        continue;
      }
      answer += text;
      yield { type: "text-delta", text };
    }
  } catch (error) {
    throw new ChatGenerationError("answer generation failed", {
      cause: error,
    });
  }

  if (answer.trim().length === 0) {
    throw new ChatGenerationError("model returned an empty answer");
  }

  yield {
    type: "finish",
    result: {
      answer,
      citations: toCitations(answer, hits),
      retrievedChunks: hits,
    },
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The buffered form of `streamAnswer`, for callers that only want the result:
 * `POST /api/chat` and its tests.
 */
export async function answerQuestion(
  question: string,
  deps: AnswerDeps = defaultDeps(),
): Promise<ChatResult> {
  for await (const event of streamAnswer(question, deps)) {
    if (event.type === "finish") {
      return event.result;
    }
  }
  // streamAnswer always ends with a finish event, or throws.
  throw new ChatGenerationError("answer stream ended without a result");
}
