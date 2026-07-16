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
