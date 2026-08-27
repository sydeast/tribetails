import argon2 from 'argon2';
import { db } from './firestoreAdmin';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';

/**
 * Shared "resolve a shared-KinTale link" lookup, extracted out of
 * `getShareLink.ts` so a second consumer (the server-rendered
 * `getSharedKinTalePage.ts`) doesn't have to duplicate the
 * revoked/expired/passcode/argon2 logic. `getShareLinkHandler` is the
 * original, externally-observed caller — its `res.status`/`res.json`
 * outputs must stay byte-identical (see functions/test/getShareLink.test.ts).
 */

export type ScrubbedSharePayload = {
  authorDisplayName?: string;
  body?: string;
  photos?: string[];
  [key: string]: unknown;
};

type ShareLinkDoc = {
  revoked: boolean;
  expiresAt: { toMillis: () => number };
  passcodeHash?: string | null;
  scrubbedPayload: ScrubbedSharePayload;
  tribeId: string;
  sourceKinTaleId?: string;
  /** Absent means allowed: `addGuestKinTaleComment` only refuses on an explicit `false`. */
  allowGuestComments?: boolean;
};

export type ShareLinkResolution =
  | {
      ok: true;
      /** `scrubbedPayload` + `sourceKinTaleId`, exactly what `getShareLink` returns as JSON. */
      payload: Record<string, unknown>;
      scrubbedPayload: ScrubbedSharePayload;
      sourceKinTaleId: string | null;
      tribeId: string;
      /**
       * Whether this share accepts guest comments. Surfaced beside the payload
       * rather than inside it (#625) so `getSharedKinTalePage` can decide whether
       * to draw the comment form, WITHOUT changing `payload`, whose JSON shape
       * `getShareLink` is externally observed on and must keep byte-identical.
       */
      allowGuestComments: boolean;
    }
  | {
      ok: false;
      status: 404 | 410 | 401;
      error: 'not-found' | 'revoked' | 'expired' | 'passcode-required';
    };

/**
 * Looks up `sharedKinTales/{shareId}`, checks revoked/expired/passcode, and
 * returns either the resolved payload or a typed error. Does not know about
 * HTTP — callers translate `status`/`error` into their own response shape
 * (JSON for `getShareLink`, HTML for `getSharedKinTalePage`).
 */
export async function resolveShareLink(
  shareId: string,
  passcode?: string,
): Promise<ShareLinkResolution> {
  const snap = await db().doc(`sharedKinTales/${shareId}`).get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'not-found' };
  }
  const data = snap.data() as ShareLinkDoc;
  if (data.revoked) {
    return { ok: false, status: 410, error: 'revoked' };
  }
  if (data.expiresAt.toMillis() < Date.now()) {
    await snap.ref.update({ revoked: true });
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.CONTENT_SHARE_LINK_EXPIRED,
      severity: 'info',
      actorRole: 'SYSTEM',
      familyId: data.tribeId,
      payload: { shareId },
    });
    return { ok: false, status: 410, error: 'expired' };
  }
  if (data.passcodeHash) {
    const supplied = passcode ?? '';
    if (!supplied || !(await argon2.verify(data.passcodeHash, supplied))) {
      return { ok: false, status: 401, error: 'passcode-required' };
    }
  }
  const sourceKinTaleId = data.sourceKinTaleId ?? null;
  return {
    ok: true,
    payload: { ...data.scrubbedPayload, sourceKinTaleId },
    scrubbedPayload: data.scrubbedPayload,
    sourceKinTaleId,
    tribeId: data.tribeId,
    // `!== false`, not truthiness: a share document written before this field
    // existed carries no value and must keep accepting comments. That is the
    // same test `addGuestKinTaleComment` applies server-side, and the two must
    // not drift, or the page draws a form the callable will refuse.
    allowGuestComments: data.allowGuestComments !== false,
  };
}
