<!-- KEEL:BEGIN — v1.11.0 do not remove: binds every AI/session in this repo to the Keel workflow -->
# Keel protocol

This repository is governed by the Keel workflow. Before changing anything:

1. Read `.claude/skills/keel/SKILL.md` in full.
2. Read `docs/PROGRESS.md`, `docs/decisions.md`, and `docs/lessons-learned.md`.
3. Read the reference for the current phase named by `docs/PROGRESS.md`.
4. Do not re-litigate recorded decisions. Undefined requirements must be asked, not guessed.
5. Update living state files at the moment of every decision, change, and test point.
6. Before every commit, scan staged files for credentials, tokens, secrets, private keys, real customer data, and local account data. A finding stops the commit.
7. Never introduce blind retries for email sends. Every send path must be idempotent, auditable, and verifiable.

The version stamp on this block is authoritative for lock freshness. Refresh only through the Keel workflow.
<!-- KEEL:END -->
