import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * Stage 0I test-admin sandbox rules.
 *
 * A test admin carries the custom claim { testTribeId: '<kinfolk doc id>' } and
 * NO admin claim. Rules must HARD-restrict it to that one kinfolk + related
 * records (kinfolkId == testTribeId) and deny everything else, including live
 * data and global config writes.
 */

const TEST_TRIBE = 'test-kinfolk-001';
const LIVE_TRIBE = 'live-kinfolk-999';

// A test-admin context: authenticated with the testTribeId claim, no admin.
function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: TEST_TRIBE });
}

describe('rules: test-admin sandbox', () => {
  beforeEach(async () => {
    const env = await getEnv();
    // Seed one test-tribe doc set + one live doc set, rules disabled.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // kinfolk docs (keyed by id)
      await db.doc(`kinfolk/${TEST_TRIBE}`).set({ businessName: 'TEST SANDBOX', isTestData: true });
      await db.doc(`kinfolk/${LIVE_TRIBE}`).set({ businessName: 'Real Client' });
      // related docs for each tribe
      for (const tribe of [TEST_TRIBE, LIVE_TRIBE]) {
        await db.doc(`kin/${tribe}-k1`).set({ kinfolkId: tribe, name: 'Pet' });
        await db.doc(`invoices/${tribe}-i1`).set({ kinfolkId: tribe, total: 60 });
        await db.doc(`kin_care_sessions/${tribe}-s1`).set({ kinfolkId: tribe, status: 'SCHEDULED' });
        await db.doc(`kin_care_reports/${tribe}-r1`).set({ kinfolkId: tribe, status: 'SENT' });
        await db.doc(`payments/${tribe}-p1`).set({ kinfolkId: tribe, amount: 60 });
        await db.doc(`media_files/${tribe}-m1`).set({ kinfolkId: tribe, storageUrl: 'x' });
        // Stage-0I read-gap fix: dossier is keyed one-per-kinfolk (doc id == tribe);
        // generated_drafts carry the snake_case `kinfolk_id` field (see generate.js).
        await db.doc(`dossiers/${tribe}`).set({ kinfolkId: tribe, householdNotes: 'x' });
        await db.doc(`generated_drafts/${tribe}-d1`).set({ kinfolk_id: tribe, generated_copy: 'x', status: 'generated' });
      }
      // global config
      await db.doc('vet_clinics/vc1').set({ name: 'Clinic' });
      await db.doc('business_settings/business_settings').set({ businessName: 'Biz' });
      await db.doc('kintale_templates/kt1').set({ name: 'Template' });
      await db.doc('formSchemas/fs1').set({ name: 'Schema', version: 1, sections: [] });
    });
  });

  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // ── Own tribe: read OK ────────────────────────────────────────────────────
  it('reads its own kinfolk doc', async () => {
    const env = await getEnv();
    await assertSucceeds(asTestAdmin(env).firestore().doc(`kinfolk/${TEST_TRIBE}`).get());
  });

  it('reads its own kin / invoices / sessions / reports / payments / media', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertSucceeds(fs.doc(`kin/${TEST_TRIBE}-k1`).get());
    await assertSucceeds(fs.doc(`invoices/${TEST_TRIBE}-i1`).get());
    await assertSucceeds(fs.doc(`kin_care_sessions/${TEST_TRIBE}-s1`).get());
    await assertSucceeds(fs.doc(`kin_care_reports/${TEST_TRIBE}-r1`).get());
    await assertSucceeds(fs.doc(`payments/${TEST_TRIBE}-p1`).get());
    await assertSucceeds(fs.doc(`media_files/${TEST_TRIBE}-m1`).get());
  });

  // ── Stage-0I read-gap fix (2026-07-18): dossier + generated_drafts ─────────
  // These collections were added AFTER Stage 0I and granted read to isAuntie ONLY,
  // so the sandbox test-admin was denied and the app showed false permission
  // banners. The rule now ORs in a scoped test-admin READ branch (writes stay
  // admin-only).
  it('reads its own dossier (single-doc, doc id == testScope)', async () => {
    const env = await getEnv();
    await assertSucceeds(asTestAdmin(env).firestore().doc(`dossiers/${TEST_TRIBE}`).get());
  });

  it('reads its own generated_drafts (single doc + kinfolk_id-scoped query)', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertSucceeds(fs.doc(`generated_drafts/${TEST_TRIBE}-d1`).get());
    await assertSucceeds(fs.collection('generated_drafts').where('kinfolk_id', '==', TEST_TRIBE).get());
  });

  it('is DENIED reading another tribe dossier / draft', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc(`dossiers/${LIVE_TRIBE}`).get());
    await assertFails(fs.doc(`generated_drafts/${LIVE_TRIBE}-d1`).get());
  });

  it('is DENIED an unfiltered list of generated_drafts (cross-tenant)', async () => {
    const env = await getEnv();
    await assertFails(asTestAdmin(env).firestore().collection('generated_drafts').get());
  });

  it('is DENIED a generated_drafts query scoped to another tribe', async () => {
    const env = await getEnv();
    await assertFails(
      asTestAdmin(env).firestore().collection('generated_drafts').where('kinfolk_id', '==', LIVE_TRIBE).get(),
    );
  });

  it('is DENIED writing its own dossier / draft (writes stay admin-only)', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc(`dossiers/${TEST_TRIBE}`).set({ kinfolkId: TEST_TRIBE, householdNotes: 'y' }, { merge: true }));
    await assertFails(fs.doc(`generated_drafts/${TEST_TRIBE}-d1`).set({ status: 'approved' }, { merge: true }));
  });

  // ── Own tribe: write OK ───────────────────────────────────────────────────
  it('writes its own kinfolk doc', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asTestAdmin(env).firestore().doc(`kinfolk/${TEST_TRIBE}`).set({ businessName: 'TEST SANDBOX edited', isTestData: true }),
    );
  });

  it('creates a new kin scoped to its own tribe', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asTestAdmin(env).firestore().doc(`kin/${TEST_TRIBE}-k2`).set({ kinfolkId: TEST_TRIBE, name: 'New Pet', isTestData: true }),
    );
  });

  it('updates its own invoice / session / payment / media', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertSucceeds(fs.doc(`invoices/${TEST_TRIBE}-i1`).set({ kinfolkId: TEST_TRIBE, total: 99 }, { merge: true }));
    await assertSucceeds(fs.doc(`kin_care_sessions/${TEST_TRIBE}-s1`).set({ kinfolkId: TEST_TRIBE, status: 'COMPLETED' }, { merge: true }));
    await assertSucceeds(fs.doc(`payments/${TEST_TRIBE}-p1`).set({ kinfolkId: TEST_TRIBE, amount: 99 }, { merge: true }));
    await assertSucceeds(fs.doc(`media_files/${TEST_TRIBE}-m1`).set({ kinfolkId: TEST_TRIBE, isProfilePhoto: true }, { merge: true }));
    await assertSucceeds(fs.doc(`kin_care_reports/${TEST_TRIBE}-r1`).set({ kinfolkId: TEST_TRIBE, status: 'SENT' }, { merge: true }));
  });

  // ── Another tribe: read DENIED ────────────────────────────────────────────
  it('is DENIED reading another tribe kinfolk', async () => {
    const env = await getEnv();
    await assertFails(asTestAdmin(env).firestore().doc(`kinfolk/${LIVE_TRIBE}`).get());
  });

  it('is DENIED reading another tribe kin / invoices / sessions / reports / payments / media', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc(`kin/${LIVE_TRIBE}-k1`).get());
    await assertFails(fs.doc(`invoices/${LIVE_TRIBE}-i1`).get());
    await assertFails(fs.doc(`kin_care_sessions/${LIVE_TRIBE}-s1`).get());
    await assertFails(fs.doc(`kin_care_reports/${LIVE_TRIBE}-r1`).get());
    await assertFails(fs.doc(`payments/${LIVE_TRIBE}-p1`).get());
    await assertFails(fs.doc(`media_files/${LIVE_TRIBE}-m1`).get());
  });

  // ── Another tribe: write DENIED ───────────────────────────────────────────
  it('is DENIED writing another tribe doc', async () => {
    const env = await getEnv();
    await assertFails(
      asTestAdmin(env).firestore().doc(`kin/${LIVE_TRIBE}-k1`).set({ kinfolkId: LIVE_TRIBE, name: 'hijack' }, { merge: true }),
    );
  });

  it('is DENIED creating a doc tagged with another tribe id', async () => {
    const env = await getEnv();
    await assertFails(
      asTestAdmin(env).firestore().doc(`kin/sneaky`).set({ kinfolkId: LIVE_TRIBE, name: 'sneaky', isTestData: true }),
    );
  });

  // ── CRITICAL-2: UPDATE exploit — re-tag a live doc into sandbox scope ──────
  // The pre-fix rule "allow create, update: if isAuntie() || testOwnsIncoming()"
  // checked request.resource.data.kinfolkId on UPDATE. A test admin could target
  // a LIVE doc id and write {kinfolkId: TEST_TRIBE} — the merged kinfolkId equals
  // testScope() so testOwnsIncoming() returned true, re-tagging live data into
  // the sandbox. The fix splits the rule: update must use testOwnsExisting()
  // which gates on resource.data.kinfolkId (the EXISTING doc's value, LIVE_TRIBE),
  // which does NOT match testScope() (TEST_TRIBE) — so the write must be DENIED.
  it('is DENIED re-tagging a live doc by updating its kinfolkId to testScope', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    // Each live-tribe doc was seeded with kinfolkId == LIVE_TRIBE. The test admin
    // attempts to stamp its OWN testScope onto these live doc ids. All must fail.
    await assertFails(
      fs.doc(`kin/${LIVE_TRIBE}-k1`).set({ kinfolkId: TEST_TRIBE, name: 'hijacked' }, { merge: true }),
    );
    await assertFails(
      fs.doc(`invoices/${LIVE_TRIBE}-i1`).set({ kinfolkId: TEST_TRIBE, total: 0 }, { merge: true }),
    );
    await assertFails(
      fs.doc(`kin_care_sessions/${LIVE_TRIBE}-s1`).set({ kinfolkId: TEST_TRIBE, status: 'HIJACKED' }, { merge: true }),
    );
    await assertFails(
      fs.doc(`kin_care_reports/${LIVE_TRIBE}-r1`).set({ kinfolkId: TEST_TRIBE, status: 'HIJACKED' }, { merge: true }),
    );
    await assertFails(
      fs.doc(`payments/${LIVE_TRIBE}-p1`).set({ kinfolkId: TEST_TRIBE, amount: 0 }, { merge: true }),
    );
    await assertFails(
      fs.doc(`media_files/${LIVE_TRIBE}-m1`).set({ kinfolkId: TEST_TRIBE, storageUrl: 'hijacked' }, { merge: true }),
    );
  });

  it('is DENIED writing a kinfolk doc that is not its own', async () => {
    const env = await getEnv();
    await assertFails(
      asTestAdmin(env).firestore().doc(`kinfolk/${LIVE_TRIBE}`).set({ businessName: 'hijack' }, { merge: true }),
    );
  });

  // ── Global config: READ OK, WRITE DENIED ──────────────────────────────────
  it('reads global config (vet_clinics, business_settings, kintale_templates, formSchemas)', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertSucceeds(fs.doc('vet_clinics/vc1').get());
    await assertSucceeds(fs.doc('business_settings/business_settings').get());
    await assertSucceeds(fs.doc('kintale_templates/kt1').get());
    await assertSucceeds(fs.doc('formSchemas/fs1').get());
  });

  it('is DENIED writing global config', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc('vet_clinics/vc1').set({ name: 'hijack' }, { merge: true }));
    await assertFails(fs.doc('business_settings/business_settings').set({ businessName: 'hijack' }, { merge: true }));
    await assertFails(fs.doc('kintale_templates/kt1').set({ name: 'hijack' }, { merge: true }));
    await assertFails(fs.doc('formSchemas/fs1').set({ name: 'hijack' }, { merge: true }));
  });

  // ── Out-of-scope collections: DENIED entirely ─────────────────────────────
  it('is DENIED reaching admin-only operational collections', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc('activity_log/a1').get());
    await assertFails(fs.doc('users/u1').get());
    await assertFails(fs.doc('dossiers/d1').get());
    await assertFails(fs.doc('training_documents/t1').get());
    await assertFails(fs.doc('the_411/x1').get());
  });
});

/**
 * WARNING-18: explicit CREATE-vs-UPDATE split coverage across every scoped
 * collection (kin, invoices, payments, media_files, kin_care_reports,
 * kin_care_sessions). This pins the C-2 fix in place:
 *   (a) CREATE of a FRESH doc with kinfolkId == TEST_TRIBE must SUCCEED - the
 *       create gate (testOwnsIncoming) reads request.resource.data.kinfolkId.
 *   (b) UPDATE of a pre-seeded LIVE doc (kinfolkId == LIVE_TRIBE) with an
 *       incoming {kinfolkId: TEST_TRIBE} must FAIL - the update gate
 *       (testOwnsExisting) reads resource.data.kinfolkId (the EXISTING value,
 *       LIVE_TRIBE), so re-tagging into sandbox scope is denied.
 * If the rule ever regresses to gating UPDATE on request.resource.data, (b)
 * starts passing the write and these assertFails calls fail the suite.
 */
const SCOPED_COLLECTIONS = [
  'kin',
  'invoices',
  'payments',
  'media_files',
  'kin_care_reports',
  'kin_care_sessions',
] as const;

describe('rules: test-admin sandbox create-vs-update split (WARNING-18 / C-2)', () => {
  beforeEach(async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // One pre-seeded LIVE doc per scoped collection (kinfolkId == LIVE_TRIBE).
      for (const col of SCOPED_COLLECTIONS) {
        await db.doc(`${col}/${LIVE_TRIBE}-existing`).set({ kinfolkId: LIVE_TRIBE, seeded: true });
      }
    });
  });

  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // (a) CREATE a fresh doc stamped with the test admin's own tribe - SUCCEEDS.
  it('CREATE of a fresh doc with kinfolkId == TEST_TRIBE succeeds on every scoped collection', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    for (const col of SCOPED_COLLECTIONS) {
      await assertSucceeds(
        fs.doc(`${col}/${TEST_TRIBE}-fresh`).set({ kinfolkId: TEST_TRIBE, isTestData: true }),
      );
    }
  });

  // (b) UPDATE a pre-seeded LIVE doc, attempting to re-tag it into sandbox
  //     scope. The update gate reads the EXISTING kinfolkId (LIVE_TRIBE) - FAILS.
  it('UPDATE of a live doc re-tagging kinfolkId to TEST_TRIBE fails on every scoped collection', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    for (const col of SCOPED_COLLECTIONS) {
      await assertFails(
        fs.doc(`${col}/${LIVE_TRIBE}-existing`).set({ kinfolkId: TEST_TRIBE, hijacked: true }, { merge: true }),
      );
    }
  });

  // Control: a test admin CANNOT create a fresh doc stamped with a FOREIGN
  // tribe id either - the create gate rejects the incoming kinfolkId.
  it('CREATE of a fresh doc with a foreign kinfolkId fails on every scoped collection', async () => {
    const env = await getEnv();
    const fs = asTestAdmin(env).firestore();
    for (const col of SCOPED_COLLECTIONS) {
      await assertFails(
        fs.doc(`${col}/${TEST_TRIBE}-foreign`).set({ kinfolkId: LIVE_TRIBE, isTestData: true }),
      );
    }
  });
});
