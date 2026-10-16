import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";

export const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: env.CLIENT_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/api/health", (c) => c.json({ status: "ok" }));
