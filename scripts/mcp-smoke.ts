import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const mcpUrl = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const query = process.argv[2] ?? "How does pgvector store embeddings?";

function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

const client = new Client({ name: "rag-sourcebook-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

console.log(`Connected to ${mcpUrl}`);
const { tools } = await client.listTools();
console.log(`Tools: ${tools.map((tool) => tool.name).join(", ")}`);

const result = await client.callTool({
  name: "search_documents",
  arguments: { query, limit: 3 },
});

console.log(`\nsearch_documents("${query}"):`);
if (result.isError) {
  console.error(textOf(result));
  process.exitCode = 1;
} else {
  console.log(textOf(result));
}

await client.close();
