# Controlled real-provider self-test

This is an operator-run checklist, not an automated test. It must use only:

- one operator-owned self-test recipient, written as `<operator-self-test-address>` below;
- a disposable SQLite database that is not used by any other gateway process;
- credentials provisioned manually in the host keychain/Secret Service;
- a configuration file stored outside this repository.

Never use a customer, colleague, mailing list, forwarding address, or any other third-party recipient. Do not put the recipient address, credential values, provider transcripts, or mailbox content in this repository. Do not use commands that print credential values or configuration contents.

## 1. Preflight and isolation

1. Confirm that `<operator-self-test-address>` is controlled by the operator and is the only recipient that will be used.
2. Copy `config.example.json` to an external operator directory. Replace only the synthetic provider endpoints, sender addresses, folders, keychain references, and paths with values belonging to the operator. Keep the file outside this repository and do not commit it.
3. Set `databasePath` to a newly created disposable database path. Do not point it at a production database or an existing gateway database.
4. Set `attachmentRoots` and both accounts' `allowedAttachmentRoots` to a disposable directory containing no confidential files. Create one harmless, non-sensitive text fixture there and record its byte size and SHA-256 locally.
5. Ensure the selected account's `allowedSender` is the operator's self-test mailbox and that its `sentFolder` is the provider's actual Sent folder. Set `sentPolicy` according to the provider's documented behavior; do not add a gateway append policy without a separate, deliberate test.
6. Create the keychain entries referenced by the external configuration. Store the provider username and password/app-password in the host keychain only. For a new entry, run the repository helper from an interactive terminal, supplying only the non-secret service and account values as arguments; it prompts for the password without echoing it:

   ```sh
   node scripts/store-keychain-credential.mjs hermes-mail-gateway user@example.test
   ```

   The helper requires a TTY, never accepts a password argument or environment variable, and reports only a generic failure. Do not place secrets in shell history, the JSON file, logs, SQLite, or this document. Verify entries through the keychain UI or an equivalent operation that does not print secret values.
7. Build the checkout with `npm run build`. Start the compiled stdio server with `HERMES_MAIL_CONFIG` pointing to the external configuration. Keep protocol stdin/stdout connected to the MCP client; keep diagnostics on stderr.
8. Before any send operation, confirm that the disposable database is empty/new, the recipient is still `<operator-self-test-address>`, and the service reports no configuration error. If any check is uncertain, stop.

## 2. Account and mailbox discovery

1. Call `mail_accounts` with:

   ```json
   {"includeHealth":true}
   ```

2. Confirm that the intended account appears with the expected synthetic `accountId`, display name, sender, and enabled state. The response must not contain credential references or endpoint values.
3. Call `mail_query` first, before preparing anything:

   ```json
   {"accountId":"<configured-account-id>","operation":"list","folder":"<configured-inbox-folder>","limit":5}
   ```

4. Confirm that the configured inbox folder is reachable and that the result is bounded. If the folder is wrong, the account is wrong, or the provider is unavailable, stop. Do not prepare or execute a message.
5. Confirm the configured Sent folder and provider-managed/gateway-append policy from the external operator configuration. Do not infer them from a subject, timestamp, or SMTP acknowledgement.

## 3. Prepare one message (repeat only as separately reviewed, idempotent messages)

1. Use a fresh idempotency key that has never been used with this disposable database.
2. Call `mail_prepare` with exactly one recipient, the operator-owned self-test recipient, a unique test subject, a plain-text body, and the disposable fixture's exact path, byte size, SHA-256, and content type:

   ```json
   {
     "accountId":"<configured-account-id>",
     "idempotencyKey":"self-test-<fresh-unique-value>",
     "recipients":["<operator-self-test-address>"],
     "subject":"Hermes gateway controlled self-test <unique-value>",
     "textBody":"Controlled operator self-test; no response is requested.",
     "attachments":[
       {
         "path":"<external-disposable-attachment-path>",
         "size":<fixture-byte-size>,
         "sha256":"<fixture-sha256>",
         "contentType":"text/plain"
       }
     ]
   }
   ```

3. Record the returned `messageId`, `messageIdHeader`, account ID, and `PREPARED` state without copying raw MIME or credentials anywhere.
4. Confirm that the returned `messageIdHeader` is the exact value to verify later. Do not replace it with the subject, sender, date, or a newly generated ID.

For a controlled multi-message validation, repeat this prepare/execute lifecycle once per message with a fresh idempotency key and the same operator-approved recipient allow-list. There is deliberately no batch tool or cross-message transaction; never treat a loop as permission to retry an ambiguous message.

Optional routing fields may be added to a reviewed test: `cc`, `bcc`, `replyTo`, `inReplyTo`, `references`, and `forwarding`. Keep all recipients within the operator-approved external allow-list. Forwarding uses the account-scoped opaque source reference, reads the bounded source before preparation, synthesizes a deterministic plain-text forwarded block, and persists safe source attachment bytes in the new raw MIME. It never rereads the source during execution and rejects source attachments that cannot be obtained safely. The source reference must belong to the same account.

## 4. Execute once and classify the outcome

1. Call `mail_execute` once with the returned `messageId` and account ID:

   ```json
   {"accountId":"<configured-account-id>","messageId":"<returned-messageId>","verifyOnly":false}
   ```

2. If the result is `SENT_VERIFIED`, continue to Section 5.
3. If the result is `SENT_UNVERIFIED` or `OUTCOME_UNKNOWN`, stop immediately. Do not call normal execution again and do not create a second prepared message. Use the exact `messageIdHeader` in the explicit verification step below.
4. If the process exits, times out after submission began, or the result is otherwise ambiguous, treat it as `OUTCOME_UNKNOWN`. Do not retry.
5. A definitive pre-submission failure or provider rejection is not permission to blindly retry. Record the safe error/state, correct the external setup only if necessary, and start a separately reviewed test with a new disposable database and new idempotency key.

## 5. Verify the exact Message-ID

1. For `SENT_UNVERIFIED`, `OUTCOME_UNKNOWN`, or any operator-requested confirmation, call `mail_execute` with no send:

   ```json
   {"accountId":"<configured-account-id>","messageId":"<returned-messageId>","verifyOnly":true}
   ```

2. The gateway must search the configured Sent folder for the exact returned `messageIdHeader`, including angle brackets. A matching subject, recipient, timestamp, or sender is insufficient.
3. Continue only if the result reports `verified:true` and durable state `SENT_VERIFIED`. If it reports `verified:false`, leave the message unresolved and do not resend.
4. If exact verification later succeeds after an ambiguous outcome, use that one durable confirmation and do not execute the message normally again.

## 6. Verify the received message and attachment

1. In the operator-controlled self-test mailbox, locate the message by the exact `messageIdHeader`, not by subject alone.
2. Confirm there is exactly one received message for this test and exactly one attachment.
3. Confirm the attachment filename/content type as applicable, its byte size, and its SHA-256 match the disposable fixture recorded before preparation. Open it only as needed to confirm the content is the fixture; do not paste mailbox content into repository files or logs.
4. Use `mail_query` with `operation:"read"` and the returned mailbox message reference if the provider-side metadata must be checked through the gateway:

   ```json
   {"accountId":"<configured-account-id>","operation":"read","messageReference":"<returned-mailbox-reference>","limit":1}
   ```

   Confirm the returned message metadata includes the expected exact Message-ID and attachment metadata. The bounded `attachments` query may also be used with the same account-scoped opaque message reference; it returns filename, content type, and size only, never attachment bytes.

## 7. Stop and clean up

1. Record only safe outcome metadata: account ID, state, exact verification result, attachment hash/size, and any safe error code. Do not record credentials, raw MIME, message bodies, provider transcripts, or real addresses in the repository.
2. Stop the test process and remove the disposable database and fixture using the operator's approved local cleanup procedure. Do not remove a production database or any shared attachment directory.
3. Revoke or rotate the temporary host-keychain credential if it was created solely for this test.
4. Preserve the rule permanently: an ambiguous provider outcome is verified by exact Message-ID and is never resolved by a blind retry.
