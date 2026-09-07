import { OutboxRepository } from "../outbox/repository.js";
import type { SmtpAdapter, ImapAdapter, SmtpOutcome, SmtpSubmissionResult } from "./adapters.js";
function submissionResult(value: SmtpOutcome | SmtpSubmissionResult): SmtpSubmissionResult { return typeof value === "string" ? { outcome: value, evidence: "adapter_outcome" } : value; }
export async function executeOnce(repo: OutboxRepository, smtp: SmtpAdapter, imap: ImapAdapter, messageId: string, owner: string): Promise<ReturnType<OutboxRepository["get"]>> {
  const mime = repo.getRawMime(messageId);
  const current = repo.get(messageId); if (current.state === "SENT_VERIFIED") return current;
  const claimed = repo.claim(messageId, owner, 30_000);
  let outcome: SmtpSubmissionResult;
  try {
    outcome = submissionResult(await smtp.submit(claimed.messageIdHeader, mime, { from: claimed.fromAddress, to: claimed.recipients }));
  } catch (error) {
    return repo.transition(messageId, "OUTCOME_UNKNOWN", "provider outcome could not be established after submission began");
  }
  if (outcome.outcome === "REJECTED") return repo.transition(messageId, "FAILED_PERMANENT", outcome.evidence);
  if (outcome.outcome === "PRE_SUBMISSION_FAILURE") return repo.transition(messageId, "FAILED_PERMANENT", outcome.evidence);
  if (outcome.outcome === "UNKNOWN") return repo.transition(messageId, "OUTCOME_UNKNOWN", outcome.evidence);

  let verified = false;
  try {
    verified = await imap.verifySent(claimed.messageIdHeader);
  } catch {
    return repo.transition(messageId, "SENT_UNVERIFIED", "submission acknowledged but Sent verification failed safely");
  }
  return verified ? repo.transition(messageId, "SENT_VERIFIED", "exact Message-ID found in Sent") : repo.transition(messageId, "SENT_UNVERIFIED", "submission acknowledged but Sent verification failed");
}
