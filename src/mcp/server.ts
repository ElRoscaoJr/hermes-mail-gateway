import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { SafeError } from "../errors.js";
import { redact } from "../observability/redaction.js";
import type { MailApplicationService } from "../application/service.js";
import { mailAccountsSchema, mailExecuteSchema, mailPrepareSchema, mailQuerySchema } from "./schemas.js";

const caller = "Hermes main" as const;

function safeError(error: unknown, correlationId: string): { ok: false; error: { code: string; message: string; correlationId: string } } {
  if (error instanceof ZodError) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Tool input failed validation.", correlationId } };
  }
  if (error instanceof SafeError) {
    return { ok: false, error: { code: error.code, message: error.message, correlationId } };
  }
  return { ok: false, error: { code: "INTERNAL_SAFE_FAILURE", message: "The mail operation could not be completed safely.", correlationId } };
}

function publicValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return "[BINARY_OMITTED]";
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["bcc", "content", "rawmime", "raw_mime", "uidvalidity"].includes(key.toLowerCase())).map(([key, item]) => [key, key === "folders" && Array.isArray(item) ? item.map((folder) => publicFolder(folder)) : publicValue(item)]));
  }
  return value;
}

function publicFolder(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const folder = value as Record<string, unknown>;
  return Object.fromEntries(["path", "name", "delimiter", "specialUse"].filter((key) => typeof folder[key] === "string").map((key) => [key, folder[key]]));
}

function jsonContent(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(redact(publicValue(value))) };
}

async function invoke<T>(parse: (value: unknown) => T, input: unknown, operation: (value: T, correlationId: string) => Promise<unknown> | unknown) {
  const correlationId = randomUUID();
  try {
    const parsed = parse(input);
    const value = await operation(parsed, correlationId);
    const structuredContent = redact(publicValue({ ok: true, value, correlationId })) as Record<string, unknown>;
    return { content: [jsonContent(structuredContent)], structuredContent };
  } catch (error) {
    const structuredContent = safeError(error, correlationId);
    return { isError: true, content: [jsonContent(structuredContent)], structuredContent };
  }
}

function parseWith<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  return schema.parse(value);
}

/** Creates the provider-independent MCP server with exactly the four mail tools. */
export function createMcpServer(service: MailApplicationService): McpServer {
  const server = new McpServer({ name: "hermes-mail-gateway", version: "0.1.0" });
  server.registerTool("mail_accounts", { description: "List configured mail account projections.", inputSchema: mailAccountsSchema }, (input) =>
    invoke((value) => parseWith(mailAccountsSchema, value), input, (value, correlationId) => service.mailAccounts(value, { caller, correlationId })));
  server.registerTool("mail_query", { description: "Query bounded mail data for one configured account.", inputSchema: mailQuerySchema }, (input) =>
    invoke((value) => parseWith(mailQuerySchema, value), input, (value, correlationId) => service.mailQuery(value, { caller, correlationId })));
  server.registerTool("mail_prepare", { description: "Persist an immutable message intent without sending it.", inputSchema: mailPrepareSchema }, (input) =>
    invoke((value) => parseWith(mailPrepareSchema, value), input, (value, correlationId) => service.mailPrepare(value, { caller, correlationId })));
  server.registerTool("mail_execute", { description: "Execute or explicitly verify a prepared message for its owning account.", inputSchema: mailExecuteSchema }, (input) =>
    invoke((value) => parseWith(mailExecuteSchema, value), input, (value, correlationId) => service.mailExecute(value, { caller, correlationId })));
  return server;
}
