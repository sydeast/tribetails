import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, deleteApp, getFirestore, getAuth, type Firestore, type Auth } from '../lib/firebaseAdmin';
import { applyPlan, assertPlanSafe, buildPlan, planFingerprint, planLines, readSendGate, ACTOR_ID } from '../purgeFakeRecords';

/**
 * The #1082 purge against the Firestore AND Auth emulators. Never production.
 *
 * Seeds the shapes the 2026-09-30 trace found (the sandbox household, a
 * disabled July invite-test account that is a member of it, a demo household)
 * next to the real test accounts and a real household, then proves:
 *   - the read-only scan finds the fake set and writes nothing (every document
 *     in the database and every Auth user, compared before and after)
 *   - apply deletes exactly that set, tied documents and Auth users included,
 *     and leaves every other document byte-identical
 *   - one activity_log row per deletion
 *   - a fake household with a real-domain member is refused, and nothing goes
 *   - the send gate line prints, for absent, true and a string 'true'
 *
 * Its own project id, so its Auth users never meet qaSandboxScripts' (that file
 * wipes every Auth user in its project).
 *
 * Run (from mytribe/functions): npm run test:scripts:emulator
 */
const FIRESTORE_EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const AUTH_EMULATOR = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
const BOTH = Boolean(FIRESTORE_EMULATOR && AUTH_EMULATOR);
if (Boolean(FIRESTORE_EMULATOR) !== Boolean(AUTH_EMULATOR)) {
  throw new Error(
    'purgeFakeRecords.emulator.test.ts needs BOTH FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST. ' +
      'Run it through `firebase emulators:exec --only auth,firestore`.',
  );
}

const PROJECT = 'purge-fake-1082-test';
const T = 30_000;

const SANDBOX_UID = 'V8Z4YsabpNfrHTTOLJw0YY3Wx5G3';
const CLAIM_UID = 'claim-0715-uid';
const ORPHAN_UID = 'orphan-example-uid';
const ADMIN_UID = 'real-e2e-admin';
const CATCH_UID = 'real-catch';
const PAWSOME_UID = 'real-pawsome';
const OPS_UID = 'real-ops';

const FAKE_DOCS = [
  'kinfolk/test-kinfolk-001',
  'families/test-kinfolk-001',
  `families/test-kinfolk-001/members/${CLAIM_UID}`,
  'families/test-kinfolk-001/kin/k1',
  'families/test-kinfolk-001/bookings/b1',
  'families/test-kinfolk-001/bookings/b1/kinCares/v1',
  'kin/k1',
  'invoices/test-inv-1',
  'invoices/test-inv-1/payments/p1',
  'kin_care_sessions/s1',
  'notifications/n-sandbox',
  'notifications/n-claim',
  'conversations/test-kinfolk-001',
  'conversations/test-kinfolk-001/messages/m1',
  `clients/${SANDBOX_UID}`,
  `clients/${CLAIM_UID}`,
  `clients/${CLAIM_UID}/security/loginAttempts`,
  'inviteRequests/ir-claim',
  'kinfolk/demo-family-001',
  'families/demo-family-001',
  'families/demo-family-001/bookings/demo-family-001-booking-1',
  'kin/demo-family-001-kin-1',
  'dossiers/dossier_demo-family-001',
  'the_411/411_demo-family-001-kin-1',
  `families/e2e-kf-1/members/${CLAIM_UID}`,
].sort();
const FAKE_UIDS = [SANDBOX_UID, CLAIM_UID, ORPHAN_UID].sort();

async function seed(db: Firestore, auth: Auth): Promise<void> {
  // Fake: the sandbox household and its Auth user.
  await auth.createUser({ uid: SANDBOX_UID, email: 'test-admin+sandbox@tribetails.test' });
  await db.doc(`clients/${SANDBOX_UID}`).set({ email: 'test-admin+sandbox@tribetails.test', kinfolkIds: ['test-kinfolk-001'] });
  await db.doc('kinfolk/test-kinfolk-001').set({ email: 'test-admin+sandbox@tribetails.test', isTestData: true });
  await db.doc('families/test-kinfolk-001').set({ kinfolkId: 'test-kinfolk-001', accountBalanceCents: 1500 });
  await db.doc(`families/test-kinfolk-001/members/${CLAIM_UID}`).set({ displayName: 'e2e-claim-0715@tribetails.test', status: 'ACCEPTED' });
  await db.doc('families/test-kinfolk-001/kin/k1').set({ name: 'Rex' });
  await db.doc('families/test-kinfolk-001/bookings/b1').set({ status: 'confirmed' });
  await db.doc('families/test-kinfolk-001/bookings/b1/kinCares/v1').set({ status: 'confirmed' });
  await db.doc('kin/k1').set({ kinfolkId: 'test-kinfolk-001', name: 'Rex' });
  await db.doc('invoices/test-inv-1').set({ kinfolkId: 'test-kinfolk-001', status: 'open', total: 40 });
  await db.doc('invoices/test-inv-1/payments/p1').set({ amount: 10 });
  await db.doc('kin_care_sessions/s1').set({ kinfolkId: 'test-kinfolk-001' });
  await db.doc('notifications/n-sandbox').set({ recipientUid: 'someone', data: { kinfolkId: 'test-kinfolk-001' } });
  await db.doc('conversations/test-kinfolk-001').set({ kinfolkId: 'test-kinfolk-001' });
  await db.doc('conversations/test-kinfolk-001/messages/m1').set({ text: 'hi' });
  // Fake: a disabled July invite-test account, a member of the sandbox AND of a real household.
  await auth.createUser({ uid: CLAIM_UID, email: 'e2e-claim-0715@tribetails.test', disabled: true });
  await db.doc(`clients/${CLAIM_UID}`).set({ email: 'e2e-claim-0715@tribetails.test', kinfolkIds: ['test-kinfolk-001'] });
  await db.doc(`clients/${CLAIM_UID}/security/loginAttempts`).set({ count: 2 });
  await db.doc('inviteRequests/ir-claim').set({ invitedEmail: 'e2e-claim-0715@tribetails.test', tribeId: 'test-kinfolk-001' });
  await db.doc('notifications/n-claim').set({ recipientUid: CLAIM_UID, data: {} });
  await db.doc(`families/e2e-kf-1/members/${CLAIM_UID}`).set({ displayName: 'e2e-claim-0715@tribetails.test' });
  // Fake: a demo household with no Auth user.
  await db.doc('kinfolk/demo-family-001').set({ email: 'demo+alpha@tribetails.test', _demo: true });
  await db.doc('families/demo-family-001').set({ kinfolkId: 'demo-family-001' });
  await db.doc('families/demo-family-001/bookings/demo-family-001-booking-1').set({ status: 'requested' });
  await db.doc('kin/demo-family-001-kin-1').set({ kinfolkId: 'demo-family-001' });
  await db.doc('dossiers/dossier_demo-family-001').set({ kinfolkId: 'demo-family-001' });
  await db.doc('the_411/411_demo-family-001-kin-1').set({ kinId: 'demo-family-001-kin-1' });
  // Fake: an Auth user on example.com with nothing else.
  await auth.createUser({ uid: ORPHAN_UID, email: 'Someone@Mail.Example.COM' });

  // Real: the three real test accounts and another @tribetails.com address.
  await auth.createUser({ uid: ADMIN_UID, email: 'e2e-admin@tribetails.com' });
  await auth.createUser({ uid: CATCH_UID, email: 'catch@hanasamku.com' });
  await auth.createUser({ uid: PAWSOME_UID, email: 'pawsome@hanasamku.com' });
  await auth.createUser({ uid: OPS_UID, email: 'ops@tribetails.com' });
  await db.doc(`staff/${ADMIN_UID}`).set({ email: 'e2e-admin@tribetails.com' });
  await db.doc(`clients/${CATCH_UID}`).set({ email: 'catch@hanasamku.com', kinfolkIds: ['e2e-kf-1', 'demo-family-001'] });
  await db.doc(`clients/${PAWSOME_UID}`).set({ email: 'pawsome@hanasamku.com', kinfolkIds: ['e2e-kf-2'] });
  await db.doc('kinfolk/e2e-kf-1').set({ email: 'catch@hanasamku.com' });
  await db.doc('families/e2e-kf-1').set({ kinfolkId: 'e2e-kf-1' });
  await db.doc(`families/e2e-kf-1/members/${CATCH_UID}`).set({ displayName: 'catch@hanasamku.com' });
  await db.doc('kinfolk/e2e-kf-2').set({ email: 'pawsome@hanasamku.com' });
  await db.doc('invoices/real-inv').set({ kinfolkId: 'e2e-kf-1', total: 80 });
  await db.doc('kin/real-kin').set({ kinfolkId: 'e2e-kf-1' });
  await db.doc('notifications/n-real').set({ recipientUid: CATCH_UID, data: { kinfolkId: 'e2e-kf-1' } });
  await db.doc('formSchemas/kinProfile').set({ _demo: true });
  await db.doc('activity_log/pre-existing').set({ actionType: 'SOMETHING_ELSE' });
  await db.doc('business_settings/business_settings').set({ timeZone: 'America/Chicago' });
}

type Dump = Record<string, string>;

async function dumpAll(db: Firestore): Promise<Dump> {
  const out: Dump = {};
  const walk = async (cols: Awaited<ReturnType<Firestore['listCollections']>>): Promise<void> => {
    for (const col of cols) {
      for (const ref of await col.listDocuments()) {
        const snap = await ref.get();
        if (snap.exists) out[ref.path] = JSON.stringify(snap.data());
        await walk(await ref.listCollections());
      }
    }
  };
  await walk(await db.listCollections());
  return out;
}

async function authUids(auth: Auth): Promise<string[]> {
  return (await auth.listUsers(1000)).users.map((u) => `${u.uid}:${u.email ?? ''}:${u.disabled}`).sort();
}

async function wipe(): Promise<void> {
  await fetch(`http://${FIRESTORE_EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_EMULATOR}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

describe.runIf(BOTH)('purgeFakeRecords against the Firestore and Auth emulators (#1082)', () => {
  let db: Firestore;
  let auth: Auth;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: PROJECT });
    db = getFirestore();
    auth = getAuth();
    await wipe();
    await seed(db, auth);
  }, T);

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('read only: finds exactly the fake set, lists the dangling real client, and writes nothing', async () => {
    const before = await dumpAll(db);
    const usersBefore = await authUids(auth);

    const plan = await buildPlan(db, auth);
    const lines = planLines(plan);

    expect(await dumpAll(db)).toEqual(before);
    expect(await authUids(auth)).toEqual(usersBefore);

    expect(plan.households).toEqual(['demo-family-001', 'test-kinfolk-001']);
    expect(plan.uids).toEqual(FAKE_UIDS);
    expect(plan.users.map((u) => u.uid).sort()).toEqual(FAKE_UIDS);
    expect(plan.docs.map((d) => d.path).sort()).toEqual(FAKE_DOCS);
    expect(plan.danglingClients).toEqual([{ path: `clients/${CATCH_UID}`, kinfolkIds: ['demo-family-001'] }]);
    expect(() => assertPlanSafe(plan)).not.toThrow();

    expect(lines[0]).toBe(
      'Household send gate (business_settings/business_settings.householdNotificationsLive): OFF (field not set): household notifications are NOT sent',
    );
    expect(lines.join('\n')).toContain('Every address in the plan is on a reserved domain.');
  }, T);

  it('apply: deletes exactly the listed set, Auth users included, with one audit row each', async () => {
    const before = await dumpAll(db);
    const plan = await buildPlan(db, auth);
    const log: string[] = [];
    // A stale fingerprint (the data changed after the read-only run) deletes nothing.
    await expect(applyPlan(db, auth, plan, { settleMs: 0, confirm: '000000000000', log: () => undefined })).rejects.toThrow(/fingerprint is [0-9a-f]{12}, not 000000000000/);
    expect(await dumpAll(db)).toEqual(before);
    const r = await applyPlan(db, auth, plan, { settleMs: 0, confirm: planFingerprint(plan), log: (s) => log.push(s), runId: 'test-run' });

    expect(r).toEqual({ docsDeleted: FAKE_DOCS.length, docsRedeleted: 0, usersDeleted: FAKE_UIDS.length });
    expect(log.filter((l) => l.startsWith('DELETED '))).toHaveLength(FAKE_DOCS.length + FAKE_UIDS.length);

    const after = await dumpAll(db);
    const audit = Object.keys(after).filter((p) => p.startsWith('activity_log/') && p !== 'activity_log/pre-existing');
    expect(audit).toHaveLength(FAKE_DOCS.length + FAKE_UIDS.length);
    for (const p of audit) expect(JSON.parse(after[p]).actorId).toBe(ACTOR_ID);

    // Everything else is byte-identical: before minus the fake set, plus only the audit rows.
    const expected = { ...before };
    for (const p of FAKE_DOCS) delete expected[p];
    const afterWithoutAudit = { ...after };
    for (const p of audit) delete afterWithoutAudit[p];
    expect(afterWithoutAudit).toEqual(expected);

    expect(await authUids(auth)).toEqual(
      [`${ADMIN_UID}:e2e-admin@tribetails.com:false`, `${CATCH_UID}:catch@hanasamku.com:false`, `${OPS_UID}:ops@tribetails.com:false`, `${PAWSOME_UID}:pawsome@hanasamku.com:false`].sort(),
    );

    const again = await buildPlan(db, auth);
    expect(again.docs).toEqual([]);
    expect(again.users).toEqual([]);
  }, T);

  it('refuses a fake household with a real-domain member, and deletes nothing', async () => {
    await db.doc('kinfolk/fake-mixed').set({ email: 'mixed@tribetails.test' });
    await db.doc('families/fake-mixed').set({ kinfolkId: 'fake-mixed' });
    await db.doc('families/fake-mixed/members/real-person').set({ displayName: 'jane@gmail.com' });
    await db.doc('families/fake-mixed/members/real-admin').set({ email: 'catch@hanasamku.com' });
    const before = await dumpAll(db);
    const usersBefore = await authUids(auth);

    const plan = await buildPlan(db, auth);
    expect(plan.households).toEqual(['fake-mixed']);
    expect(planLines(plan).join('\n')).toContain('WOULD REFUSE: 2 target(s)');
    expect(() => assertPlanSafe(plan)).toThrow(/families\/fake-mixed\/members\/real-person displayName: real-looking domain gmail\.com/);
    await expect(applyPlan(db, auth, plan, { settleMs: 0, confirm: planFingerprint(plan), log: () => undefined })).rejects.toThrow(/PROTECTED real account at hanasamku\.com/);

    expect(await dumpAll(db)).toEqual(before);
    expect(await authUids(auth)).toEqual(usersBefore);
  }, T);

  it('refuses a fake client whose first household is real and linked to someone else', async () => {
    // Clear the previous case so this one is refused for its own reason only.
    for (const p of ['families/fake-mixed/members/real-person', 'families/fake-mixed/members/real-admin', 'families/fake-mixed', 'kinfolk/fake-mixed']) await db.doc(p).delete();
    await db.doc('kinfolk/e2e-kf-1').set({ uid: CATCH_UID }, { merge: true });
    await auth.createUser({ uid: 'fake-linked', email: 'linked@tribetails.test' });
    await db.doc('clients/fake-linked').set({ email: 'linked@tribetails.test', kinfolkIds: ['e2e-kf-1'] });
    const before = await dumpAll(db);
    const usersBefore = await authUids(auth);
    const plan = await buildPlan(db, auth);
    expect(plan.triggerConflicts).toEqual([
      `deleting clients/fake-linked makes onClientsWrite clear kinfolk/e2e-kf-1.uid, which holds another account (${CATCH_UID}), not fake-linked`,
    ]);
    await expect(applyPlan(db, auth, plan, { settleMs: 0, confirm: planFingerprint(plan), log: () => undefined })).rejects.toThrow(/TRIGGER: deleting clients\/fake-linked/);
    expect(await dumpAll(db)).toEqual(before);
    expect(await authUids(auth)).toEqual(usersBefore);
  }, T);
  it('prints the send gate for true and for a string that only looks like true', async () => {
    await db.doc('business_settings/business_settings').set({ householdNotificationsLive: true }, { merge: true });
    expect((await readSendGate(db)).line).toBe(
      'Household send gate (business_settings/business_settings.householdNotificationsLive): ON: household notifications ARE being sent',
    );
    await db.doc('business_settings/business_settings').set({ householdNotificationsLive: 'true' }, { merge: true });
    expect((await readSendGate(db)).line).toContain('OFF (value "true" is not the boolean true)');
  }, T);
});
