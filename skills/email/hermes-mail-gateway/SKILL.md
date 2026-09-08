---
name: hermes-mail-gateway
description: Use a four-tool MCP mail gateway safely and reliably.
version: 1.0.0
author: Project contributors, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [email, MCP, IMAP, SMTP, Gmail, Zoho]
    related_skills: []
---

# Hermes Mail Gateway Skill

Use when Hermes has access to a four-tool MCP mail gateway backed by IMAP/SMTP. The gateway keeps account routing, durable preparation, idempotency, provider verification, mailbox mutations, drafts, and bounded attachment handling behind a small interface.

## When to use

Use this skill for Gmail, Zoho, or standard IMAP/SMTP mailbox work through the gateway.

Do not use it to bypass the gateway with raw SMTP/IMAP commands, guess localized folders, retrieve credentials, or perform permanent deletion.

## Prerequisites

- The MCP server is configured and exposes exactly:
  - `mail_accounts`
  - `mail_query`
  - `mail_prepare`
  - `mail_execute`
- The operator has provisioned credentials in the host keychain or Secret Service.
- Account metadata and folder names are supplied through an external configuration file.

## Quick reference

- `mail_accounts`: account discovery and optional no-send health checks.
- `mail_query`: folders, list, search, structured search, read, thread, attachments, bounded attachment download, and Sent verification.
- `mail_prepare`: durable send or draft preparation.
- `mail_execute`: send, verify, save draft, cancel local preparation, mark, move, copy, trash, and restore.

## Procedure

1. Select the target `accountId` explicitly. Never infer it from a recipient or sender.
2. Call `mail_query` with `operation: "folders"` when folder names are unknown. Use only selectable folders returned by the provider.
3. For list/search, use a bounded limit and an opaque cursor returned by the previous call. Prefer structured filters (`from`, `to`, `cc`, `subject`, `since`, `before`, `isRead`, `isFlagged`, `messageId`) over provider-specific query syntax.
4. Preserve opaque message references unchanged. They are account- and UIDVALIDITY-bound and must not be edited or decoded manually.
5. Read a message or thread before replying or forwarding. Let `mail_prepare` construct the reply/forward headers and MIME.
6. For an outgoing message, call `mail_prepare` first with a unique idempotency key. Never send directly from an unpersisted draft or raw MIME.
7. Call `mail_execute` only for the prepared message. Treat SMTP acceptance as an intermediate result until the gateway reports durable Sent verification.
8. If the result is `UNKNOWN` or `SENT_UNVERIFIED`, do not resend. Use the gateway's verification mode or escalate to the operator.
9. For drafts, prepare with `intent: "draft"`, then execute `action.type: "saveDraft"`. Repeating the same idempotent action is safe; changing the request under the same key is a conflict.
10. Request attachment bytes only for a selected attachment and only when needed. Respect the configured byte limit; metadata is safer by default.
11. Use `markRead`, flags, move, copy, or restore for mailbox organization. `trash` means move to provider Trash.
12. Never request `EXPUNGE`, permanent delete, Trash purging, raw provider diagnostics, credentials, BCC, or raw MIME in a user-facing response.

## Safety rules

- Every operation must include the correct `accountId`.
- Never retry an ambiguous SMTP or draft `APPEND` outcome automatically.
- Never add an extra IMAP APPEND to provider-managed Sent unless the account policy explicitly requires it.
- Do not expose local paths, keychain references, passwords, tokens, arbitrary headers, or provider error bodies.
- Gmail native labels and Zoho native tags may require provider-specific APIs; do not pretend that a folder or flag is an equivalent native label.
- Real-mail tests must use only operator-authorized recipients and should use disposable data and attachment roots.

## Verification

A task is complete only when the tool result provides evidence for the requested operation:

- reads/searches: account-bound reference and bounded result;
- sends: durable state plus exact Message-ID verification when required;
- drafts: provider folder, UID/UIDVALIDITY-bound reference, and idempotent save state;
- mutations: provider-confirmed mutation result;
- downloads: selected filename, size, SHA-256, and bounded bytes.

If verification is missing or ambiguous, report the uncertainty and do not claim success.
