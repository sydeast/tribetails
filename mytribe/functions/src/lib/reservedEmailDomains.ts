/**
 * Recipients that can never receive mail (#1076).
 *
 * WHY THIS EXISTS
 * Production holds addresses on invented domains (the sandbox household, the
 * demo families and the July invite tests all use `@tribetails.test`). Every
 * send path that reached them mailed them, the mail bounced, and the bounces
 * lowered the smtp2go sender reputation. The email primitive in lib/email.ts
 * is the only smtp2go caller, so refusing there covers the dispatcher, broadcasts,
 * Personalize, invites, password reset and recovery at once.
 *
 * WHAT IS REFUSED
 *   - the reserved TLDs `.test`, `.example`, `.invalid`, `.localhost` (RFC 2606
 *     and RFC 6761) and `.local` (RFC 6762, multicast DNS only);
 *   - the reserved domains `example.com`, `example.net`, `example.org` and any
 *     subdomain of them.
 * Matching is on whole labels, so `test.com` or `myexample.com` still send.
 *
 * WHAT A REFUSAL RETURNS
 * A marked id, the same shape as a SEND_SUPPRESS send (lib/sendGuard.ts). Every
 * caller already treats a returned id as "done", so a refusal never throws,
 * never counts as a failure and is never retried. The prefix makes the row
 * obvious in external_messages: it is not an smtp2go email_id.
 */

import { logEvent } from './logger';

export const REFUSED_ID_PREFIX = 'REFUSED_';

const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** The lowercased domain of an address with any trailing dots removed, or '' when it has none. */
function domainOf(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return '';
  return trimmed
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.+$/, '');
}

/**
 * True when the address's domain can never receive mail. An address with no
 * domain is not judged here; it is left to the provider as before.
 */
export function isReservedEmailDomain(address: string): boolean {
  const domain = domainOf(address);
  if (!domain) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (RESERVED_TLDS.has(tld)) return true;
  return RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** First character of the local part plus the full domain: `p***@tribetails.test`. */
function redact(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
}

/** Marked id for a refused send. Never mistaken for an smtp2go email_id. */
export function refusedId(): string {
  return `${REFUSED_ID_PREFIX}email_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The one log line for a refused send. Carries the template key when the
 * caller has one; the ad hoc senders (broadcast, Personalize) have none, so a
 * subject preview stands in.
 */
export function logRefusedSend(
  address: string,
  templateKey: string | undefined,
  subjectTemplate: string,
): void {
  logEvent({
    severity: 'warn',
    function: 'email',
    event: 'email.send.refusedReservedDomain',
    extra: {
      to: redact(address),
      ...(templateKey ? { templateKey } : { subjectPreview: subjectTemplate.slice(0, 60) }),
    },
  });
}
