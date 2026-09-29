import { requireBaseUrl } from './requireBaseUrl';
import { sendFromTemplate } from './sendFromTemplate';
import { loadEmailFrame } from './emailFrameStore';

/**
 * The env vars the three invite emails below need, read and validated
 * fail-loud (see `requireBaseUrl`) and BEFORE any Firestore write: a caller
 * mints nothing it cannot then tell the invitee, the business, or the
 * primary about. `AUNTIE_OS_REVIEW_BASE_URL` is only guarded when this run
 * will actually use it (`AUNTIE_NOTIFY_EMAIL` set).
 */
export interface InviteEmailConfig {
  claimBaseUrl: string;
  /** Null when `AUNTIE_NOTIFY_EMAIL` is not configured: that email is skipped, not sent to a broken address. */
  auntieNotify: { email: string; reviewBaseUrl: string } | null;
}

export function resolveInviteEmailConfig(): InviteEmailConfig {
  const claimBaseUrl = requireBaseUrl('CLAIM_LINK_BASE_URL');
  const auntieNotifyEmail = process.env.AUNTIE_NOTIFY_EMAIL;
  const auntieNotify = auntieNotifyEmail
    ? { email: auntieNotifyEmail, reviewBaseUrl: requireBaseUrl('AUNTIE_OS_REVIEW_BASE_URL') }
    : null;
  return { claimBaseUrl, auntieNotify };
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
 * `invite.primary-receipt` only when `primaryEmail` is known.
 *
 * NEVER catches. `sendFromTemplate` throwing (a missing template, a send
 * failure) must reach the caller as a thrown error: a caller that reports
 * success on a swallowed failure is the exact defect item 3 exists to fix.
 * The invite doc is already written by the time this runs, so a failure here
 * leaves it at whatever status the caller left it before this call (e.g.
 * still `PENDING`), which is the honest state: created, not yet delivered.
 */
export async function sendPrimaryInviteEmails(args: SendPrimaryInviteEmailsArgs): Promise<void> {
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
}
