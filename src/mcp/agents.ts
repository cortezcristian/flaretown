// Platform MCP server at /mcp/agents (SPEC-api section 2).
// Stateless: a fresh server per request (createMcpHandler).
// External MCP clients reach it through Cloudflare Access, so they act as the human.

import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { HUMAN } from "../services/caller";
import { ServiceError } from "../services/errors";
import { allTools } from "../tools";

export const MCP_AGENTS_ROUTE = "/mcp/agents";

function createServer() {
  const server = new McpServer({ name: "flaretown-agents", version: "0.1.0" });

  for (const tool of allTools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      try {
        const result = await tool.run(env, HUMAN, tool.input.parse(args));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        const body = err instanceof ServiceError ? err.toJSON() : { error: String(err), code: "internal", hint: "" };
        return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true };
      }
    });
  }

  return server;
}

export const mcpAgentsHandler = createMcpHandler(createServer, { route: MCP_AGENTS_ROUTE });
