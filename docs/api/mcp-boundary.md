# MCP boundary

## `MailApplicationService`

Provider-independent application seam consumed by the MCP layer. Implementations own account routing, provider access, persistence, and the invariant that `mail_execute.accountId` must equal the prepared message's owning account. `verifyOnly: true` must perform an explicit no-send verification operation.

Methods:

- `mailAccounts(input, context)` — implements `mail_accounts`.
- `mailQuery(input, context)` — implements `mail_query`.
- `mailPrepare(input, context)` — implements `mail_prepare`; the sender is supplied by the account projection, not MCP input.
- `mailExecute(input, context)` — implements `mail_execute`.

Each call receives the fixed authorized caller `Hermes main` and a fresh UUID `correlationId`. Implementations may return a value or throw `SafeError`; unexpected exceptions are converted to `INTERNAL_SAFE_FAILURE`. Raw MIME is an internal repository value and is omitted from MCP content and structured results; binary values are never serialized as public tool output.

## `MailGatewayService`

`MailGatewayService` is the application composition used by the MCP boundary:

```ts
new MailGatewayService(accounts, outbox, new Map([
  ["acct", { imap: imapAdapter, smtp: smtpAdapter }]
]))
```

It resolves every account explicitly, returns only safe account projections, bounds list/search results to the configured inbox or Sent folder, dispatches only to the adapter registered for that account, and delegates message preparation and non-verification execution to the existing durable domain functions. `verifyOnly` verifies the persisted Message-ID without calling SMTP. `thread` and `attachments` return `UNSUPPORTED_OPERATION`; they do not fall through to another operation. Bounded `read` includes attachment metadata, but there is no attachment-only query. Account configuration fields (`credentialRef`, endpoints, attachment roots, and policy) and raw MIME never appear in its public results.

`mail_prepare` accepts separate `recipients` (To), `cc`, and `bcc` lists, optional `replyTo`, `inReplyTo`, and `references` headers, and optional forwarding metadata. Forwarding reads the source through the selected account’s IMAP adapter before preparation, derives bounded original Message-ID/Subject metadata, and appends a deterministic plain-text forwarded block to the caller’s prefix (or uses it as the body). Source attachments are copied as real MIME attachments only when bounded, validated bytes are available; otherwise preparation returns `UNSUPPORTED_OPERATION`. Account-bound opaque references reject cross-account reuse. The complete MIME is persisted before execution, and execution never rereads the source. BCC is an SMTP envelope recipient and is not emitted as a MIME `Bcc` header.

Mailbox summaries expose visible `Cc` addresses plus safe `Reply-To` and `In-Reply-To` metadata from the IMAP envelope. Full reads additionally expose bounded `References` and only `X-Hermes-Forwarded-Message-Reference`, `X-Hermes-Forwarded-Message-ID`, and `X-Hermes-Forwarded-Subject` as `forwarding` metadata. Bcc, arbitrary headers, raw MIME, and attachment bytes are excluded from public MCP output; source attachment buffers remain an internal forwarding seam and are replaced by a binary omission marker by the MCP serializer.

Batch sends are a caller-level sequence of independent prepare/execute pairs. Each message requires its own idempotency key; there is no batch tool and no cross-message transaction.

## Runtime configuration

`loadServerConfig(path)` reads one explicit JSON file and validates unique `accountId` values, credential-free endpoint URLs, sender addresses, attachment-root policy, and server limits. `createRuntime(config)` upserts all configured account projections and injects one credential resolver into a distinct IMAP and SMTP adapter pair for each account. `createRuntimeFromEnvironment()` requires `HERMES_MAIL_CONFIG`; it does not read dotenv files, accept configuration from MCP, or print configuration contents. `src/main.ts` starts stdio only after this composition succeeds and reports missing or invalid configuration on stderr with empty stdout.

## `createMcpServer(service)`

Creates an SDK `McpServer` with exactly `mail_accounts`, `mail_query`, `mail_prepare`, and `mail_execute`. Each handler re-validates the strict Zod schema, returns redacted JSON in MCP `content` and `structuredContent`, and never exposes stack traces or provider diagnostics.

## `startStdio(service)`

Connects the server to the SDK `StdioServerTransport`. stdout is reserved for MCP protocol messages; the executable composition reports startup diagnostics on stderr.

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
