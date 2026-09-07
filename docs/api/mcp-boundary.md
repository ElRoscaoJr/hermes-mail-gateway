# MCP boundary

## `MailApplicationService`

Provider-independent application seam consumed by the MCP layer. Implementations own account routing, provider access, persistence, and the invariant that `mail_execute.accountId` must equal the prepared message's owning account. `verifyOnly: true` must perform an explicit no-send verification operation.

Methods:

- `mailAccounts(input, context)` — implements `mail_accounts`.
- `mailQuery(input, context)` — implements `mail_query`.
- `mailPrepare(input, context)` — implements `mail_prepare`; the sender is supplied by the account projection, not MCP input.
- `mailExecute(input, context)` — implements `mail_execute`.

Each call receives the fixed authorized caller `Hermes main` and a fresh UUID `correlationId`. Implementations may return a value or throw `SafeError`; unexpected exceptions are converted to `INTERNAL_SAFE_FAILURE`. Raw MIME is an internal repository value and is omitted from MCP content and structured results; binary values are never serialized as public tool output.

## `createMcpServer(service)`

Creates an SDK `McpServer` with exactly `mail_accounts`, `mail_query`, `mail_prepare`, and `mail_execute`. Each handler re-validates the strict Zod schema, returns redacted JSON in MCP `content` and `structuredContent`, and never exposes stack traces or provider diagnostics.

## `startStdio(service)`

Connects the server to the SDK `StdioServerTransport`. stdout is reserved for MCP protocol messages; application diagnostics must use an injected logger on a future operational composition root.

Example:

```ts
import { startStdio } from "hermes-mail-gateway";
const service = {
  mailAccounts: () => ({ accounts: [] }),
  mailQuery: () => ({ messages: [] }),
  mailPrepare: () => ({ state: "PREPARED" }),
  mailExecute: () => ({ state: "SENT_VERIFIED" })
};
await startStdio(service);
```
