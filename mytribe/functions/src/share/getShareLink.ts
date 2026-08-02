import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveShareLink } from '../lib/resolveShareLink';
import { FULL_CPU } from '../lib/runtimeOptions';

type ReqShape = Pick<Request, 'method' | 'path' | 'query'>;
type ResShape = {
  status: (n: number) => { json: (b: unknown) => void };
};

export async function getShareLinkHandler(req: ReqShape, res: ResShape): Promise<void> {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method-not-allowed' }); return; }
  const shareId = String(req.path).replace(/^\//, '').split('/')[0];
  if (!shareId) { res.status(400).json({ error: 'missing-share-id' }); return; }
  const passcode = String((req.query as Record<string, unknown> | undefined)?.passcode ?? '');
  const result = await resolveShareLink(shareId, passcode || undefined);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  logEvent({ severity: 'info', function: 'getShareLink', event: 'share.served', extra: { shareId } });
  // Include sourceKinTaleId at the top level so the unauth guest-comment form
  // can pass it back without exposing more of the share doc than necessary.
  res.status(200).json(result.payload);
}

export const getShareLink = onRequest(
  // Public, and verifies the passcode with argon2 (136ms of CPU per verify).
  // A share link can be pasted anywhere, so it needs burst headroom too.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], ...FULL_CPU },
  wrapHttp('getShareLink', async (req: Request, res: Response) => {
    await getShareLinkHandler(req as unknown as ReqShape, res as unknown as ResShape);
  }),
);
