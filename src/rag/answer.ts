import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { env } from "../config/env.js";
import {
  RELEVANCE_THRESHOLD,
  SearchValidationError,
  searchDocuments,
} from "./search.js";
import type { SearchHit } from "./search.js";

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

/** The one model operation answering needs, kept narrow for testability. */
export interface AnswerModel {
  invoke(messages: Array<SystemMessage | HumanMessage>): Promise<{
    content: unknown;
  }>;
}

export interface AnswerDeps {
  search: (query: string) => Promise<SearchHit[]>;
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
    search: (query) =>
      searchDocuments(query, { minRelevance: RELEVANCE_THRESHOLD }),
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

export async function answerQuestion(
  question: string,
  deps: AnswerDeps = defaultDeps(),
): Promise<ChatResult> {
  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length === 0) {
    throw new SearchValidationError("question must not be empty");
  }

  const hits = await deps.search(trimmedQuestion);
  if (hits.length === 0) {
    return { answer: ABSTENTION_ANSWER, citations: [], retrievedChunks: [] };
  }

  const model = deps.getModel();

  const evidence = hits
    .map(
      (hit, index) =>
        `[chunk-${index + 1}] (${hit.filename}, chunk ${hit.chunkIndex}):\n${hit.content}`,
    )
    .join("\n\n");

  let content: unknown;
  try {
    const response = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Evidence:\n${evidence}\n\nQuestion: ${trimmedQuestion}`,
      ),
    ]);
    content = response.content;
  } catch (error) {
    throw new ChatGenerationError("answer generation failed", {
      cause: error,
    });
  }

  const answer = extractText(content);
  if (answer.trim().length === 0) {
    throw new ChatGenerationError("model returned an empty answer");
  }

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

  return { answer, citations, retrievedChunks: hits };
}
