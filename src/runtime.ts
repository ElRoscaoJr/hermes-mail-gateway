import { readFileSync } from "node:fs";
import { SafeError } from "./errors.js";
import { serverConfigSchema, type ServerConfig } from "./config/model.js";
import { KeychainCredentialStore, type CredentialResolver } from "./mail/credentials.js";
import { ImapFlowMailAdapter, NodemailerSmtpAdapter, parseSmtpEndpoint, type ImapFlowClientFactory } from "./mail/adapters.js";
import { MailGatewayService } from "./application/service.js";
import { openDatabase } from "./outbox/database.js";
import { AccountRepository } from "./outbox/accounts.js";
import { OutboxRepository } from "./outbox/repository.js";

export interface RuntimeDependencies {
  readonly credentials?: CredentialResolver;
  readonly imapClientFactory?: ImapFlowClientFactory;
}

export interface MailGatewayRuntime {
  readonly config: ServerConfig;
  readonly service: MailGatewayService;
  readonly close: () => void;
}

/** Loads and validates operator configuration without ever printing its contents. */
export function loadServerConfig(filename: string): ServerConfig {
  if (!filename.trim()) throw new SafeError("CONFIGURATION_MISSING", "An explicit mail gateway configuration path is required.");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filename, "utf8")); } catch { throw new SafeError("CONFIGURATION_INVALID", "Mail gateway configuration could not be read."); }
  const result = serverConfigSchema.safeParse(parsed);
  if (!result.success) throw new SafeError("CONFIGURATION_INVALID", "Mail gateway configuration failed validation.");
  return result.data;
}

/** Builds all account adapters from validated non-secret configuration and one injected credential store. */
export function createRuntime(config: ServerConfig, dependencies: RuntimeDependencies = {}): MailGatewayRuntime {
  for (const account of config.accounts) {
    if (account.allowedAttachmentRoots.some((root) => !config.attachmentRoots.includes(root))) throw new SafeError("CONFIGURATION_INVALID", "Each account attachment root must be listed in the server attachmentRoots policy.");
  }
  const db = openDatabase(config.databasePath);
  const accounts = new AccountRepository(db);
  for (const account of config.accounts) accounts.upsert(account);
  const outbox = new OutboxRepository(db);
  const credentials = dependencies.credentials ?? new KeychainCredentialStore();
  const adapters = new Map<string, { imap: ImapFlowMailAdapter; smtp: NodemailerSmtpAdapter }>();
  for (const account of config.accounts) {
    const smtp = parseSmtpEndpoint(account.smtpEndpoint);
    adapters.set(account.accountId, {
      imap: new ImapFlowMailAdapter({ account, credentials, ...(dependencies.imapClientFactory === undefined ? {} : { clientFactory: dependencies.imapClientFactory }) }),
      smtp: new NodemailerSmtpAdapter({ ...smtp, credentialRef: account.smtpCredentialRef ?? account.credentialRef, credentials }),
    });
  }
  const service = new MailGatewayService(accounts, outbox, adapters, config.limits.maxRecipients, config.limits.maxAttachmentBytes);
  return { config, service, close: () => db.close() };
}

/** Requires an explicit process configuration path; no default or dotenv loading is permitted. */
export function createRuntimeFromEnvironment(environment: NodeJS.ProcessEnv = process.env): MailGatewayRuntime {
  const filename = environment.HERMES_MAIL_CONFIG;
  if (!filename) throw new SafeError("CONFIGURATION_MISSING", "HERMES_MAIL_CONFIG must name an explicit configuration file.");
  return createRuntime(loadServerConfig(filename));
}
