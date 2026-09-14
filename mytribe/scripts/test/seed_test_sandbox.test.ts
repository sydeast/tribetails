import { describe, it, expect } from 'vitest';
import { Timestamp } from '../lib/firebaseAdmin';
import {
  TEST_TRIBE_ID,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_UID,
  parseArgs,
  buildSandboxPayload,
  planAllWrites,
  assertAllScoped,
  type PlannedWrite,
} from '../seed_test_sandbox';

// Fixed anchor so relative times (tomorrow / +3d / -7d / -14d / -21d) are
// deterministic under test.
const FIXED_NOW = new Date('2026-07-09T12:00:00Z');

describe('seed_test_sandbox: CLI args', () => {
  it('parseArgs defaults to dry-run', () => {
    const a = parseArgs([]);
    expect(a.apply).toBe(false);
    expect(a.password).toBeNull();
  });

  it('parseArgs --apply / --password / --project', () => {
    const a = parseArgs(['--apply', '--password=hunter2', '--project', 'p1']);
    expect(a.apply).toBe(true);
    expect(a.password).toBe('hunter2');
    expect(a.projectId).toBe('p1');
  });

  it('parseArgs rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('parseArgs rejects empty --password', () => {
    expect(() => parseArgs(['--password='])).toThrow(/--password requires/);
  });
});

describe('seed_test_sandbox: buildSandboxPayload', () => {
  const p = buildSandboxPayload(FIXED_NOW);

  it('family doc carries portal home/invoices fields', () => {
    expect(p.family._id).toBe(TEST_TRIBE_ID);
    expect(p.family.displayName).toBe('TEST SANDBOX');
    expect(p.family.accountBalanceCents).toBe(1500);
    expect(p.family.isTestData).toBe(true);
  });

  it('kinfolk identity doc is keyed by TEST_TRIBE_ID', () => {
    expect(p.kinfolk._id).toBe(TEST_TRIBE_ID);
    expect(p.kinfolk.email).toBe(TEST_ADMIN_EMAIL);
    expect(p.kinfolk.isTestData).toBe(true);
  });

  it('clients link doc grants access to exactly the test tribe', () => {
    expect(p.client._id).toBe(TEST_ADMIN_UID);
    expect(p.client.kinfolkIds).toEqual([TEST_TRIBE_ID]);
    expect(p.client.isTestData).toBe(true);
  });

  it('seeds 3 kin with getMyKin field shapes', () => {
    expect(p.kin).toHaveLength(3);
    for (const k of p.kin) {
      expect(k.kinfolkId).toBe(TEST_TRIBE_ID);
      expect(k.isTestData).toBe(true);
      expect(typeof k.ageYears).toBe('number'); // getMyKin numericOrNull
      expect(['active', 'noLongerWithUs']).toContain(k.status);
    }
  });

  it('one kin has the full care-field set', () => {
    const full = p.kin.find((k) => k._id.endsWith('-kin-1'));
    expect(full).toBeDefined();
    for (const field of [
      'feedingInstructions',
      'walkingInstructions',
      'medications',
      'allergies',
      'emergencyNotes',
      'sitterNotes',
    ] as const) {
      expect(full?.[field], field).toBeTruthy();
    }
  });

  it('one kin is noLongerWithUs (memorial state)', () => {
    const memorial = p.kin.filter((k) => k.status === 'noLongerWithUs');
    expect(memorial).toHaveLength(1);
    expect(memorial[0].species).toBe('Bird');
  });

  describe('bookings (families tree)', () => {
    it('2 envelopes with lowercase envelopeStatus and Timestamp bounds', () => {
      expect(p.envelopes).toHaveLength(2);
      for (const env of p.envelopes) {
        expect(env.familyId).toBe(TEST_TRIBE_ID);
        expect(env.envelopeStatus).toBe(env.envelopeStatus.toLowerCase());
        expect(env.firstStartTime).toBeInstanceOf(Timestamp);
        expect(env.lastStartTime).toBeInstanceOf(Timestamp);
        expect(env.serviceName.length).toBeGreaterThan(0);
        expect(env.isTestData).toBe(true);
      }
    });

    it('4 kinCares: 2 upcoming confirmed + 1 completed + 1 cancelled, all lowercase', () => {
      expect(p.kinCares).toHaveLength(4);
      const statuses = p.kinCares.map((kc) => kc.status).sort();
      expect(statuses).toEqual(['cancelled', 'completed', 'confirmed', 'confirmed']);
      for (const kc of p.kinCares) {
        expect(kc.status).toBe(kc.status.toLowerCase());
        // familyId is the collectionGroup('kinCares') query key.
        expect(kc.familyId).toBe(TEST_TRIBE_ID);
        expect(kc.isTestData).toBe(true);
        // service label fields the getMyBookings mapper reads.
        expect(kc.serviceType.length).toBeGreaterThan(0);
        expect(kc.serviceName.length).toBeGreaterThan(0);
      }
    });

    it('kinCare times are Firestore Timestamps (getMyBookings tsMillis)', () => {
      for (const kc of p.kinCares) {
        expect(kc.startTime).toBeInstanceOf(Timestamp);
        expect(kc.endTime).toBeInstanceOf(Timestamp);
        expect(kc.createdAt).toBeInstanceOf(Timestamp);
        expect(kc.updatedAt).toBeInstanceOf(Timestamp);
      }
    });

    it('confirmed kinCares are in the future, completed/cancelled in the past', () => {
      const nowMs = FIXED_NOW.getTime();
      for (const kc of p.kinCares) {
        const startMs = kc.startTime.toMillis();
        if (kc.status === 'confirmed') {
          expect(startMs).toBeGreaterThan(nowMs); // upcoming bucket
        } else {
          expect(startMs).toBeLessThan(nowMs); // recent bucket
        }
      }
    });

    it('each kinCare belongs to a seeded envelope', () => {
      const envelopeIds = new Set(p.envelopes.map((e) => e._id));
      for (const kc of p.kinCares) {
        expect(envelopeIds.has(kc.batchId), kc._id).toBe(true);
      }
    });
  });

  describe('flat kin_care_sessions (getMyVisits overlay)', () => {
    it('mirrors the kinCares by id plus one flat-only completed session', () => {
      expect(p.sessions).toHaveLength(5);
      const sessionIds = new Set(p.sessions.map((s) => s._id));
      for (const kc of p.kinCares) {
        expect(sessionIds.has(kc.sessionId), kc._id).toBe(true);
      }
    });

    it('uses ISO-string times and AuntieOS uppercase statuses', () => {
      const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
      for (const s of p.sessions) {
        expect(s.kinfolkId).toBe(TEST_TRIBE_ID);
        expect(s.startTime).toMatch(isoRe);
        expect(s.endTime).toMatch(isoRe);
        expect(['SCHEDULED', 'COMPLETED', 'CANCELLED']).toContain(s.status);
        expect(s.isTestData).toBe(true);
      }
    });

    it('includes a SCHEDULED future visit and a completed visit with GPS replay', () => {
      const scheduledFuture = p.sessions.filter(
        (s) => s.status === 'SCHEDULED' && new Date(s.startTime).getTime() > FIXED_NOW.getTime(),
      );
      expect(scheduledFuture.length).toBeGreaterThanOrEqual(1);
      const withGps = p.sessions.find((s) => s.gpsSummary);
      expect(withGps?.status).toBe('COMPLETED');
      expect(withGps?.gpsSummary?.route.length).toBeGreaterThan(1);
      expect(withGps?.arrivedAt).toBeTruthy();
      expect(withGps?.departedAt).toBeTruthy();
    });
  });

  describe('invoices (flat) + payment', () => {
    it('one per getMyInvoices bucket with the spec amounts', () => {
      const byStatus = Object.fromEntries(p.invoices.map((i) => [i.status, i]));
      expect(Object.keys(byStatus).sort()).toEqual(['credit', 'open', 'paid']);
      expect(byStatus.open.amountDue).toBe(4500);
      expect(byStatus.paid.total).toBe(6000);
      expect(byStatus.paid.amountDue).toBe(0);
      expect(byStatus.paid.paymentsHistory).toBeTruthy();
      expect(byStatus.credit.amountDue).toBe(-2000);
      expect(byStatus.credit.creditTarget).toBe('accountBalance');
    });

    it('sessionIds reference seeded flat kin_care_sessions', () => {
      const sessionIds = new Set(p.sessions.map((s) => s._id));
      for (const inv of p.invoices) {
        expect(inv.sessionIds.length).toBeGreaterThan(0);
        for (const sid of inv.sessionIds) {
          expect(sessionIds.has(sid), `${inv._id} -> ${sid}`).toBe(true);
        }
        expect(inv.kinfolkId).toBe(TEST_TRIBE_ID);
        expect(inv.isTestData).toBe(true);
      }
    });

    it('viewed is a "Yes"/"No" string, matching the 14 real invoices', () => {
      // The AuntieOS Kotlin models (android Models.kt, commonMain
      // FirestoreClient.kt) both declare `viewed: String`, and every non-test
      // invoice in prod stores "Yes" or "No". Seeding a Firestore boolean here
      // made toObjects(Invoice) throw for the WHOLE batch, so the android
      // invoice list came back empty in test mode. That was Sentry
      // AUNTIEOS-ADMIN-1J.
      for (const inv of p.invoices) {
        expect(typeof inv.viewed, `${inv._id}.viewed`).toBe('string');
        expect(['Yes', 'No']).toContain(inv.viewed);
      }
    });

    it('payment doc links to the paid invoice', () => {
      expect(p.payment.invoiceId).toBe(`${TEST_TRIBE_ID}-invoice-paid`);
      expect(p.payment.amount).toBe(6000);
      expect(p.payment.kinfolkId).toBe(TEST_TRIBE_ID);
      expect(p.payment.isTestData).toBe(true);
    });
  });

  describe('KinTales (flat kin_care_reports)', () => {
    it('3 reports with title + bodyCopy, sentAt strictly descending', () => {
      expect(p.reports).toHaveLength(3);
      for (const r of p.reports) {
        expect(r.title.length).toBeGreaterThan(0);
        expect(r.bodyCopy.length).toBeGreaterThan(0);
        expect(r.sentAt > '').toBe(true); // getMyKinTales filter: sentAt > ''
        expect(r.kinfolkId).toBe(TEST_TRIBE_ID);
        expect(r.isTestData).toBe(true);
      }
      const sentAts = p.reports.map((r) => r.sentAt);
      const sortedDesc = [...sentAts].sort().reverse();
      expect(sentAts).toEqual(sortedDesc);
      expect(new Set(sentAts).size).toBe(3); // distinct cursor values
    });

    it('newest report carries the media reference', () => {
      expect(p.reports[0].mediaFileIds).toContain(p.media._id);
      expect(p.media.kinfolkId).toBe(TEST_TRIBE_ID);
      expect(p.media.isTestData).toBe(true);
    });
  });

  it('formSchemas/kinProfile matches the getMyKin field keys', () => {
    expect(p.formSchema._id).toBe('kinProfile');
    expect(p.formSchema.name).toBe('Kin Profile');
    const keys = p.formSchema.sections.flatMap((s) => s.fields.map((f) => f.key));
    expect(keys).toEqual([
      'species',
      'breed',
      'ageYears',
      'feedingInstructions',
      'walkingInstructions',
      'medications',
      'allergies',
      'emergencyNotes',
      'sitterNotes',
    ]);
    expect(p.formSchema.isTestData).toBe(true);
  });

  it('is deterministic for a fixed now (re-build deep-equals)', () => {
    expect(buildSandboxPayload(FIXED_NOW)).toEqual(p);
  });
});

describe('seed_test_sandbox: planAllWrites', () => {
  const writes = planAllWrites(FIXED_NOW);
  const paths = writes.map((w) => w.path);

  it('produces 29 writes with no duplicate paths', () => {
    // 3 identity/access + 3 tree kin + 3 flat kin + 2 envelopes + 4 kinCares
    // + 5 sessions + 3 invoices + 1 payment + 3 reports + 1 media + 1 schema
    expect(writes).toHaveLength(29);
    expect(new Set(paths).size).toBe(29);
  });

  it('targets the families tree paths the portal reads', () => {
    expect(paths).toContain(`families/${TEST_TRIBE_ID}`);
    for (let n = 1; n <= 3; n += 1) {
      expect(paths).toContain(`families/${TEST_TRIBE_ID}/kin/${TEST_TRIBE_ID}-kin-${n}`);
    }
    expect(paths).toContain(`families/${TEST_TRIBE_ID}/bookings/${TEST_TRIBE_ID}-batch-upcoming`);
    expect(paths).toContain(`families/${TEST_TRIBE_ID}/bookings/${TEST_TRIBE_ID}-batch-past`);
    // kinCares live under their envelope so collectionGroup('kinCares') finds them.
    expect(paths).toContain(
      `families/${TEST_TRIBE_ID}/bookings/${TEST_TRIBE_ID}-batch-upcoming/kinCares/${TEST_TRIBE_ID}-visit-1`,
    );
    expect(paths).toContain(
      `families/${TEST_TRIBE_ID}/bookings/${TEST_TRIBE_ID}-batch-past/kinCares/${TEST_TRIBE_ID}-visit-4`,
    );
  });

  it('targets the flat overlay collections', () => {
    const collections = paths.map((p) => p.split('/')[0]);
    const counts = collections.reduce<Record<string, number>>((acc, c) => {
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['kin_care_sessions']).toBe(5);
    expect(counts['invoices']).toBe(3);
    expect(counts['payments']).toBe(1);
    expect(counts['kin_care_reports']).toBe(3);
    expect(counts['media_files']).toBe(1);
    expect(counts['kin']).toBe(3);
    expect(counts['kinfolk']).toBe(1);
  });

  it('includes the clients access-link write (getMyAccess reads this)', () => {
    const clientWrite = writes.find((w) => w.path === `clients/${TEST_ADMIN_UID}`);
    expect(clientWrite).toBeDefined();
    expect(clientWrite?.data.kinfolkIds).toEqual([TEST_TRIBE_ID]);
  });

  it('includes formSchemas/kinProfile', () => {
    expect(paths).toContain('formSchemas/kinProfile');
  });

  it('every kinCares write carries familyId + lowercase status + Timestamp times', () => {
    const kinCareWrites = writes.filter((w) => w.path.includes('/kinCares/'));
    expect(kinCareWrites).toHaveLength(4);
    for (const w of kinCareWrites) {
      expect(w.data.familyId).toBe(TEST_TRIBE_ID);
      expect(w.data.status).toBe((w.data.status as string).toLowerCase());
      expect(w.data.startTime).toBeInstanceOf(Timestamp);
      expect(w.data.endTime).toBeInstanceOf(Timestamp);
    }
  });

  it('every write carries isTestData: true', () => {
    for (const w of writes) {
      expect(w.data.isTestData, w.path).toBe(true);
    }
  });

  it('supports a uid override for the clients doc (pre-existing user path)', () => {
    const alt = planAllWrites(FIXED_NOW, 'someOtherUid');
    expect(alt.map((w) => w.path)).toContain('clients/someOtherUid');
    expect(() => assertAllScoped(alt, 'someOtherUid')).not.toThrow();
  });
});

describe('seed_test_sandbox: assertAllScoped', () => {
  it('passes for the real plan', () => {
    expect(() => assertAllScoped(planAllWrites(FIXED_NOW))).not.toThrow();
  });

  it('throws if a doc escapes the test tribe', () => {
    const bad: PlannedWrite[] = [
      { path: 'kin/leak', data: { kinfolkId: 'live-tribe-999', isTestData: true } },
    ];
    expect(() => assertAllScoped(bad)).toThrow(/!= test-kinfolk-001/);
  });

  it('throws if a kinCare-style doc has a foreign familyId', () => {
    const bad: PlannedWrite[] = [
      {
        path: 'families/live-1/bookings/b/kinCares/v',
        data: { familyId: 'live-1', isTestData: true },
      },
    ];
    expect(() => assertAllScoped(bad)).toThrow(/!= test-kinfolk-001/);
  });

  it('throws if a doc is missing isTestData', () => {
    const bad: PlannedWrite[] = [
      { path: 'kin/leak', data: { kinfolkId: TEST_TRIBE_ID } },
    ];
    expect(() => assertAllScoped(bad)).toThrow(/missing isTestData/);
  });

  it('throws if a fixed-path doc is missing isTestData', () => {
    const bad: PlannedWrite[] = [
      { path: `families/${TEST_TRIBE_ID}`, data: { displayName: 'x' } },
    ];
    expect(() => assertAllScoped(bad)).toThrow(/missing isTestData/);
  });
});
