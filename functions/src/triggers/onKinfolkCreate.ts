import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  isAlreadyExistsError,
  planFamilyProvision,
  PROVISIONED_BY_ON_KINFOLK_CREATE,
} from './familyProvision';

/**
 * Provisions the MyTribe `families/{kinfolkId}` envelope the moment an AuntieOS
 * `kinfolk/{kinfolkId}` doc is created, so every kinfolk profile has a portal
 * family id from creation. The AuntieOS kinfolk doc id IS the MyTribe family id
 * (identity mapping — see inviteKinfolkToPortal.ts / backfill_kin_adoption.ts).
 * Before this trigger, the envelope only appeared via inviteKinfolkToPortal or
 * provisionTribe, so pets/bookings for uninvited kinfolk could not land in the
 * portal tree (dry-run: 20 pets skipped family_not_provisioned).
 *
 * Idempotent: the write uses DocumentReference.create(), which is atomic and
 * fails with ALREADY_EXISTS if the envelope is present — a duplicate trigger
 * fire (or a race with inviteKinfolkToPortal / the backfill) never clobbers an
 * existing family doc. Test-data kinfolk (isTestData) are skipped; the sandbox
 * seeds its own envelope.
 *
 * The envelope shape replicates inviteKinfolkToPortal exactly (see
 * familyProvision.ts) plus `provisionedBy: 'onKinfolkCreate'` provenance.
 */
export async function onKinfolkCreateHandler(event: {
  params: { kinfolkId: string };
  data?: { data(): Record<string, unknown> | undefined };
}): Promise<void> {
  const kinfolkId = event.params.kinfolkId;
  const data = event.data?.data();
  if (!data) return;

  const plan = planFamilyProvision(kinfolkId, data, PROVISIONED_BY_ON_KINFOLK_CREATE);
  if (plan.action === 'skip') {
    logEvent({
      severity: 'info',
      function: 'onKinfolkCreate',
      event: 'family.provision.skipped',
      extra: { kinfolkId, reason: plan.reason },
    });
    return;
  }

  try {
    await db()
      .doc(`families/${plan.familyId}`)
      .create({
        ...plan.doc,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    logEvent({
      severity: 'info',
      function: 'onKinfolkCreate',
      event: 'family.provisioned',
      extra: { kinfolkId, familyId: plan.familyId, displayName: plan.doc.displayName },
    });
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      // Second fire / concurrent provisioner won the race — never clobber.
      logEvent({
        severity: 'info',
        function: 'onKinfolkCreate',
        event: 'family.provision.skipped',
        extra: { kinfolkId, reason: 'already_exists' },
      });
      return;
    }
    throw err;
  }
}

export const onKinfolkCreate = onDocumentCreated(
  {
    document: 'kinfolk/{kinfolkId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinfolkCreate', onKinfolkCreateHandler),
);
