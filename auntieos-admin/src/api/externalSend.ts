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
}

export interface SendExternalMessageResult {
  ok: true;
  channel: ExternalChannel;
  /** The provider's own message id, or null when it gave none. Never an invented empty id. */
  providerMessageId: string | null;
  /** Masked local-part or middle digits. The only form of the recipient safe to render back. */
  recipientRedacted: string;
}

export async function sendExternalMessage(args: SendExternalMessageArgs): Promise<SendExternalMessageResult> {
  const subject = (args.subject ?? '').trim();
  const res = await call<
    { channel: ExternalChannel; to: string; subject?: string; body: string; transactional: boolean },
    { ok: true; channel: ExternalChannel; providerMessageId?: string | null; recipientRedacted?: string }
  >('sendExternalMessage', {
    channel: args.channel,
    to: args.to.trim(),
    ...(args.channel === 'email' && subject !== '' ? { subject } : {}),
    body: args.body.trim(),
    transactional: args.transactional ?? true,
  });

  return {
    ok: true,
    channel: res.channel,
    providerMessageId: typeof res.providerMessageId === 'string' && res.providerMessageId !== '' ? res.providerMessageId : null,
    recipientRedacted: typeof res.recipientRedacted === 'string' ? res.recipientRedacted : '',
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
