import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/**
 * ISSUE #584: a kinfolk cannot read a `kin_care_sessions` document at all.
 *
 * #519 made `allowClientLocationSharing` real where route data is SERVED -
 * `getMyVisits` and `getMyKinTales` strip coordinates, and the breadcrumbs rule
 * refuses the live-tracking read - and left one hole open, named in
 * `functions/src/lib/locationSharing.ts`: the session document ITSELF carries
 * `gpsSummary`, and the old rule handed a kinfolk the whole document whenever
 * `resource.data.kinfolkId` matched their claim.
 *
 * That hole could not be patched in place. A rule gates a DOCUMENT, never a
 * field, so no condition on `allow read` can withhold `gpsSummary` and still
 * serve the visit. The only fix is to stop granting the document, which is
 * affordable precisely because `getMyVisits` already projects this collection
 * for the portal and both shipping clients already read visits through it.
 *
 * THESE CASES FAIL AGAINST THE OLD RULE. On it, every `assertFails` below is an
 * `assertSucceeds`: the whole document comes back, coordinates and gate codes
 * included, and no `allowClientLocationSharing` value changes that.
 *
 * The second half of the file is the regression half. Removing a branch from a
 * rule is easy to overdo, so the operator read, the test-admin sandbox read and
 * the kinfolk breadcrumbs read are all asserted to still work.
 */

const SESSION = 'kin_care_sessions/s1';
const CRUMB = 'kin_care_sessions/s1/breadcrumbs/b1';
const TEST_TRIBE = 'test-kinfolk-001';

const KINFOLK_CLAIM = { role: 'kinfolk', kinfolkId: 'k1' };

function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: TEST_TRIBE });
}

/**
 * One session owned by `k1`, carrying the fields that make this a leak and not
 * a tidiness question: coordinates, a gate code, and the household's own notes.
 * Plus one breadcrumb, one sandbox-scoped session, and a settings doc with
 * sharing explicitly ON - so nothing below can pass merely because the switch
 * was off.
 */
async function seed(): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(SESSION).set({
      kinfolkId: 'k1',
      status: 'ARRIVED',
      startTime: '2026-08-20T10:00:00.000Z',
      notes: 'Gate code 1234, key under the third planter',
      kinfolkNotes: 'Rufus is shy with strangers',
      invoiceId: 'inv-77',
      gpsSummary: {
        distanceMeters: 1900,
        durationSeconds: 1500,
        startLat: 30.1,
        startLng: -97.7,
        endLat: 30.2,
        endLng: -97.8,
        route: [{ lat: 30.1, lng: -97.7 }],
      },
    });
    await db.doc(CRUMB).set({ lat: 30.1, lng: -97.7, timestamp: Date.now() });
    await db.doc(`kin_care_sessions/${TEST_TRIBE}-s1`).set({ kinfolkId: TEST_TRIBE, status: 'SCHEDULED' });
    await db.doc('business_settings/business_settings').set({
      businessName: 'Tribe Tails',
      allowClientLocationSharing: true,
    });
  });
}

describe('rules: kin_care_sessions documents are not readable by a kinfolk', () => {
  beforeEach(async () => seed());
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // ── The hole this closes ──────────────────────────────────────────────────

  it('a kinfolk cannot read their OWN session document', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(SESSION).get());
  });

  it('a kinfolk cannot list their own sessions, even filtered to their own id', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'u-kin', KINFOLK_CLAIM).firestore();
    await assertFails(fs.collection('kin_care_sessions').where('kinfolkId', '==', 'k1').get());
  });

  it('the unfiltered collection listing is refused too', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().collection('kin_care_sessions').get());
  });

  /**
   * The switch never had anything to do with this document. It gates the two
   * callables and the breadcrumbs read; on the session document it was
   * unconsulted in both positions, which is the whole reason #584 exists.
   */
  it('sharing being ON does not re-open the document read', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(SESSION).get());
  });

  it('a kinfolk still cannot read another household session either', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-other', { role: 'kinfolk', kinfolkId: 'k2' }).firestore().doc(SESSION).get(),
    );
  });

  it('an unauthenticated caller cannot read it', async () => {
    const env = await getEnv();
    await assertFails(env.unauthenticatedContext().firestore().doc(SESSION).get());
  });

  // ── What deliberately still works ─────────────────────────────────────────

  it('the operator still reads a session document', async () => {
    const env = await getEnv();
    await assertSucceeds(asAuntie(env).firestore().doc(SESSION).get());
  });

  /**
   * The admin apps issue UNFILTERED, collection-wide queries on this collection
   * (auntieos-admin/src/api/sessions.ts). Rules are not filters, so a condition
   * that depends on `resource.data` fails the whole query - `isAuntie()` has to
   * keep short-circuiting ahead of one.
   */
  it('the operator still runs the unfiltered collection query the admin lists rely on', async () => {
    const env = await getEnv();
    await assertSucceeds(asAuntie(env).firestore().collection('kin_care_sessions').get());
  });

  it('the test-admin sandbox still reads its own scoped session', async () => {
    const env = await getEnv();
    await assertSucceeds(asTestAdmin(env).firestore().doc(`kin_care_sessions/${TEST_TRIBE}-s1`).get());
  });

  it('the test-admin sandbox still cannot reach a live session', async () => {
    const env = await getEnv();
    await assertFails(asTestAdmin(env).firestore().doc(SESSION).get());
  });

  /**
   * THE ONE THAT COULD HAVE BEEN BROKEN SILENTLY. The breadcrumbs rule resolves
   * the parent session's `kinfolkId` with `get()`, and a rules `get()` is not
   * itself subject to rules - so denying the parent document does not deny the
   * subcollection. Live tracking is asserted here rather than reasoned about.
   */
  it('a kinfolk STILL reads their own breadcrumbs, live tracking intact', async () => {
    const env = await getEnv();
    await assertSucceeds(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(CRUMB).get());
  });

  it('and still streams the whole breadcrumbs collection for the live polyline', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().collection('kin_care_sessions/s1/breadcrumbs').get(),
    );
  });
});
