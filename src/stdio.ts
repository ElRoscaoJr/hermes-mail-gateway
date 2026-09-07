import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MailApplicationService } from "./application/service.js";
import { createMcpServer } from "./mcp/server.js";

/** Starts MCP stdio; stdout is reserved exclusively for MCP protocol messages. */
export async function startStdio(service: MailApplicationService): Promise<void> {
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // An explicitly resumed stdin keeps a pipe-backed process alive between MCP messages.
  process.stdin.resume();
}
