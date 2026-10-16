import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { env } from "../config/env.js";
import { pool as defaultPool } from "../db/pool.js";
import { SearchValidationError } from "../rag/search.js";
import type { SearchDeps } from "../rag/search.js";
import { getDocumentTool, searchDocumentsTool } from "../rag/tools.js";
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
    searchDocumentsTool.name,
    {
      title: searchDocumentsTool.title,
      description: searchDocumentsTool.description,
      inputSchema: searchDocumentsTool.inputSchema,
    },
    async (input) => {
      try {
        const hits = await searchDocumentsTool.run(input, deps.searchDeps);
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
    getDocumentTool.name,
    {
      title: getDocumentTool.title,
      description: getDocumentTool.description,
      inputSchema: getDocumentTool.inputSchema,
    },
    async (input) => {
      const document = await getDocumentTool.run(input, { pool: deps.pool });
      if (!document) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No document with id ${input.documentId}.`,
            },
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
