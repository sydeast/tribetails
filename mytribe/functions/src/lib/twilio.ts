import type Twilio from 'twilio';
import { sendsAreSuppressed, suppressedId, logSuppressedSend } from './sendGuard';

let cached: ReturnType<typeof Twilio> | null = null;

/**
 * Suppressed stand-in for the Twilio client. Returned instead of the real
 * client when SEND_SUPPRESS=1, so no caller can reach a customer without
 * every call site having to remember a check.
 *
 * The client's used surface is exactly `messages.create` (3 call sites:
 * notifications/senders/smsChannel.ts, admin/sendExternalMessage.ts,
 * admin/broadcastMessage.ts). If a caller ever needs another Twilio API, this
 * stub must grow with it, and the cast below is what will stop compiling.
 */
function suppressedClient(): ReturnType<typeof Twilio> {
  return {
    messages: {
      create: async (opts: { to?: string; body?: string }) => {
        logSuppressedSend('sms', opts.to ?? '(no to)', opts.body ?? '');
        return { sid: suppressedId('sms'), status: 'suppressed' };
      },
    },
  } as unknown as ReturnType<typeof Twilio>;
}

/**
 * Returns a memoised Twilio client. Reads TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
 * from process.env (Cloud Functions secrets must be declared on the consuming
 * Function's `secrets:` array, typically the channel trigger).
 *
 * Throws if either secret is missing rather than silently degrading.
 *
 * When SEND_SUPPRESS=1 this returns a stub that logs and never contacts Twilio
 * (see lib/sendGuard.ts). Secrets are not required in that mode, so a non-prod
 * deploy needs no Twilio credentials at all.
 *
 * The SDK is loaded at first real send, not at file scope, because the Functions
 * runtime loads all of `index.js` on every cold start whatever the target is,
 * and the SMS senders are a handful of functions out of 227. The suppressed
 * path never loads it at all, so SEND_SUPPRESS=1 deploys and the whole test
 * suite pay nothing for a client they will never call.
 */
export async function getTwilio(): Promise<ReturnType<typeof Twilio>> {
  if (cached) return cached;
  if (sendsAreSuppressed()) {
    cached = suppressedClient();
    return cached;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid) throw new Error('TWILIO_ACCOUNT_SID environment variable is required');
  if (!token) throw new Error('TWILIO_AUTH_TOKEN environment variable is required');
  const { default: TwilioSdk } = await import('twilio');
  cached = TwilioSdk(sid, token);
  return cached;
}

export function getTwilioFromNumber(): string {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error('TWILIO_FROM_NUMBER environment variable is required');
  return from;
}
