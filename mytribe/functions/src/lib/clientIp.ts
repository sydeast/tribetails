/**
 * The caller's IP as Google's front end saw it, for rate limiting and audit rows.
 *
 * COPIED FROM #891 (PR #908, `clientIpOf` in auth/loginSecurity.ts) with the same
 * name, signature and logic, for the #892 review. #908 has not merged. When it
 * does, confirmSecureReset imports `clientIpOf` from there and this file goes.
 *
 * WHY NOT THE FIRST `X-Forwarded-For` ENTRY. A caller can send its own
 * `X-Forwarded-For`, and Google keeps what was sent and appends after it, so the
 * first entry is whatever the caller wrote.
 *
 * WHY NOT `rawRequest.ip`. The Functions Framework enables Express `trust proxy`,
 * so `ip` is that same forgeable first entry.
 *
 * WHAT IS USED. The entry `TRUSTED_PROXY_HOPS` from the right, the one Google
 * appended. With no header at all (the emulator, a local call) it falls back to
 * `rawRequest.ip`, which is then the socket address, and then to 'unknown'.
 */

/**
 * How many proxies Google puts between the internet and this function that
 * each append one entry to `X-Forwarded-For`.
 */
const TRUSTED_PROXY_HOPS = 1;

export type RawRequestLike = { headers?: Record<string, string | string[] | undefined>; ip?: string } | undefined;

export function clientIpOf(rawRequest: RawRequestLike): string {
  const header = rawRequest?.headers?.['x-forwarded-for'];
  const joined = Array.isArray(header) ? header.join(',') : header ?? '';
  const entries = joined
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length > 0) {
    return entries[Math.max(0, entries.length - TRUSTED_PROXY_HOPS)]!;
  }
  const socketIp = typeof rawRequest?.ip === 'string' ? rawRequest.ip.trim() : '';
  return socketIp || 'unknown';
}
