import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface BusinessContactDto {
  name: string;
  email: string;
  phone: string;
  /** Free-form business address, surfaced for completeness; rarely used. */
  address: string;
}

/**
 * Returns the public-facing contact details from `business_settings/singleton`.
 * Read-only, gated by signed-in. Operational fields (rates, schedules,
 * notification toggles) are NOT exposed here, admin-only.
 */
export async function getBusinessContactHandler(
  req: CallableRequest<unknown>,
): Promise<BusinessContactDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  // Doc-id split: Android writes `business_settings`, web/iOS historically wrote
  // `singleton`. Prefer the populated `business_settings` doc, fall back to
  // `singleton` so neither client's writes are silently invisible.
  let snap = await db().collection('business_settings').doc('business_settings').get();
  if (!snap.exists) {
    snap = await db().collection('business_settings').doc('singleton').get();
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const dto: BusinessContactDto = {
    name:    typeof data['businessName']    === 'string' ? (data['businessName']    as string) : '',
    email:   typeof data['businessEmail']   === 'string' ? (data['businessEmail']   as string) : '',
    phone:   typeof data['businessPhone']   === 'string' ? (data['businessPhone']   as string) : '',
    address: typeof data['businessAddress'] === 'string' ? (data['businessAddress'] as string) : '',
  };

  logEvent({ severity: 'info', function: 'getBusinessContact', event: 'portal.businessContact.resolved', uid });
  return dto;
}

export const getBusinessContact = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getBusinessContact', getBusinessContactHandler),
);
