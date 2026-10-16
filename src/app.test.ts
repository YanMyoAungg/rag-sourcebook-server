import { describe, expect, it } from "vitest";
import { app } from "./app.js";
import { env } from "./config/env.js";

describe("GET /api/health", () => {
  it("returns 200 with { status: 'ok' }", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("CORS", () => {
  it("echoes the configured client origin", async () => {
    const res = await app.request("/api/health", {
      headers: { Origin: env.CLIENT_ORIGIN },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(
      env.CLIENT_ORIGIN,
    );
  });

  it("does not allow other origins", async () => {
    const res = await app.request("/api/health", {
      headers: { Origin: "https://evil.example" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers the preflight for the configured origin with the allowed methods", async () => {
    const res = await app.request("/api/documents", {
      method: "OPTIONS",
      headers: {
        Origin: env.CLIENT_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      env.CLIENT_ORIGIN,
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
