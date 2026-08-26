import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/**
 * ISSUE #602: a kinfolk cannot read a `kin_care_reports` document at all.
 *
 * The identical hole #584 closed one collection over, and named there rather
 * than given a silent ride on that diff. `getMyKinTales` strips `gpsRoute`
 * before a KinTale reaches a household, exactly as `getMyVisits` strips
 * coordinates off a visit -- but the rule granted a kinfolk the whole REPORT
 * document whenever `resource.data.kinfolkId` matched their claim, and a
 * Firestore rule gates a DOCUMENT, never a field. So the callable's stripping
 * was bypassable by opening the document directly with the SDK.
 *
 * THESE CASES FAIL AGAINST THE OLD RULE. On it, every `assertFails` in the
 * first half is an `assertSucceeds`: the whole report comes back, `gpsRoute`
 * included, and no `allowClientLocationSharing` value changes that.
 *
 * WHAT REPLACES IT IS NOT NEW, which is what makes the grant removable rather
 * than load-bearing. `functions/src/portal/getMyKinTales.ts` already projects
 * this collection for the portal, and both shipping clients already read
 * KinTales through it and nothing else (`mytribe/web/src/api/portal.ts`,
 * `mytribe/src/commonMain/.../portal/PortalApi.kt`). The grant was REACHABLE,
 * not used.
 *
 * The second half is the regression half. Removing a branch from a rule is easy
 * to overdo, so the operator read, the test-admin sandbox read, and -- the one
 * most likely to break -- the kinfolk COMMENTS read are all asserted to still
 * work. That last one resolves the parent report's `kinfolkId` through a rules
 * `get()`, and a rules `get()` is not itself subject to rules, so it never
 * consulted the `allow read` being removed here.
 */

const REPORT = 'kin_care_reports/r1';
const COMMENT = 'kin_care_reports/r1/comments/c1';
const TEST_TRIBE = 'test-kinfolk-001';

const KINFOLK_CLAIM = { role: 'kinfolk', kinfolkId: 'k1' };

function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: TEST_TRIBE });
}

/**
 * One report owned by `k1`, carrying the field that makes this a leak rather
 * than a tidiness question: `gpsRoute`, the coordinate trail `getMyKinTales`
 * removes on the way out. Plus one comment on it, one sandbox-scoped report,
 * and a settings doc with sharing explicitly ON -- so nothing below can pass
 * merely because the switch happened to be off.
 */
async function seed(): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(REPORT).set({
      kinfolkId: 'k1',
      title: 'Afternoon walk',
      sentAt: '2026-08-20T16:00:00.000Z',
      gpsRoute: [
        { lat: 30.1, lng: -97.7, t: 1_787_580_000_000 },
        { lat: 30.2, lng: -97.8, t: 1_787_580_600_000 },
      ],
      gpsSummary: { distanceMeters: 1900, durationSeconds: 1500 },
    });
    await db.doc(COMMENT).set({ authorUid: 'u-kin', body: 'Thank you!', createdAt: Date.now() });
    await db.doc(`kin_care_reports/${TEST_TRIBE}-r1`).set({ kinfolkId: TEST_TRIBE, title: 'Sandbox tale' });
    await db.doc('business_settings/business_settings').set({
      businessName: 'Tribe Tails',
      allowClientLocationSharing: true,
    });
  });
}

describe('rules: kin_care_reports documents are not readable by a kinfolk', () => {
  beforeEach(async () => seed());
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // ── The hole this closes ──────────────────────────────────────────────────

  it('a kinfolk cannot read their OWN report document', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(REPORT).get());
  });

  it('a kinfolk cannot list their own reports, even filtered to their own id', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'u-kin', KINFOLK_CLAIM).firestore();
    await assertFails(fs.collection('kin_care_reports').where('kinfolkId', '==', 'k1').get());
  });

  it('the unfiltered collection listing is refused too', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().collection('kin_care_reports').get());
  });

  /**
   * The switch never had anything to do with this document. It gates the
   * callables that serve route data; on the report document it was unconsulted
   * in both positions, which is the whole reason this issue exists.
   */
  it('sharing being ON does not re-open the document read', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('business_settings/business_settings').set(
        { allowClientLocationSharing: true },
        { merge: true },
      );
    });
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(REPORT).get());
  });

  it("another household's report is refused, as it always was", async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-other', { role: 'kinfolk', kinfolkId: 'k2' }).firestore().doc(REPORT).get(),
    );
  });

  // ── The regression half ───────────────────────────────────────────────────

  it('the operator still reads the report document', async () => {
    const env = await getEnv();
    await assertSucceeds(asAuntie(env).firestore().doc(REPORT).get());
  });

  it('a test admin still reads a report inside their own sandbox', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asTestAdmin(env).firestore().doc(`kin_care_reports/${TEST_TRIBE}-r1`).get(),
    );
  });

  it('a test admin still cannot reach a report outside their sandbox', async () => {
    const env = await getEnv();
    await assertFails(asTestAdmin(env).firestore().doc(REPORT).get());
  });

  /**
   * THE ONE MOST LIKELY TO BREAK, and the reason it does not: the comments rule
   * resolves the parent report's `kinfolkId` with a rules `get()`, which is not
   * itself subject to rules. Removing the parent's `allow read` cannot reach it.
   * A household keeps reading the thread on their own KinTale.
   */
  it('a kinfolk still reads comments on their own report', async () => {
    const env = await getEnv();
    await assertSucceeds(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(COMMENT).get());
  });

  it("a kinfolk still cannot read comments on another household's report", async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-other', { role: 'kinfolk', kinfolkId: 'k2' }).firestore().doc(COMMENT).get(),
    );
  });

  it('comments stay closed to every client write, as before', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(COMMENT).set({ body: 'edited' }),
    );
  });

  /**
   * The write side of the parent is untouched by this change. Asserted so a
   * later reader can see the removal was scoped to `allow read`.
   */
  it('a kinfolk still cannot write a report document', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'u-kin', KINFOLK_CLAIM).firestore();
    await assertFails(fs.doc(REPORT).set({ title: 'mine now' }, { merge: true }));
    await assertFails(fs.doc(REPORT).delete());
  });

  it('the operator still creates, updates and deletes reports', async () => {
    const env = await getEnv();
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc('kin_care_reports/r-new').set({ kinfolkId: 'k1', title: 'New' }));
    await assertSucceeds(fs.doc(REPORT).set({ title: 'Edited' }, { merge: true }));
    await assertSucceeds(fs.doc(REPORT).delete());
  });
});
