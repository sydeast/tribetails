import type { Channel, NotificationDef } from '../types';
import { sendEmailChannel } from './emailChannel';
import { sendSmsChannel } from './smsChannel';
import { sendPushChannel } from './pushChannel';

export interface ChannelSendArgs {
  def: NotificationDef;
  recipientUid: string;
  data: Record<string, unknown>;
}

export interface ChannelSendResult {
  providerMessageId?: string;
  /**
   * Set true when the channel could not deliver for a PERMANENT, non-error
   * reason that must NOT throw (so it is neither Sentry-captured nor retried by
   * Cloud Functions). Example: the recipient has no email on file, so an email
   * notification is simply undeliverable to them, and the same goes for a
   * household with no phone number and SMS ('recipient_no_phone', the throw that
   * was MYTRIBE-FUNCTIONS-C). The fan-out handler stamps the
   * channel subdoc `status: 'skipped'` and logs a warning (fail-soft, visible,
   * never silent). Genuine failures (provider error, misconfigured catalog row)
   * still throw.
   *
   * A MISSING TEMPLATE DOCUMENT is no longer one of those throws: email and push
   * fall back to generic wording (see `usedFallback`), and SMS skips with
   * `template_missing` rather than paying a segment to say nothing.
   */
  skipped?: boolean;
  /** Machine-readable reason for a `skipped` result (e.g. 'recipient_no_email'). */
  skipReason?: string;
  /**
   * Set true when the channel DELIVERED, but using the generic wording from
   * `notifications/fallbackTemplate` because the template document did not
   * exist. The message went out; it just could not say what happened.
   *
   * The fan-out handler stamps the channel subdoc so the admin surface can badge
   * it, and the sender logs at `error`. That combination is what keeps this a
   * DISCLOSED fallback rather than silent degradation: neither the recipient nor
   * the office is left in the dark. See fallbackTemplate.ts for why a missing
   * document is an operator-time content gap rather than a fault.
   */
  usedFallback?: boolean;
  /** Which template document was missing, so the log names what to author. */
  fallbackReason?: string;
}

export type ChannelSender = (args: ChannelSendArgs) => Promise<ChannelSendResult>;

/**
 * Channel registry.
 *
 * Each sender is responsible for:
 *   1. Resolving template per `def.templates[channel]`.
 *   2. Rendering with `data`.
 *   3. Looking up the recipient's contact handle (email, phone, FCM token).
 *   4. Calling provider SDK and returning provider message id.
 *   5. Throwing on any error, outer trigger wrap captures to Sentry.
 */
export const channelSenders: Record<Channel, ChannelSender> = {
  email: sendEmailChannel,
  sms: sendSmsChannel,
  push: sendPushChannel,
};
