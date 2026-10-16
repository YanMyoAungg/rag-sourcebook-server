import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import { env } from "../config/env.js";
import { pool as defaultPool } from "../db/pool.js";
import { getDocument } from "../documents/repository.js";
import { SearchValidationError, searchDocuments } from "../rag/search.js";
import type { SearchDeps } from "../rag/search.js";
import { getVectorStore } from "../rag/vector-store.js";

// createMcpHonoApp()'s body parser stashes the parsed JSON body here; the
// package does not augment Hono's context variable map itself.
declare module "hono" {
  interface ContextVariableMap {
    parsedBody?: unknown;
  }
}

export interface McpDeps {
  pool: Pool;
  searchDeps: SearchDeps;
}

function defaultMcpDeps(): McpDeps {
  return { pool: defaultPool, searchDeps: { getVectorStore } };
}

export function createMcpServer(deps: McpDeps = defaultMcpDeps()): McpServer {
  const server = new McpServer({ name: "rag-sourcebook", version: "0.1.0" });

  server.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Semantic search over the indexed documents. Returns the best-matching " +
        "chunks with filename, chunk index, relevance, and content.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Natural-language search query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of chunks to return (default 5)"),
      }),
    },
    async ({ query, limit }) => {
      try {
        const hits = await searchDocuments(query, { limit }, deps.searchDeps);
        if (hits.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No matching chunks were found." }],
          };
        }
        const text = hits
          .map(
            (hit, index) =>
              `${index + 1}. ${hit.filename} (chunk ${hit.chunkIndex}, ` +
              `relevance ${hit.relevance.toFixed(3)})\n${hit.content}`,
          )
          .join("\n\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        if (error instanceof SearchValidationError) {
          return {
            content: [{ type: "text" as const, text: error.message }],
            isError: true,
          };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Fetch one indexed document by id: metadata plus the full original content.",
      inputSchema: z.object({
        documentId: z
          .string()
          .describe("Document id (uuid) as returned by search results"),
      }),
    },
    async ({ documentId }) => {
      const document = await getDocument(deps.pool, documentId);
      if (!document) {
        return {
          content: [
            { type: "text" as const, text: `No document with id ${documentId}.` },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `# ${document.filename}\n\n` +
              `id: ${document.id}\n` +
              `indexed: ${document.createdAt}\n` +
              `chunks: ${document.chunkCount}\n\n` +
              document.content,
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Hostnames to accept on the MCP endpoint. `MCP_ALLOWED_HOSTS` wins; on Render
 * the platform-provided hostname is used automatically; without either, the
 * integration's localhost-class default stays in effect for local dev.
 */
export function resolveAllowedHosts(source: {
  MCP_ALLOWED_HOSTS?: string;
  RENDER_EXTERNAL_HOSTNAME?: string;
}): string[] | undefined {
  const configured = (source.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (configured.length > 0) {
    return configured;
  }
  const platformHostname = source.RENDER_EXTERNAL_HOSTNAME?.trim();
  return platformHostname && platformHostname.length > 0
    ? [platformHostname]
    : undefined;
}

/**
 * Hono sub-app with the MCP Streamable HTTP endpoint at /mcp. A fresh server
 * and transport are created per request (stateless). Host-header validation
 * comes from the official integration: localhost-class hosts by default, or
 * the hosts named by MCP_ALLOWED_HOSTS / the platform (see
 * resolveAllowedHosts) when deployed.
 */
export function createMcpApp(deps: McpDeps = defaultMcpDeps()): Hono {
  const allowedHosts = resolveAllowedHosts({
    MCP_ALLOWED_HOSTS: env.MCP_ALLOWED_HOSTS,
    RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  });

  const mcpApp = createMcpHonoApp(allowedHosts ? { allowedHosts } : {});

  mcpApp.all("/mcp", async (c) => {
    const server = createMcpServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, {
      parsedBody: c.get("parsedBody"),
    });
  });

  return mcpApp;
}
