import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";
import { chatRouter } from "./routes/chat.js";
import { documentsRouter } from "./routes/documents.js";

export const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: env.CLIENT_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.route("/api", documentsRouter);

app.route("/api", chatRouter);

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((error, c) => {
  console.error("unhandled request error", error);
  return c.json({ error: "internal server error" }, 500);
});
