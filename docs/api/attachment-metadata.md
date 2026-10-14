# Attachment metadata normalization

The mail adapter exports two helpers that normalize provider-controlled attachment metadata before it is returned by the MCP or used to prepare a forwarded message.

## `safeAttachmentFilename(value, index)`

```ts
safeAttachmentFilename(value: unknown, index: number): string
```

- Normalizes Unicode to NFC and keeps only the final path component, recognizing both `/` and `\\` separators.
- Removes control and bidirectional-formatting characters, replaces platform-reserved filename characters with `_`, strips trailing dots/spaces, and prefixes Windows device names such as `CON`.
- Caps the result at 255 UTF-8 bytes without splitting a code point.
- Returns `attachment-${index + 1}.bin` for non-string, empty, dot-only, or otherwise unusable names. `index` is zero-based; an invalid index uses `attachment-1.bin`.

Examples:

```ts
safeAttachmentFilename("folder\\invoice?.pdf", 0); // "invoice_.pdf"
safeAttachmentFilename("..", 0);                    // "attachment-1.bin"
safeAttachmentFilename("CON.txt", 0);                // "_CON.txt"
```

## `safeAttachmentContentType(value)`

```ts
safeAttachmentContentType(value: unknown): string
```

Validates and lowercases the media type, discards optional parameters, and returns `application/octet-stream` when the input is absent, too long, malformed, or contains CR/LF. Removing parameters keeps the public projection to a stable media type without trusting arbitrary provider text.

Examples:

```ts
safeAttachmentContentType("Text/Plain; charset=utf-8"); // "text/plain"
safeAttachmentContentType("application/pdf\r\nX-Evil: value"); // "application/octet-stream"
```

These helpers normalize metadata only; they do not decode, store, or execute attachment bytes. Download authorization, UID/UIDVALIDITY checks, supported transfer encodings, byte verification, hashing, and size bounds remain enforced by the adapter.

## Size semantics

- `mail_query(operation: "attachments")` without `attachmentIndex` is metadata-only. Its optional `encodedSize` is the raw transfer-encoded MIME part length announced by IMAP `BODYSTRUCTURE`; Base64 or quoted-printable overhead means it can differ from the decoded file size.
- A parsed `read`/thread attachment and an explicit selected download use `size` for decoded file octets. Download `size` matches the decoded `contentBase64` bytes; `sha256` is calculated over those decoded bytes.
- Metadata listing does not fetch attachment contents to estimate decoded size. Consumers must not use `encodedSize` as a decoded-size estimate for the file.
