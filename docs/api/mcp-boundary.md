# MCP boundary

## `MailApplicationService`

Provider-independent application seam consumed by the MCP layer. Implementations own account routing, provider access, persistence, and the invariant that `mail_execute.accountId` must equal the prepared message's owning account. `verifyOnly: true` must perform an explicit no-send verification operation.

Methods:

- `mailAccounts(input, context)` — implements `mail_accounts`.
- `mailQuery(input, context)` — implements `mail_query`.
- `mailPrepare(input, context)` — implements `mail_prepare`; the sender is supplied by the account projection, not MCP input.
- `mailExecute(input, context)` — implements `mail_execute`.

Each call receives the fixed authorized caller `Hermes main` and a fresh UUID `correlationId`. Implementations may return a value or throw `SafeError`; unexpected exceptions are converted to `INTERNAL_SAFE_FAILURE`. Raw MIME is an internal repository value and is omitted from MCP content and structured results; binary values are never serialized as public tool output.

`mail_execute` also accepts the strict action `{ type: "saveDraft", messageId }`. It operates only on an account-owned durable `PREPARED` message with `intent: "draft"`, resolves configured `draftsFolder` or selectable IMAP `\\Drafts`, and appends the stored MIME with `\\Draft`. The exact Message-ID and flag are verified before durable confirmation. Confirmed calls return only safe provider reference metadata; append exceptions or ambiguous UID results become non-retryable verification-required state. Normal execution never sends draft intent through SMTP, and `cancelPrepared` is available before provider submission.

## `MailGatewayService`

`MailGatewayService` is the application composition used by the MCP boundary:

```ts
new MailGatewayService(accounts, outbox, new Map([
  ["acct", { imap: imapAdapter, smtp: smtpAdapter }]
]))
```

It resolves every account explicitly and returns only safe account projections. With `includeHealth: false`, `mail_accounts` performs no provider calls; with health enabled, each enabled account gets independent no-send IMAP connectivity and SMTP `transport.verify()` checks, mapped to only `ok` or `failed`. A failed check does not fail the account listing. `mail_query` operation `folders` authenticates once and returns only `path`, `name`, `delimiter`, and optional `specialUse`; folder discovery is not part of account health. List/search use opaque cursors encoding account, folder, operation, last UID, and mailbox `UIDVALIDITY`; generation mismatches return `REFERENCE_STALE` before `afterUid` is applied. Read/attachments/thread references likewise encode and validate `UIDVALIDITY` before fetching. Search accepts strict provider-neutral filters and compiles representable criteria server-side; `hasAttachment` fails explicitly when safe representation is unavailable. `verifyOnly` verifies the persisted Message-ID without calling SMTP. `attachments` returns metadata by default; with `attachmentIndex`, it returns only selected filename, content type, size, SHA-256, and base64 bytes within configured and public bounds. Inline/content-ID and unsafe attachments are rejected. `thread` requires the requested folder to match the anchor reference folder, then searches only that folder with bounded server-side IMAP header criteria; results include the anchor, deduplicate UIDs, and are limited before return. Account configuration fields (`credentialRef`, endpoints, attachment roots, and policy), raw MIME, provider diagnostics, arbitrary provider folder fields, and raw attachment content never appear in its public results.

`mail_prepare` accepts separate `recipients` (To), `cc`, and `bcc` lists, optional `replyTo`, `inReplyTo`, and `references` headers, and optional forwarding metadata. Forwarding reads the source through the selected account’s IMAP adapter before preparation, derives bounded original Message-ID/Subject metadata, and appends a deterministic plain-text forwarded block to the caller’s prefix (or uses it as the body). Source attachments are copied as real MIME attachments only when bounded, validated bytes are available; otherwise preparation returns `UNSUPPORTED_OPERATION`. Account-bound opaque references reject cross-account reuse. The complete MIME is persisted before execution, and execution never rereads the source. BCC is an SMTP envelope recipient and is not emitted as a MIME `Bcc` header.

Mailbox summaries expose visible `Cc` addresses plus safe `Reply-To` and `In-Reply-To` metadata from the IMAP envelope. Full reads additionally expose bounded `References` and only `X-Hermes-Forwarded-Message-Reference`, `X-Hermes-Forwarded-Message-ID`, and `X-Hermes-Forwarded-Subject` as `forwarding` metadata. Bcc, arbitrary headers, raw MIME, and attachment bytes are excluded from public MCP output; content fields are omitted by the MCP serializer.

Batch sends are a caller-level sequence of independent prepare/execute pairs. Each message requires its own idempotency key; there is no batch tool and no cross-message transaction.

## Runtime configuration

`loadServerConfig(path)` reads one explicit JSON file and validates unique `accountId` values, credential-free endpoint URLs, sender addresses, attachment-root policy, and server limits. `maxQueryResults` defaults to 50 and is bounded at 100; `maxReadBytes` defaults to 1,000,000 and is bounded at 10,000,000. `createRuntime(config)` threads these limits into the service and IMAP adapters and reconciles expired outbox leases before exposing the service. `createRuntimeFromEnvironment()` requires `HERMES_MAIL_CONFIG`; it does not read dotenv files, accept configuration from MCP, or print configuration contents. `src/main.ts` starts stdio only after this composition succeeds and reports missing or invalid configuration on stderr with empty stdout.

Startup recovery changes expired `SEND_ATTEMPTED` rows to verification-required `OUTCOME_UNKNOWN`, clears execution ownership, preserves bounded evidence, and appends an audit event. It never submits SMTP automatically.

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
