import {
  onDocumentWrittenWithAuthContext,
  type Change,
  type DocumentSnapshot,
  type FirestoreAuthEvent,
} from 'firebase-functions/v2/firestore';
import { wrapTrigger } from '../lib/wrapTrigger';

/**
 * #2037: a FOURTH trigger on `kin_care_sessions`. Each clock step (On my way,
 * Arrived, Departed, Undo arrival) gets its Activity Log line and, for the
 * three forward steps, its household notice from HERE, driven by the write
 * that committed the step, whichever client wrote it and whenever it landed.
 *
 * The clients used to send both after their own write. A reload a second after
 * "Yes, clock in" saved the step and lost the notice and the line (#2037). An
 * Android step held in the offline queue, the desktop console and the Android
 * Auntie Time card had the same gap or never wrote the line at all.
 *
 * WHO MADE THE WRITE. A client write carries the signed-in uid as `authId`. A
 * server write (`setVisitLifecycle`, which announces the step itself before
 * this runs, and finds it already done) carries a service account, and then
 * `updatedBy` on the row is the caller it stamped. Anything else is logged as
 * the system's. The actor names the line and the Auntie in the notice; it
 * never decides whether one is sent.
 *
 * Its rules live in `lib/visitStepNotice.ts`, loaded on the first event, so
 * this entry is the only module the cold-start graph gains.
 */

type SessionData = Record<string, unknown>;

export type SessionLifecycleEvent = FirestoreAuthEvent<Change<DocumentSnapshot> | undefined, { sessionId: string }>;

/** The uid behind the write, or null. Exported for the tests. */
export function writerUidOf(event: Pick<SessionLifecycleEvent, 'authType' | 'authId'>, after: SessionData): string | null {
  const authId = typeof event.authId === 'string' ? event.authId.trim() : '';
  if (authId !== '' && event.authType !== 'service_account' && event.authType !== 'system') return authId;
  // Only a server write reads `updatedBy`: it is the caller `setVisitLifecycle`
  // stamped in that same write. The field stays on the row afterwards, so a
  // later client write must never be filed under it.
  if (event.authType !== 'service_account') return null;
  const stamped = typeof after['updatedBy'] === 'string' ? after['updatedBy'].trim() : '';
  return stamped !== '' ? stamped : null;
}

export async function onKinCareSessionLifecycleHandler(event: SessionLifecycleEvent): Promise<void> {
  const before = event.data?.before.data() as SessionData | undefined;
  const after = event.data?.after.data() as SessionData | undefined;
  const { visitStepOf, announceVisitStep } = await import('../lib/visitStepNotice.js');
  const step = visitStepOf(before, after);
  if (step === null || after === undefined) return;
  await announceVisitStep({
    sessionId: event.params.sessionId,
    session: after,
    step,
    actorUid: writerUidOf(event, after),
    source: 'trigger',
    fallbackKey: typeof event.id === 'string' && event.id !== '' ? event.id : 'unstamped',
  });
}

export const onKinCareSessionLifecycle = onDocumentWrittenWithAuthContext(
  {
    document: 'kin_care_sessions/{sessionId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinCareSessionLifecycle', onKinCareSessionLifecycleHandler),
);
