import type { z } from "zod";
import type { SafeResult } from "../errors.js";
import { mailAccountsSchema, mailExecuteSchema, mailPrepareSchema, mailQuerySchema } from "../mcp/schemas.js";

export type MailAccountsInput = z.infer<typeof mailAccountsSchema>;
export type MailQueryInput = z.infer<typeof mailQuerySchema>;
export type MailPrepareInput = z.infer<typeof mailPrepareSchema>;
export type MailExecuteInput = z.infer<typeof mailExecuteSchema>;

export interface ApplicationCallContext {
  readonly caller: "Hermes main";
  readonly correlationId: string;
}

/** Provider-independent application seam used by the MCP boundary. */
export interface MailApplicationService {
  mailAccounts(input: MailAccountsInput, context: ApplicationCallContext): Promise<unknown> | unknown;
  mailQuery(input: MailQueryInput, context: ApplicationCallContext): Promise<unknown> | unknown;
  mailPrepare(input: MailPrepareInput, context: ApplicationCallContext): Promise<unknown> | unknown;
  mailExecute(input: MailExecuteInput, context: ApplicationCallContext): Promise<unknown> | unknown;
}

export type ApplicationServiceResult = SafeResult<unknown>;
