# 7. Chat API and event streaming

> Two routes over one pipeline: a buffered JSON endpoint and a Server-Sent
> Events endpoint that reports the trace and the answer as they happen, with one
> failure mapping shared by both.

## What it does

- `POST /api/chat` — `{ question }` in, `{ answer, citations, retrievedChunks }`
  out, as one JSON response.
- `POST /api/chat/stream` — `{ question }` in, a `text/event-stream` out whose
  events are the pipeline's own event union.

Both call the same generator from
[Grounded answering](06-grounded-answering.md). The difference is delivery: one
waits for the `finish` event, the other forwards every event as it is produced.

## How it works

### Shared body validation

```ts
const chatSchema = z.object({ question: z.string() });

const invalidBody = (c: { json: (body: unknown, status: 400) => Response }) =>
  c.json({ error: "request body must be JSON { question: string }" }, 400);
```

The same `zValidator` guard sits on both routes, so "no question field" and
"question is not a string" produce the identical 400 body either way. A
three-route API with three different error phrasings for the same mistake is the
thing this avoids.

### The JSON route

```ts
chatRouter.post("/chat", zValidator("json", chatSchema, …), async (c) => {
  const { question } = c.req.valid("json");
  try {
    return c.json(await answerQuestion(question));
  } catch (error) {
    const failure = describeChatFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
});
```

Five lines, and it inherits everything the pipeline does: trimming, the
relevance floor, abstention, citation mapping.

### The streaming route

```ts
// A reasoning model can spend a long time before its first token, so the
// connection is kept warm rather than left idle for the whole model call.
const SSE_HEARTBEAT_MS = 15_000;

chatRouter.post("/chat/stream", zValidator("json", chatSchema, …), async (c) => {
  const { question } = c.req.valid("json");
  if (question.trim().length === 0) {
    // Checked before the stream opens, so an empty question is still a
    // plain 400 rather than an error event.
    return c.json({ error: "question must not be empty" }, 400);
  }

  c.header("x-accel-buffering", "no");

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    const heartbeat = setInterval(() => {
      void stream.write(": keep-alive\n\n");
    }, SSE_HEARTBEAT_MS);

    try {
      for await (const event of streamAnswer(question, undefined, { signal: controller.signal })) {
        if (controller.signal.aborted) break;
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    } catch (error) {
      if (controller.signal.aborted) return;   // the client hung up; nobody to report to
      const failure = describeChatFailure(error);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: failure.message }) });
    } finally {
      clearInterval(heartbeat);
    }
  });
});
```

Five mechanisms, each earning its place:

1. **Empty questions are rejected before the stream opens.** Once SSE headers are
   sent the status is fixed at 200, so a question that is *knowably* bad is
   answered with a plain 400 while that is still possible. Everything that can
   only be discovered later becomes an `error` event.
2. **`x-accel-buffering: no`** is a proxy hint. A proxy that buffers a
   `text/event-stream` response would hold the whole answer until the model
   finished, which would defeat the endpoint entirely. (Verified on the deployed
   service: delta events arrive incrementally through Render's proxy.)
3. **A 15-second heartbeat** writes an SSE comment — a line beginning with `:`,
   which clients ignore by specification. Its purpose is purely to keep the
   connection from being considered idle while a reasoning model thinks.
4. **`stream.onAbort` aborts the model call.** Closing the tab stops generation
   instead of letting it run to completion for nobody — which also stops it
   spending free-tier quota.
5. **The abort check inside the loop** ends a stream whose client has gone away
   without throwing through the error path.

### What actually goes on the wire

`stream.writeSSE({ event, data })` produces one frame per event:

```text
event: tool
data: {"type":"tool","step":{"id":"step-1","tool":"search_documents","args":{"query":"…","limit":5},"state":"running"}}

event: tool
data: {"type":"tool","step":{"id":"step-1","tool":"search_documents","args":{…},"state":"complete","hits":[{"filename":"…","chunkIndex":1,"relevance":0.602}],"durationMs":912}}

event: text-delta
data: {"type":"text-delta","text":"Retries "}

: keep-alive

event: text-delta
data: {"type":"text-delta","text":"are handled by the worker."}

event: finish
data: {"type":"finish","result":{"answer":"… [chunk-1]","citations":[…],"retrievedChunks":[…]},"durationMs":3820}
```

The event name repeats the `type` inside the payload. That duplication is
deliberate: a client can switch on the frame name (cheap, no parse) or on the
parsed body (single code path), and both agree. The heartbeat appears only when
the model is slow — in a fast answer it never fires.

### One failure mapping for both routes

```ts
function describeChatFailure(error: unknown): ChatFailure {
  if (error instanceof SearchValidationError)      return { status: 400, message: error.message };
  if (error instanceof ChatModelNotConfiguredError) return { status: 503, message: error.message };
  if (error instanceof ChatGenerationError) {
    console.error("answer generation failed", error);
    return { status: 502, message: "answer generation failed" };
  }
  console.error("chat request failed", error);
  return { status: 500, message: "internal server error" };
}
```

| Failure | Status | Message | Cause it comes from |
| --- | --- | --- | --- |
| `SearchValidationError` | 400 | the error's own message | an empty question |
| `ChatModelNotConfiguredError` | 503 | names the three variables | any `CHAT_*` value missing or blank |
| `ChatGenerationError` | 502 | `"answer generation failed"` | the provider failed, timed out, or returned nothing |
| anything else | 500 | `"internal server error"` | a bug |

The streaming route reports the same four cases as `{ message }` in an `error`
event, using the same function — so the status semantics and the wording are
defined once. The two generation failures are logged with the full error (a
provider body or a stack) because the client only ever sees the safe message.

## Decisions and rejected alternatives

- **Server-Sent Events, not WebSockets.** The data flows one way: a question up,
  events down. SSE is plain HTTP, reconnects natively, needs no upgrade
  handshake, and works through the proxies this deployment actually uses.
- **The pipeline throws; this file translates.** `streamAnswer` knows nothing
  about HTTP status codes. That is what makes one mapping function usable by
  both routes, and it keeps the pipeline testable without a server.
- **Heartbeats rather than a longer proxy timeout.** A comment frame every
  fifteen seconds is one line of code and keeps any idle-connection detector
  happy, whatever its threshold happens to be.
- **`data` carries the whole event object, not just the payload.** The client's
  TypeScript union maps one-to-one onto the frames, and the trace's `step` object
  arrives exactly as the server typed it — no shape translation layer to get
  wrong.
- **Abort propagates all the way to the provider call.** `controller.signal`
  reaches `model.stream(..., { signal })`, so a closed tab aborts the HTTP
  request to OpenRouter rather than merely dropping the response.
- **No request logging on success.** The routes log failures with context; a
  logging middleware would emit a line per request for a service whose traffic
  is a person typing questions.

## Where it can bite you

- **After the first frame, the status is 200 forever.** That is why "empty
  question" is checked twice — once by the schema (missing/not a string) and once
  explicitly (blank) *before* `streamSSE` is entered. Any later failure must be
  an event.
- **A proxy that ignores `x-accel-buffering`** turns this endpoint into the
  buffered one with extra steps. The header is a hint, not a guarantee; the
  observable test is whether `text-delta` frames arrive before `finish`.
- **The heartbeat only helps connections that are still open.** If a model call
  exceeds `CHAT_TIMEOUT_MS` (45 s), the pipeline throws, the route sends an
  `error` event, and the client sees a stream that ended with a failure after
  keeping warm the whole time.
- **SSE frames are written with `await`**, so a slow client applies
  backpressure to the generator loop. That is intentional — it prevents an
  unbounded buffer — but it means a stalled reader stalls generation.
- **`stream.onAbort` fires when the client disconnects, not when the model
  fails.** A disconnected client means the error branch returns silently by
  design; there is no retry and no queue, so a dropped connection loses the
  answer.
- **The JSON route has no timeout of its own.** It inherits the 45-second model
  timeout (times up to two attempts) and holds the connection for the whole
  answer, with nothing keeping it warm in the meantime.

## Questions this invites

**Why does the JSON endpoint still exist if it can do nothing the stream cannot?**
Two reasons: it is the endpoint an MCP-less script or a `curl` user reaches for
first, and it is the one the test suite exercises without an SSE parser. It is
also the honest baseline — the buffered behaviour is what the streaming route is
improving on.

**What does the client see if the model call fails?**
A `finish` never arrives; an `error` event does, with the message the 502 route
would have used. The client's SSE reader turns that into a failed turn
([Streaming client](https://github.com/YanMyoAungg/rag-sourcebook-client/blob/main/docs/04-streaming-client.md)).

**Why is the empty-question check duplicated?**
They answer different questions. The schema check means "the body is not
`{ question: string }`" — a malformed request. The explicit check means "the
question is present but blank" — a well-formed request with no content. Both are
400s, and both must happen before the stream opens.

**What stops a hanging connection from living forever if the model never
responds?**
The 45-second timeout on the chat client. The heartbeat does not extend it; it
only keeps the *transport* from being declared idle while the model is thinking.

**Why not send the retrieved passages with each `text-delta`, so the UI can
render them earlier?**
Because they are already sent as soon as retrieval finishes, in the trace's
`complete` event — lightweight, without content. The full passages ride in the
`finish` event, once. Sending them repeatedly would multiply the streamed bytes
for no additional information.

**How would you add a second tool call to the trace?**
Give each call its own id (the current one is the constant `"step-1"`), emit
`running` before and `complete`/`error` after, and keep `AnswerEvent` unchanged —
the wire format already carries anything an ordered list of steps needs.

## Related

- [Grounded answering](06-grounded-answering.md) — the generator these routes
  drive.
- [MCP endpoint and shared tools](08-mcp-endpoint-and-shared-tools.md) — the
  non-browser consumer of the same retrieval.
- [Streaming client](https://github.com/YanMyoAungg/rag-sourcebook-client/blob/main/docs/04-streaming-client.md)
  — the frame parser on the other side.
