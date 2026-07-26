import { call } from '../lib/fns';
import type { ExternalChannel } from '../lib/externalSend';

/**
 * "Send outside the tribe": one-off email or text to somebody who is not a
 * kinfolk, plus the opt-out that blocks future sends to them.
 *
 * Both callables are deployed and admin-gated (MyTribe
 * `functions/src/admin/sendExternalMessage.ts`). The server validates the
 * recipient, checks `message_suppressions`, appends the unsubscribe footer to
 * every email, sends through smtp2go or Twilio, records the send in
 * `external_messages`, and writes an audit entry with the recipient REDACTED so
 * `activity_log` never holds a plaintext one-off contact.
 *
 * The pre-flight that stops a doomed request leaving the browser lives in
 * `lib/externalSend.ts`. This module is the wire only.
 */

export interface SendExternalMessageArgs {
  channel: ExternalChannel;
  to: string;
  /** Required by the server on email, meaningless on sms, so it is not sent there. */
  subject?: string;
  body: string;
  /**
   * A transactional message is a 1:1 reply somebody is owed, and it SKIPS the
   * marketing suppression gate. Defaulting to true is deliberate: every send
   * this app makes from Communicate or Inbox is an operator writing to one
   * named person, and a bulk unsubscribe silently eating a personal reply is a
   * worse failure than the alternative. A genuine marketing blast passes false
   * explicitly, which is the case that should have to say so.
   */
  transactional?: boolean;
  /**
   * Ask the server to also record this send in `sms_messages` as an outbound
   * row, so an Inbox Channels thread reads as a conversation. SMS only, off by
   * default. Asking is a REQUEST, not an instruction: the server refuses unless
   * the number already has a row in that collection, because an `sms_messages`
   * row stores the number in the clear and everything else this callable writes
   * stores it redacted. Read the result, do not assume it happened.
   */
  mirrorToChannel?: boolean;
}

/** Why the server did not mirror the send. Clients branch on these, never on text. */
export type MirrorSkippedReason = 'not_requested' | 'no_existing_thread' | 'write_failed';

export interface SendExternalMessageResult {
  ok: true;
  channel: ExternalChannel;
  /** The provider's own message id, or null when it gave none. Never an invented empty id. */
  providerMessageId: string | null;
  /** Masked local-part or middle digits. The only form of the recipient safe to render back. */
  recipientRedacted: string;
  /** True only when an outbound row was really written to `sms_messages`. */
  mirrored: boolean;
  /** Null when mirrored. Otherwise the server's reason, for an honest banner. */
  mirrorSkippedReason: MirrorSkippedReason | null;
}

export async function sendExternalMessage(args: SendExternalMessageArgs): Promise<SendExternalMessageResult> {
  const subject = (args.subject ?? '').trim();
  // Only sent when asked. The server rejects `mirrorToChannel` on the email
  // channel outright rather than ignoring it, so never send it there.
  const wantsMirror = args.mirrorToChannel === true && args.channel === 'sms';
  const res = await call<
    {
      channel: ExternalChannel;
      to: string;
      subject?: string;
      body: string;
      transactional: boolean;
      mirrorToChannel?: boolean;
    },
    {
      ok: true;
      channel: ExternalChannel;
      providerMessageId?: string | null;
      recipientRedacted?: string;
      mirrored?: boolean;
      mirrorSkippedReason?: string | null;
    }
  >('sendExternalMessage', {
    channel: args.channel,
    to: args.to.trim(),
    ...(args.channel === 'email' && subject !== '' ? { subject } : {}),
    body: args.body.trim(),
    transactional: args.transactional ?? true,
    ...(wantsMirror ? { mirrorToChannel: true } : {}),
  });

  // `mirrored` is believed only when the server says so literally. A deploy that
  // predates this field returns undefined, which must read as "not mirrored" and
  // let the banner keep telling the operator the old truth, rather than claiming
  // a row exists in a list where none does.
  const mirrored = res.mirrored === true;
  const skipped = res.mirrorSkippedReason;
  return {
    ok: true,
    channel: res.channel,
    providerMessageId: typeof res.providerMessageId === 'string' && res.providerMessageId !== '' ? res.providerMessageId : null,
    recipientRedacted: typeof res.recipientRedacted === 'string' ? res.recipientRedacted : '',
    mirrored,
    mirrorSkippedReason: mirrored
      ? null
      : skipped === 'no_existing_thread' || skipped === 'write_failed'
        ? skipped
        : 'not_requested',
  };
}

export interface SuppressExternalRecipientArgs {
  channel: ExternalChannel;
  to: string;
}

export interface SuppressExternalRecipientResult {
  ok: true;
  channel: ExternalChannel;
  recipientRedacted: string;
}

/**
 * Records an opt-out. Every later non-transactional send to this recipient is
 * refused at the source with `failed-precondition recipient_opted_out`.
 */
export async function suppressExternalRecipient(
  args: SuppressExternalRecipientArgs,
): Promise<SuppressExternalRecipientResult> {
  const res = await call<
    { channel: ExternalChannel; to: string },
    { ok: true; channel: ExternalChannel; recipientRedacted?: string }
  >('suppressExternalRecipient', { channel: args.channel, to: args.to.trim() });

  return {
    ok: true,
    channel: res.channel,
    recipientRedacted: typeof res.recipientRedacted === 'string' ? res.recipientRedacted : '',
  };
}
