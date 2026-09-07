import { OutboxRepository } from "../outbox/repository.js";
import type { SmtpAdapter, ImapAdapter } from "./adapters.js";
export async function executeOnce(repo: OutboxRepository, smtp: SmtpAdapter, imap: ImapAdapter, messageId: string, owner: string): Promise<ReturnType<OutboxRepository["get"]>> {
  const mime = repo.getRawMime(messageId);
  const current = repo.get(messageId); if (current.state === "SENT_VERIFIED") return current;
  const claimed = repo.claim(messageId, owner, 30_000);
  let smtpAttemptStarted = false;
  try {
    smtpAttemptStarted = true;
    const outcome = await smtp.submit(claimed.messageIdHeader, mime, { from: claimed.fromAddress, to: claimed.recipients });
    if (outcome === "REJECTED") return repo.transition(messageId, "FAILED_PERMANENT", "provider rejected submission");
    if (outcome === "PRE_SUBMISSION_FAILURE") return repo.transition(messageId, "FAILED_PERMANENT", "submission did not begin");
    if (outcome === "UNKNOWN") return repo.transition(messageId, "OUTCOME_UNKNOWN", "provider outcome could not be established");
    const verified = await imap.verifySent(claimed.messageIdHeader);
    return verified ? repo.transition(messageId, "SENT_VERIFIED", "exact Message-ID found in Sent") : repo.transition(messageId, "SENT_UNVERIFIED", "submission acknowledged but Sent verification failed");
  } catch (error) {
    if (!smtpAttemptStarted) throw error;
    return repo.transition(messageId, "OUTCOME_UNKNOWN", "provider outcome could not be established after submission began");
  }
}
