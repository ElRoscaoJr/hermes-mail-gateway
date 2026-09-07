import { getCredential } from "cross-keychain";
import { SafeError } from "../errors.js";

export interface Credential {
  readonly username: string;
  readonly password: string;
}

export interface CredentialResolver {
  get(reference: string): Promise<Credential | null>;
}

export interface ParsedCredentialReference {
  readonly service: string;
  readonly account: string;
}

/** Parses only the explicit, non-ambiguous keychain:<service>/<account> form. */
export function parseCredentialReference(reference: string): ParsedCredentialReference {
  const match = /^keychain:([^/\\\s]+)\/([^/\\\s]+)$/.exec(reference);
  if (!match?.[1] || !match[2]) throw new SafeError("REFERENCE_INVALID", "Credential reference is invalid.");
  return { service: match[1], account: match[2] };
}

/** Resolves host credentials without exposing the secret to the MCP boundary. */
export class KeychainCredentialStore implements CredentialResolver {
  async get(reference: string): Promise<Credential | null> {
    const parsed = parseCredentialReference(reference);
    return getCredential(parsed.service, parsed.account);
  }
}
