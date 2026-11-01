import { requireBaseUrl } from './requireBaseUrl';
import { sendFromTemplate } from './sendFromTemplate';
import { loadEmailFrame } from './emailFrameStore';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
/**
 * The env vars the three invite emails below need, read before any Firestore
 * write.
 *
 * `CLAIM_LINK_BASE_URL` is fail-loud (see `requireBaseUrl`): without it the
 * invitee's email carries no working claim link, so there is no invite worth
 * minting and the caller is refused.
 *
 * `AUNTIE_OS_REVIEW_BASE_URL` is NOT fail-loud (#1277). It is read only for the
 * `invite.auntie-notify` email, a courtesy copy to the business that links to
 * the admin review page. The invite itself, the invitee's email and the
 * primary's receipt never use it. Refusing the household's invite because the
 * business's own notice could not be linked blocked every invite in the portal
 * for a config gap only the operator could fix. Per `requireBaseUrl`'s own
 * priority order (works correctly > fails visibly > silent degradation), the
 * invite now works and the gap is made visible to the operator instead:
 * `auntieNotifySkipped` names the missing var, and the caller passes it to
 * `recordAuntieNoticeSkipped` once the invite exists, which logs an error and
 * writes a FAILURE audit row the daily error digest picks up.
 */
export interface InviteEmailConfig {
  claimBaseUrl: string;
  /** Null when `AUNTIE_NOTIFY_EMAIL` is not configured, or its review link cannot be built: that email is skipped, not sent with a broken link. */
  auntieNotify: { email: string; reviewBaseUrl: string } | null;
  /**
   * The env var name that stopped the Auntie notice, when `AUNTIE_NOTIFY_EMAIL`
   * IS set (the notice is wanted) but cannot be sent. Null when the notice is
   * going out, or was never configured at all.
   */
  auntieNotifySkipped: 'AUNTIE_OS_REVIEW_BASE_URL' | null;
}
export function resolveInviteEmailConfig(): InviteEmailConfig {
  const claimBaseUrl = requireBaseUrl('CLAIM_LINK_BASE_URL');
  const auntieNotifyEmail = (process.env.AUNTIE_NOTIFY_EMAIL ?? '').trim();
  if (!auntieNotifyEmail) return { claimBaseUrl, auntieNotify: null, auntieNotifySkipped: null };
  let reviewBaseUrl: string;
  try {
    reviewBaseUrl = requireBaseUrl('AUNTIE_OS_REVIEW_BASE_URL');
  } catch {
    return { claimBaseUrl, auntieNotify: null, auntieNotifySkipped: 'AUNTIE_OS_REVIEW_BASE_URL' };
  }
  return { claimBaseUrl, auntieNotify: { email: auntieNotifyEmail, reviewBaseUrl }, auntieNotifySkipped: null };
}
/**
 * #1277: the operator-visible half of a skipped Auntie notice. Called after the
 * invite was minted and its emails sent, so it can name the invite. An error
 * log line (Logs Explorer) and a FAILURE `activity_log` row, which
 * `errorDailyDigest` emails to `AUNTIE_NOTIFY_EMAIL` (set, or this would not
 * run). The audit write is best-effort: the household's invite already
 * succeeded, and a failed audit write must not turn that into an error.
 */
export async function recordAuntieNoticeSkipped(args: {
  functionName: string;
  missingVar: string;
  inviteId: string;
  familyId: string;
  uid: string | undefined;
}): Promise<void> {
  logEvent({
    severity: 'error',
    function: args.functionName,
    event: 'invite.auntieNotify.skipped',
    uid: args.uid,
    familyId: args.familyId,
    errorCode: 'config-missing',
    errorMessage: `${args.missingVar} is not configured; invite.auntie-notify was not sent`,
    extra: { inviteId: args.inviteId, missingVar: args.missingVar },
  });
  try {
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.MEMBERSHIP_INVITE_AUNTIE_NOTICE_SKIPPED,
      severity: 'warn',
      actorRole: 'SYSTEM',
      actorUid: args.uid,
      familyId: args.familyId,
      description: `Invite ${args.inviteId} was sent, but the Auntie notice was not: ${args.missingVar} is not configured.`,
      payload: { function: args.functionName, inviteId: args.inviteId, missingVar: args.missingVar },
    });
  } catch {
    // best-effort, see above
  }
}
export interface SendPrimaryInviteEmailsArgs {
  inviteId: string;
  invitedEmail: string;
  secondaryLabel: string;
  /** What the templates call `tribeName`: the family/tribe id, unresolved, matching existing template data (not a display name). */
  tribeName: string;
  claimBaseUrl: string;
  expiresInDays: number;
  proposedPermissions: Record<string, boolean>;
  /** From the inviting primary's auth token, when Firebase Auth has a name on file. */
  authorName: string | undefined;
  /** The inviting primary's own address, for their receipt copy. Null/undefined skips that send. */
  primaryEmail: string | null | undefined;
  auntieNotify: { email: string; reviewBaseUrl: string } | null;
}

/**
 * The three invite emails, extracted so `mintInviteFromPrimary` and
 * `addSecondaryContact` (#1018 item 3) send the identical set with identical
 * template data instead of drifting apart the way they had. Sends in order:
 * the invitee always, `invite.auntie-notify` only when `auntieNotify` is set,
 * `invite.primary-receipt` only when `primaryEmail` is known. Resolves to
 * whether the Auntie notice went out, so the caller stamps `auntieNotifiedAt`
 * only when it did.
 *
 * NEVER catches. `sendFromTemplate` throwing (a missing template, a send
 * failure) must reach the caller as a thrown error: a caller that reports
 * success on a swallowed failure is the exact defect item 3 exists to fix.
 * The invite doc is already written by the time this runs, so a failure here
 * leaves it at whatever status the caller left it before this call (e.g.
 * still `PENDING`), which is the honest state: created, not yet delivered.
 */
export async function sendPrimaryInviteEmails(args: SendPrimaryInviteEmailsArgs): Promise<{ auntieNotified: boolean }> {
  const claimUrl = `${args.claimBaseUrl}?invite=${args.inviteId}`;
  // #957: one frame read for up to three sends in this invocation.
  const frame = await loadEmailFrame('sendPrimaryInviteEmails');
  await sendFromTemplate('invite.secondary', args.invitedEmail, {
    primaryDisplayName: args.authorName ?? 'Your Kin Parent',
    secondaryDisplayName: args.invitedEmail,
    secondaryLabel: args.secondaryLabel,
    tribeName: args.tribeName,
    claimUrl,
    expiresInDays: args.expiresInDays,
  }, frame);
  if (args.auntieNotify) {
    await sendFromTemplate('invite.auntie-notify', args.auntieNotify.email, {
      primaryDisplayName: args.authorName ?? 'Kin Parent',
      invitedEmail: args.invitedEmail,
      secondaryLabel: args.secondaryLabel,
      tribeName: args.tribeName,
      permissionsCsv: Object.entries(args.proposedPermissions)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(','),
      auntieReviewUrl: `${args.auntieNotify.reviewBaseUrl}/invites/${args.inviteId}`,
    }, frame);
  }
  if (args.primaryEmail) {
    await sendFromTemplate('invite.primary-receipt', args.primaryEmail, {
      invitedEmail: args.invitedEmail,
      secondaryLabel: args.secondaryLabel,
      tribeName: args.tribeName,
      expiresInDays: args.expiresInDays,
    }, frame);
  }
  return { auntieNotified: args.auntieNotify !== null };
}
