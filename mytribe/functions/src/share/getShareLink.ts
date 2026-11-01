import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveShareLink } from '../lib/resolveShareLink';
import { FULL_CPU } from '../lib/runtimeOptions';

type ReqShape = Pick<Request, 'method' | 'path' | 'query' | 'body'>;
type ResShape = {
  status: (n: number) => { json: (b: unknown) => void };
};

function bodyString(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return '';
  const v = (body as Record<string, unknown>)[key];
  // Bounded so a huge string never reaches argon2 or the HMAC compare.
  return typeof v === 'string' && v.length <= 512 ? v : '';
}

/**
 * The share JSON endpoint the portal's Compose share screen reads.
 *
 * #1331. The passcode used to arrive as `GET ?passcode=`, which put it in
 * Cloud Functions request logs and any proxy log on the way. It now arrives
 * only in a POST body:
 *
 *  - `GET  /getShareLink/{id}`                         a share with no passcode,
 *    or the 401 that tells the client to ask for one. Output unchanged.
 *  - `POST /getShareLink/{id}  {"passcode": "..."}`    one argon2 verify; on a
 *    match the payload comes back with `unlockToken` (lib/shareUnlock.ts, the
 *    same HMAC token the `/share/<id>` page keeps in its cookie). The client
 *    hands that token to `addGuestKinTaleComment` instead of the passcode.
 *  - `POST /getShareLink/{id}  {"unlockToken": "..."}` a re-read with the token.
 *
 * A request that still carries `passcode` in the query is refused before the
 * share is read or argon2 runs, and the reply never repeats the value. The
 * old Compose screen was the only client that sent it, and it ships in the
 * same hosting release as this function.
 */
export async function getShareLinkHandler(req: ReqShape, res: ResShape): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }
  const query = (req.query as Record<string, unknown> | undefined) ?? {};
  if (Object.prototype.hasOwnProperty.call(query, 'passcode')) {
    logEvent({ severity: 'warn', function: 'getShareLink', event: 'share.passcode_in_url_refused' });
    res.status(400).json({ error: 'passcode-in-url' });
    return;
  }
  const shareId = String(req.path).replace(/^\//, '').split('/')[0];
  if (!shareId) { res.status(400).json({ error: 'missing-share-id' }); return; }
  const passcode = req.method === 'POST' ? bodyString(req.body, 'passcode') : '';
  const presented = req.method === 'POST' ? bodyString(req.body, 'unlockToken') : '';
  const result = await resolveShareLink(shareId, passcode || undefined, presented ? [presented] : []);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  logEvent({ severity: 'info', function: 'getShareLink', event: 'share.served', extra: { shareId } });
  // Include sourceKinTaleId at the top level so the unauth guest-comment form
  // can pass it back without exposing more of the share doc than necessary.
  // `unlockToken` is added only when this call verified a typed passcode.
  res.status(200).json(result.unlockToken ? { ...result.payload, unlockToken: result.unlockToken } : result.payload);
}

export const getShareLink = onRequest(
  // Public, and verifies the passcode with argon2 (136ms of CPU per verify).
  // A share link can be pasted anywhere, so it needs burst headroom too.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], ...FULL_CPU },
  wrapHttp('getShareLink', async (req: Request, res: Response) => {
    await getShareLinkHandler(req as unknown as ReqShape, res as unknown as ResShape);
  }),
);
