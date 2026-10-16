import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { env } from "./config/env.js";

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`rag-sourcebook server listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
