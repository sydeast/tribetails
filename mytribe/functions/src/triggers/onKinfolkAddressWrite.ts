import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  HOUSEHOLD_COLLECTION,
  geocodeHouseholdAddress,
  planHouseholdGeocode,
  serviceLocationErrorPatch,
  serviceLocationPatch,
} from '../lib/householdLocation';

/**
 * ISSUE #582: keeps `kinfolk/{id}.serviceLocation` in step with the address on
 * the same document.
 *
 * WHY A TRIGGER AND NOT A CALLABLE. Household addresses are written by a bare
 * client `updateDoc` from three surfaces — React's `kinfolkProfileWrite.ts`,
 * Android's `DirectoryViewModel`, the desktop `KinfolkEditScreen` — with no
 * callable in front of any of them. A trigger is therefore the ONLY hook that
 * sees every address change, and putting the geocode behind one new callable
 * would have left the other two paths silently stale.
 *
 * WHY NOT AT COMPLETE. The obvious alternative — geocode when the distance is
 * needed — puts a third-party HTTP call on the path that decides whether a
 * billable visit may be closed. A Mapbox outage would then stop operators
 * completing visits. Geocoding is done ahead of time, off the visit's critical
 * path, and a household with no coordinate never blocks anything.
 *
 * THE LOOP GUARD IS IN `planHouseholdGeocode`, and it has to cover the failure
 * branch as well as the success one: this trigger writes back to the document
 * that fires it, and the error record carries a timestamp, so "retry whenever
 * there is no coordinate" would spin on a single bad address forever. See that
 * function's comment for the three terminating states.
 *
 * A KNOWN-BAD ADDRESS IS NOT RETRIED HERE. It is retried by
 * `verifyVisitArrival`'s lazy path, which only runs when somebody is actually
 * standing at the house — rare enough to be worth another attempt, and the
 * right moment to re-test a transient outage.
 */

const MAPBOX_ACCESS_TOKEN = 'MAPBOX_ACCESS_TOKEN';

export interface KinfolkWriteEvent {
  params: { kinfolkId: string };
  data?: { after?: { data(): Record<string, unknown> | undefined } };
}

export async function onKinfolkAddressWriteHandler(event: KinfolkWriteEvent): Promise<void> {
  const kinfolkId = event.params.kinfolkId;
  const after = event.data?.after?.data();
  const plan = planHouseholdGeocode(after);

  if (plan.action === 'skip') {
    logEvent({
      severity: 'info',
      function: 'onKinfolkAddressWrite',
      event: 'household.geocode.skipped',
      extra: { kinfolkId, reason: plan.reason },
    });
    return;
  }

  const ref = db().collection(HOUSEHOLD_COLLECTION).doc(kinfolkId);

  if (plan.action === 'clear') {
    // The address was removed. A coordinate derived from an address the record
    // no longer carries is evidence about a place this household may have moved
    // away from, and keeping it would let a stale reading refuse a COMPLETE.
    await ref.set({ serviceLocation: null, serviceLocationError: null }, { merge: true });
    logEvent({
      severity: 'info',
      function: 'onKinfolkAddressWrite',
      event: 'household.geocode.cleared',
      extra: { kinfolkId, reason: plan.reason },
    });
    return;
  }

  const token = (process.env[MAPBOX_ACCESS_TOKEN] ?? '').trim();
  const outcome = await geocodeHouseholdAddress(plan.address, token);

  if (!outcome.ok) {
    // Recorded, never thrown. A household whose address will not geocode still
    // gets visits; it just gets them unverified, and the operator can see why.
    await ref.set(
      serviceLocationErrorPatch(plan.address, outcome.reason, new Date().toISOString()),
      { merge: true },
    );
    logEvent({
      severity: 'warn',
      function: 'onKinfolkAddressWrite',
      event: 'household.geocode.failed',
      extra: { kinfolkId, reason: outcome.reason },
    });
    return;
  }

  await ref.set(serviceLocationPatch(outcome.location), { merge: true });
  logEvent({
    severity: 'info',
    function: 'onKinfolkAddressWrite',
    event: 'household.geocode.stored',
    // The address and the coordinate both stay out of the log line: this record
    // is staff-only in Firestore and there is no reason to copy it into logs.
    extra: { kinfolkId },
  });
}

export const onKinfolkAddressWrite = onDocumentWritten(
  {
    document: 'kinfolk/{kinfolkId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN', MAPBOX_ACCESS_TOKEN],
  },
  wrapTrigger('onKinfolkAddressWrite', onKinfolkAddressWriteHandler),
);
