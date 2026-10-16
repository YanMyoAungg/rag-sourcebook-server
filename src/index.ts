import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { closeVectorStore } from "./rag/vector-store.js";

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`rag-sourcebook server listening on http://localhost:${info.port}`);
});

let shuttingDown = false;

const shutdown = () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  server.close(() => {
    void Promise.allSettled([closeVectorStore(), pool.end()]).finally(() => {
      process.exit(0);
    });
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
