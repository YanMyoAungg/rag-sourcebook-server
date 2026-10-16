# 6. Grounded answering

> How evidence reaches the model, how `[chunk-N]` markers become validated
> citations, why the model is never called when nothing matched, and how the
> answer streams out as an event sequence.

## What it does

Takes one question and produces a trace plus an answer:

1. trace the search tool call,
2. if nothing cleared the relevance floor, abstain — no model call at all,
3. otherwise send numbered evidence to the configured model and stream the text
   back as it is written,
4. map the `[chunk-N]` markers the model used onto the actual chunks, and finish
   with citations and the retrieved passages.

`src/rag/answer.ts` owns all of it. It is an async generator, not a function that
returns a string, because the trace and the text have to arrive incrementally.

## How it works

### The event union

```ts
export type AnswerEvent =
  | { type: "tool"; step: ToolTrace }
  | { type: "text-delta"; text: string }
  | { type: "finish"; result: ChatResult; durationMs: number };
```

`streamAnswer` yields exactly this, in this order. The JSON route consumes it and
keeps only the `finish`; the SSE route forwards each event as it is yielded.
One pipeline, two transports ([Chat API](07-chat-api-and-event-streaming.md)).

### The tool step is emitted twice, under one id

```ts
const tool = { id: TOOL_STEP_ID, tool: searchDocumentsTool.name, args: call };

yield { type: "tool", step: { ...tool, state: "running" } };
// … search …
yield { type: "tool", step: { ...tool, state: "complete", hits: hits.map(toTraceHit),
                              durationMs: Date.now() - searchStartedAt } };
```

`TOOL_STEP_ID` is the constant `"step-1"`, and the id is stable across both
events on purpose: the client updates the *same* row from "running" to
"complete" instead of appending a second one
([Thread state](https://github.com/YanMyoAungg/rag-sourcebook-client/blob/main/docs/05-thread-state.md)). The trace carries
`TraceHit`s — filename, chunk index, relevance, **no content** — so the live
stream stays small; the full passages arrive once, in the `finish` event.

The tool name comes from `searchDocumentsTool.name`, not from a string literal.
An answer therefore traces the same name an MCP client calls
([MCP endpoint](08-mcp-endpoint-and-shared-tools.md)).

If retrieval throws, the generator yields a `state: "error"` step with its
duration and then rethrows — the trace shows a failed call rather than a missing
one, and the route decides how to report the failure.

### Abstention is decided before the model exists

```ts
if (hits.length === 0) {
  yield {
    type: "finish",
    result: { answer: ABSTENTION_ANSWER, citations: [], retrievedChunks: [] },
    durationMs: Date.now() - startedAt,
  };
  return;
}
```

`ABSTENTION_ANSWER` is
`"I couldn't find an answer to that in the indexed documents."` and it is
produced by the server, skipping `deps.getModel()` entirely. The floor that
produces the empty list is applied in `defaultDeps`:

```ts
search: async (input) => {
  const hits = await searchDocumentsTool.run(input, { getVectorStore });
  return hits.filter((hit) => hit.relevance >= RELEVANCE_THRESHOLD);
},
```

This is the single most consequential behaviour in the project: an off-topic
question costs **zero** model calls, returns in milliseconds, and cannot
hallucinate, because there is no model in the path. It is also why the
deployed off-topic smoke test finishes in ~700 ms
([Retrieval and relevance](05-retrieval-and-relevance.md)).

### The evidence block

```ts
const evidence = hits
  .map((hit, index) => `[chunk-${index + 1}] (${hit.filename}, chunk ${hit.chunkIndex}):\n${hit.content}`)
  .join("\n\n");

const chunks = await model.stream([
  new SystemMessage(SYSTEM_PROMPT),
  new HumanMessage(`Evidence:\n${evidence}\n\nQuestion: ${trimmedQuestion}`),
], { signal: options.signal });
```

The numbering is the contract. `[chunk-1]` is `hits[0]`, and the label repeats
the filename and the *original* chunk index (0-based in the data, shown as
`chunk 1` in the UI). The system prompt:

```ts
const SYSTEM_PROMPT = [
  "You answer questions strictly from the numbered evidence excerpts provided.",
  "Cite every excerpt you use with its ID in square brackets, e.g. [chunk-2].",
  "If the evidence does not contain the answer, say you cannot answer from the documents.",
  "Never use outside knowledge. Answer in at most three sentences.",
].join(" ");
```

Four rules, in the order they matter: use only the evidence, cite it, abstain if
it does not contain the answer, stay short.

### Turning markers into citations

```ts
function toCitations(answer: string, hits: SearchHit[]): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<number>();
  for (const match of answer.matchAll(CITATION_PATTERN)) {   // /\[chunk-(\d+)\]/g
    const citationNumber = Number(match[1]);
    if (!Number.isInteger(citationNumber) || citationNumber < 1 ||
        citationNumber > hits.length || seen.has(citationNumber)) continue;
    seen.add(citationNumber);
    const hit = hits[citationNumber - 1]!;
    citations.push({ documentId: hit.documentId, filename: hit.filename, chunkIndex: hit.chunkIndex });
  }
  return citations;
}
```

Citations are *derived from the answer text*, not asserted by the model. Three
things are guarded: a number outside `1..hits.length` is dropped (the model
cannot invent a source that was never retrieved), a repeated number is counted
once, and the order follows first appearance in the answer. What is **not**
checked is whether the cited passage actually supports the claim — the
validation is about existence, not entailment.

### The model, and the budget trap

```ts
const CHAT_TIMEOUT_MS = 45_000;
// Reasoning models spend part of this budget on hidden reasoning before any
// content is emitted, so it must cover reasoning + answer. Too small a budget
// returns an empty answer rather than a short one (verified against OpenRouter
// free reasoning models, which returned content: null at max_tokens 60 and a
// complete cited answer at 800).
const MAX_ANSWER_TOKENS = 800;

defaultModel ??= new ChatOpenAI({
  model: config.model, apiKey: config.apiKey,
  temperature: 0,
  maxTokens: MAX_ANSWER_TOKENS,
  timeout: CHAT_TIMEOUT_MS,
  maxRetries: 1,
  configuration: { baseURL: config.baseUrl, defaultHeaders: { "user-agent": APP_USER_AGENT } },
});
```

Five settings, each with a reason:

| Setting | Value | Why |
| --- | --- | --- |
| `temperature` | `0` | This is extraction from provided evidence, not writing. Determinism makes a failing answer reproducible. |
| `maxTokens` | `800` | Large enough for a reasoning model's hidden reasoning *plus* a three-sentence cited answer; 60 was measured returning empty content. |
| `timeout` | `45 s` | A ceiling on one model call, independent of the SSE heartbeat that keeps the connection warm. |
| `maxRetries` | `1` | One retry for a transient provider error. Worst case is two full timeouts. |
| `temperature`/`baseURL`/`user-agent` | provider-agnostic | Only `CHAT_BASE_URL`, `CHAT_API_KEY`, and `CHAT_MODEL` decide who answers. OpenRouter is today's value, not a dependency. |

The model is cached in a module-level `defaultModel` after the first successful
construction, so a process builds one client.

`getChatModel` throws `ChatModelNotConfiguredError` when
`resolveChatModelConfig` returns `undefined` — which it does if *any* of the
three values is missing or blank. That surfaces as a 503, not as a request to a
half-specified endpoint:

```ts
export function resolveChatModelConfig(source: ChatSettingsSource): ChatModelConfig | undefined {
  const baseUrl = source.CHAT_BASE_URL?.trim() ?? "";
  const apiKey = source.CHAT_API_KEY?.trim() ?? "";
  const model = source.CHAT_MODEL?.trim() ?? "";
  if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) return undefined;
  return { baseUrl, apiKey, model };
}
```

### Reading the stream, defensively

```ts
function extractText(content: unknown): string { /* string, or array of parts → "" */ }

for await (const chunk of chunks) {
  const text = extractText(chunk.content);
  if (text.length === 0) continue;
  answer += text;
  yield { type: "text-delta", text };
}

if (answer.trim().length === 0) throw new ChatGenerationError("model returned an empty answer");
```

Providers disagree about the shape of a chunk's `content` — sometimes a string,
sometimes an array of content parts, sometimes empty chunks that only carry
metadata. `extractText` normalises all of that to a string, and an answer that
ends up empty is an error rather than an empty success: a `finish` event with
`answer: ""` would look to the user like the app was broken.

Model failures are wrapped so the route has one type to reason about:

```ts
catch (error) { throw new ChatGenerationError("answer generation failed", { cause: error }); }
```

### The buffered wrapper

```ts
export async function answerQuestion(question, deps = defaultDeps()): Promise<ChatResult> {
  for await (const event of streamAnswer(question, deps)) {
    if (event.type === "finish") return event.result;
  }
  throw new ChatGenerationError("answer stream ended without a result");
}
```

`POST /api/chat` is this function. It is not a second implementation — it drains
the same generator — so the two routes cannot drift apart in behaviour, only in
delivery.

## Decisions and rejected alternatives

- **Abstain rather than answer with a disclaimer.** An earlier design considered
  having the model answer out-of-scope questions with a caveat. It was dropped:
  the project rule is a grounded answer with citations or an explicit "I couldn't
  find it". The threshold decides, and the model is not consulted when nothing
  was found.
- **A generator instead of a string-returning function.** The trace must be
  visible while the answer is being written; a function returning a result would
  force the route to invent its own progress reporting, or give up streaming.
- **The pipeline throws; the route decides the status.** `streamAnswer` never
  yields an `error` event. That keeps HTTP concerns (status codes, SSE framing)
  in `routes/chat.ts`, and it is why the same failure becomes a 502 on one route
  and an `error` event on the other ([Chat API](07-chat-api-and-event-streaming.md)).
- **Cite by index, not by document id.** `[chunk-2]` is two tokens for the model
  to emit and one regex to parse. A uuid citation would cost output tokens,
  invite transcription errors, and need fuzzy matching.
- **Evidence numbered in retrieval order, best first.** The strongest passage
  gets `[chunk-1]`, which nudges the model toward the most relevant excerpt
  without any instruction to prefer it.
- **Traces carry no chunk content.** The trace is emitted twice per call; the
  passages are sent once, in `finish`. It halves the streamed bytes and keeps the
  running row cheap to render.
- **`temperature: 0` and `maxRetries: 1`.** Determinism for a debugging story;
  one retry for transient provider flakiness, accepting that a hard failure
  costs two timeouts.

## Where it can bite you

- **Reasoning models can eat the whole budget.** The 800-token ceiling must
  cover hidden reasoning *and* the answer. A reasoning model configured with a
  smaller budget returns `content: null` — which this code correctly reports as
  `500`/502 "answer generation failed" rather than an empty answer, but the
  symptom looks like a broken provider rather than a budget that is too small.
- **Citation validation is range-based, not entailment-based.** A model that
  writes `[chunk-3]` where `[chunk-1]` was the supporting passage produces a
  citation to a real but wrong chunk. The check catches invented numbers, not
  wrong ones.
- **A model that cites nothing yields zero citations,** even with evidence in
  hand. The UI then shows the answer without badges but still shows the
  retrieved passages, so the evidence is not lost — but the answer is, by the
  project's own standard, uncited.
- **Two abstention paths exist and they are not the same event.** Zero hits is a
  server-side abstention with `citations: []` and no model call; a model that
  says it cannot answer (prompt rule 3) is an ordinary `finish` with whatever
  text it produced. Only the first is guaranteed cheap.
- **`CITATION_PATTERN` is exact.** `[chunk-1]` matches; `[Chunk-1]`, `[chunk 1]`,
  and `[chunk-1, chunk-2]` (as one bracket, which does match twice if written
  `[chunk-1] [chunk-2]`) behave as you would expect from a case-sensitive regex
  — a deviation by the model silently loses the citation.
- **The trace assumes exactly one tool call.** `TOOL_STEP_ID` is constant
  `"step-1"`; two calls in one answer would collide on id. The pipeline makes
  one call by construction, and adding a second (for example a `get_document`
  fetch) means generating ids.
- **`maxRetries: 1` doubles worst-case latency.** A provider that is timing out
  costs two 45-second windows before the 502.

## Questions this invites

**Why is the model never called when retrieval finds nothing?**
Because there is nothing to ground an answer in, so any text would come from the
model's own knowledge — exactly what the project forbids. Skipping the call also
makes abstention free in latency and in free-tier quota.

**Why stream at all if the answer is at most three sentences?**
The wait is dominated by the model's time to first token, not by the length of
the answer. Streaming shows the trace within a second and the first words as soon
as they exist, instead of a blank box for ten seconds.

**What stops the model from citing a document that was not retrieved?**
`toCitations` drops any number outside `1..hits.length`, so an invented
`[chunk-9]` never becomes a citation. The failure mode it does not catch is a
valid-but-wrong number.

**Why is the prompt kept to four sentences?**
Each additional instruction competes for attention with "use only this
evidence". The four rules are the ones a violation of which is visible: outside
knowledge, missing citation, no abstention, and length.

**Where would conversation history go?**
Between the `SystemMessage` and the `HumanMessage`: the messages array is built
in one place, so multi-turn context is an insertion there plus a decision about
how many earlier turns to include. Nothing in the design prevents it; the project
scopes it out.

**How does a client know the difference between "no evidence" and "the model
failed"?**
The abstention is a normal `finish` event with the standard sentence; a failure
throws, and the SSE route reports it as an `error` event. Two distinct shapes on
the wire ([Chat API](07-chat-api-and-event-streaming.md)).

## Related

- [Retrieval and relevance](05-retrieval-and-relevance.md) — the floor applied in
  `defaultDeps`.
- [Chat API and event streaming](07-chat-api-and-event-streaming.md) — how the
  events reach a browser, and how failures become status codes.
- [MCP endpoint and shared tools](08-mcp-endpoint-and-shared-tools.md) — the same
  tool, different policy.
- [Streaming client](https://github.com/YanMyoAungg/rag-sourcebook-client/blob/main/docs/04-streaming-client.md)
  — the consumer of these events.
