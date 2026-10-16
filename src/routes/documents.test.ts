import { describe, expect, it } from "vitest";
import { app } from "../app.js";

async function postDocument(body: unknown): Promise<Response> {
  return app.request("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/documents", () => {
  it("rejects a body that is not { filename, content }", async () => {
    const res = await postDocument({ file: "x.txt" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it("rejects an unsupported file type", async () => {
    const res = await postDocument({ filename: "notes.pdf", content: "hello" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining(".txt"),
    });
  });

  it("rejects empty content", async () => {
    const res = await postDocument({ filename: "notes.txt", content: "   " });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/content/i),
    });
  });
});
