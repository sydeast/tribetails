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
   * notification is simply undeliverable to them. The fan-out handler stamps the
   * channel subdoc `status: 'skipped'` and logs a warning (fail-soft, visible,
   * never silent). Genuine failures (missing template, provider error) still throw.
   */
  skipped?: boolean;
  /** Machine-readable reason for a `skipped` result (e.g. 'recipient_no_email'). */
  skipReason?: string;
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
