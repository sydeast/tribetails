import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * A3: `kin_care_sessions` terminal-status writes are callable-only.
 *
 * The four operator transitions (Approve / Reject / Cancel / Mark Completed)
 * used to be a bare client `updateDoc` on this collection, gated by nothing but
 * `isAuntie()`. They are now owned by the `transitionBookingStatus` callable,
 * which runs a state machine and audits every path. THIS FILE IS WHAT MAKES
 * THAT TRUE rather than merely intended: without the rule, deleting the client
 * write only removes today's caller, and the next one re-opens the hole.
 *
 * The Firebase Admin SDK bypasses rules, so the callable itself is unaffected
 * by everything below. That is the whole design: the server can reach the
 * terminal states and no client can.
 */

const AUNTIE = { admin: true };
const SESSION = 'kin_care_sessions/s1';

async function seedSession(fields: Record<string, unknown>): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(SESSION).set({ kinfolkId: 'kf1', ...fields });
  });
}

describe('rules: kin_care_sessions terminal status is callable-only', () => {
  beforeEach(async () => seedSession({ status: 'SCHEDULED', notes: 'Gate code 1234' }));
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // ── The hole this closes ──────────────────────────────────────────────────

  it('an auntie can no longer cancel a session by direct write', async () => {
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ status: 'CANCELLED' }, { merge: true }),
    );
  });

  it('an auntie can no longer complete a session by direct write', async () => {
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ status: 'COMPLETED', completedAt: '2026-08-01T10:00:00Z' }, { merge: true }),
    );
  });

  it('the older CANCELED spelling is refused too, so the guard cannot be spelled around', async () => {
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ status: 'CANCELED' }, { merge: true }),
    );
  });

  it('the MyTribe-side REJECTED spelling is refused too', async () => {
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ status: 'REJECTED' }, { merge: true }),
    );
  });

  it('completedAt cannot be stamped on its own, without a status change', async () => {
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ completedAt: '2026-08-01T10:00:00Z' }, { merge: true }),
    );
  });

  it('a session cannot be CREATED already terminal (the delete-and-recreate walkaround)', async () => {
    const env = await getEnv();
    const fs = env.authenticatedContext('auntie1', AUNTIE).firestore();
    await assertFails(
      fs.doc('kin_care_sessions/fresh').set({ kinfolkId: 'kf1', status: 'COMPLETED' }),
    );
    await assertFails(
      fs.doc('kin_care_sessions/fresh2').set({ kinfolkId: 'kf1', status: 'CANCELLED' }),
    );
  });

  // ── What deliberately still works ─────────────────────────────────────────
  //
  // The in-visit lifecycle is driven by direct patch from a phone that is
  // regularly offline mid-visit. Banning `status` outright would have taken
  // that with it, which is why the rule names the terminal values instead.

  it('the in-visit lifecycle still writes directly: ON_MY_WAY', async () => {
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ status: 'ON_MY_WAY', onMyWayAt: '2026-08-01T09:00:00Z' }, { merge: true }),
    );
  });

  it('the in-visit lifecycle still writes directly: ARRIVED and DEPARTED', async () => {
    const env = await getEnv();
    const fs = env.authenticatedContext('auntie1', AUNTIE).firestore();
    await assertSucceeds(fs.doc(SESSION).set({ status: 'ARRIVED' }, { merge: true }));
    await assertSucceeds(fs.doc(SESSION).set({ status: 'DEPARTED' }, { merge: true }));
  });

  it('Undo Arrival back to SCHEDULED still writes directly', async () => {
    await seedSession({ status: 'ARRIVED' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ status: 'SCHEDULED', arrivedAt: '' }, { merge: true }),
    );
  });

  it('non-status fields still write directly (notes, gpsSummary, visitRouteId)', async () => {
    const env = await getEnv();
    const fs = env.authenticatedContext('auntie1', AUNTIE).firestore();
    await assertSucceeds(fs.doc(SESSION).set({ notes: 'field note' }, { merge: true }));
    await assertSucceeds(fs.doc(SESSION).set({ visitRouteId: 'vr1' }, { merge: true }));
    await assertSucceeds(fs.doc(SESSION).set({ gpsSummary: { distance: 1 } }, { merge: true }));
  });

  it('a session that is ALREADY terminal can still take a non-status patch', async () => {
    await seedSession({ status: 'COMPLETED', completedAt: '2026-08-01T10:00:00Z' });
    const env = await getEnv();
    // `status` is unchanged, so it is not in affectedKeys and the guard does
    // not fire. A completed visit still has to accept a KinTale link.
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(SESSION)
        .set({ reportIds: ['r1'], sentReportCount: 1 }, { merge: true }),
    );
  });

  it('a fresh session is still created SCHEDULED by the client that schedules it', async () => {
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore()
        .doc('kin_care_sessions/fresh3')
        .set({ kinfolkId: 'kf1', status: 'SCHEDULED', startTime: '2026-08-02T09:00:00Z' }),
    );
  });

  // ── Nothing here loosened anyone else ─────────────────────────────────────

  it('a kinfolk still cannot write this collection at all', async () => {
    const env = await getEnv();
    const fs = env
      .authenticatedContext('kf-user', { role: 'kinfolk', kinfolkId: 'kf1' })
      .firestore();
    await assertFails(fs.doc(SESSION).set({ status: 'CANCELLED' }, { merge: true }));
    await assertFails(fs.doc(SESSION).set({ status: 'ARRIVED' }, { merge: true }));
  });

  it('an unauthenticated caller still cannot write this collection', async () => {
    const env = await getEnv();
    await assertFails(
      env.unauthenticatedContext().firestore().doc(SESSION)
        .set({ status: 'ARRIVED' }, { merge: true }),
    );
  });
});
