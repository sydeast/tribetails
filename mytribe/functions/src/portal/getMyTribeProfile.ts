import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { hasKinfolkPerm } from '../lib/memberGate';
import { readStoredEmergencyContacts } from '../lib/emergencyContacts';

interface GetMyTribeProfileRequest { kinfolkId?: string }

interface CustomField { key: string; label: string; value: string }

interface TribeProfileDto {
  kinfolkId: string;
  displayName: string;
  customFields: CustomField[];
}

interface HomeAccessDto {
  gateCode: string | null;
  keyLocation: string | null;
  wifiPassword: string | null;
  customFields: CustomField[];
  updatedAtMs: number | null;
}

interface GetMyTribeProfileResult {
  profile: TribeProfileDto;
  homeAccess: HomeAccessDto;
  /** #843: may this caller change home details, the Emergency Contact included. Same `home_access` rule saveTribeProfile enforces. */
  canEditHomeDetails: boolean;
}

export async function getMyTribeProfileHandler(
  req: CallableRequest<GetMyTribeProfileRequest>,
): Promise<GetMyTribeProfileResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyTribeProfile');

  const [familySnap, kinfolkSnap] = await Promise.all([
    firestore.collection('families').doc(kinfolkId).get(),
    firestore.doc(`kinfolk/${kinfolkId}`).get(),
  ]);
  const fam = (familySnap.data() ?? {}) as Record<string, unknown>;
  const profile: TribeProfileDto = {
    kinfolkId,
    displayName: typeof fam['displayName'] === 'string' ? (fam['displayName'] as string) : `Tribe ${kinfolkId}`,
    customFields: withLegacyEmergencyContactRows(
      parseCustomFields(fam['customFields']),
      (kinfolkSnap.data() ?? {}) as Record<string, unknown>,
    ),
  };

  const [accessSnap, canSeeHome] = await Promise.all([
    firestore.doc(`families/${kinfolkId}/homeAccess/current`).get(),
    hasKinfolkPerm(uid, kinfolkId, 'home_access', req.auth?.token?.admin === true, 'getMyTribeProfile'),
  ]);
  const acc = (accessSnap.data() ?? {}) as Record<string, unknown>;
  const homeAccess: HomeAccessDto = {
    gateCode: canSeeHome ? stringOrNull(acc['gateCode']) : null,
    keyLocation: canSeeHome ? stringOrNull(acc['keyLocation']) : null,
    wifiPassword: canSeeHome ? stringOrNull(acc['wifiPassword']) : null,
    customFields: canSeeHome ? parseCustomFields(acc['customFields']) : [],
    updatedAtMs: canSeeHome ? tsMillis(acc['updatedAt']) : null,
  };

  logEvent({ severity: 'info', function: 'getMyTribeProfile', event: 'portal.tribe.resolved', uid, extra: { kinfolkId } });
  return { profile, homeAccess, canEditHomeDetails: canSeeHome };
}

function parseCustomFields(v: unknown): CustomField[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      key: typeof x['key'] === 'string' ? (x['key'] as string) : '',
      label: typeof x['label'] === 'string' ? (x['label'] as string) : '',
      value: typeof x['value'] === 'string' ? (x['value'] as string) : '',
    }))
    .filter((c) => c.key.length > 0);
}
const LEGACY_EMERGENCY_CONTACT_KEYS: ReadonlySet<string> = new Set([
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
]);

/**
 * #829, old clients. Portal Android before Task 10 and cached portal web bundles
 * show and re-send the Emergency Contact as these three customFields rows. They
 * are served from the real store, kinfolk slot 1 (the kinfolk's own flat fields
 * count until the migration runs), overriding any families copy, so an old
 * client shows the current contact and its echo on save matches slot 1 in
 * saveTribeProfile. With no kinfolk contact the families copy passes through
 * as stored. New portal web lists these keys in PROFILE_RESERVED_KEYS and never
 * reads them.
 */
function withLegacyEmergencyContactRows(fields: CustomField[], kinfolk: Record<string, unknown>): CustomField[] {
  const slot1 = readStoredEmergencyContacts(kinfolk).contacts[0];
  if (!slot1) return fields;
  return [
    ...fields.filter((f) => !LEGACY_EMERGENCY_CONTACT_KEYS.has(f.key)),
    { key: 'emergencyContactName', label: 'Emergency Contact', value: slot1.name },
    { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: slot1.phone },
    ...(slot1.relationship ? [{ key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: slot1.relationship }] : []),
  ];
}

function stringOrNull(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
function tsMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === 'number') return v;
  return null;
}

export const getMyTribeProfile = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyTribeProfile', getMyTribeProfileHandler),
);
