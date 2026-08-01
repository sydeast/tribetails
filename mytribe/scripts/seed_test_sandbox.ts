/**
 * seed_test_sandbox.ts - Stage 0I test-admin sandbox seed (portal-shaped rewrite).
 *
 * Binding contract:
 *   AuntieOS/docs/2026-06-05-stage-0I-test-admin-sandbox.md
 *
 * WHY THIS WAS REWRITTEN - the flat-vs-tree split
 * -----------------------------------------------
 * The ORIGINAL seed assumed the MyTribe portal reads AuntieOS-flat collections
 * (flat `kin/`, flat `kin_care_sessions` doubling as "bookings" via a
 * kind:'BOOKING' marker, no `families/` tree at all). That assumption was
 * WRONG: the portal callables read the `families/{kinfolkId}` tree, so the
 * sandbox account signed in to an empty portal.
 *
 * The real read paths (verified in functions/src/portal):
 *   - getMyAccess / resolveKinfolkAccess -> clients/{uid}.kinfolkIds
 *     (the old seed never wrote this doc, so the account had NO tribes at all)
 *   - getMyHome     -> families/{kinfolkId}.displayName
 *   - getMyKin      -> families/{kinfolkId}/kin (status in active|noLongerWithUs,
 *                      ageYears number, care instruction fields)
 *   - getMyBookings -> collectionGroup('kinCares').where('familyId','==',id)
 *                      with parent envelopes at families/{id}/bookings/{batchId};
 *                      LOWERCASE status, startTime/endTime as Firestore Timestamp
 *   - getMyVisits   -> FLAT kin_care_sessions where kinfolkId==id
 *                      (ISO-string startTime, AuntieOS uppercase status)
 *   - getMyInvoices -> FLAT invoices where kinfolkId==id (invoiceStatus buckets)
 *                      + families/{id}.accountBalanceCents
 *   - getMyKinTales -> FLAT kin_care_reports where kinfolkId==id, sentAt > ''
 *   - getFormSchema -> formSchemas/{schemaId} (global)
 *
 * So BOTH shapes are written on purpose:
 *   families tree  -> kin list, bookings/envelopes, home identity, balance
 *   AuntieOS flat  -> visits overlay (kin_care_sessions), invoices, KinTales,
 *                     plus flat kinfolk/ + kin/ mirrors for AuntieOS-side tooling
 *
 * What it provisions:
 *   1. Firebase Auth user TEST_ADMIN_EMAIL with fixed uid TEST_ADMIN_UID and
 *      custom claim { testTribeId: TEST_TRIBE_ID }. NEVER admin:true.
 *   2. clients/{uid} with kinfolkIds: [TEST_TRIBE_ID] (REQUIRED for access).
 *   3. families/{TEST_TRIBE_ID} (displayName 'TEST SANDBOX', balance 1500c)
 *      + 3 kin (dog with full care fields, cat, bird noLongerWithUs to
 *      exercise the memorial state)
 *      + 2 booking envelopes: one with 2 upcoming confirmed kinCares
 *      (tomorrow / +3 days), one with 2 past kinCares (completed last week,
 *      cancelled two weeks ago). kinCare times are Firestore Timestamps.
 *   4. Flat kin_care_sessions mirroring the kinCares (same doc ids) plus one
 *      older completed session, so getMyVisits shows a SCHEDULED future visit
 *      and a completed visit with a GPS replay.
 *   5. Flat invoices: open (amountDue 4500), paid (total 6000, payments
 *      history), credit (invoiceStatus 'credit', -2000), with sessionIds
 *      linking back to the seeded sessions. One payment doc for the paid one.
 *   6. 3 flat kin_care_reports (KinTales) with title + bodyCopy, sentAt
 *      descending, the newest carrying a media reference; 1 media_files doc.
 *   7. formSchemas/kinProfile (copied from seedDemoKinfolk buildFormSchemas)
 *      so the Kin Profile edit form renders.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. Without --apply it prints the plan and writes nothing.
 *   - Requires GOOGLE_APPLICATION_CREDENTIALS (fail-loud, ADC). No fallback.
 *   - Idempotent RESET: fixed doc ids + set(..., { merge: false }) so every
 *     re-run overwrites the docs back to this exact baseline state.
 *   - Every doc carries isTestData: true and is scoped to TEST_TRIBE_ID
 *     (kinfolkId or familyId field, or an explicitly allowlisted fixed path).
 *     assertAllScoped() throws before any write escapes the sandbox.
 *
 * Operator run commands:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/auntieos-ttpc-sa.json
 *   cd MyTribe/functions
 *   # dry-run (prints the plan, no writes):
 *   npx ts-node --project ../scripts/tsconfig.json ../scripts/seed_test_sandbox.ts
 *   # apply (creates the Auth user + claim + writes the sandbox docs):
 *   npx ts-node --project ../scripts/tsconfig.json ../scripts/seed_test_sandbox.ts --apply
 *   # optionally set a password at create time:
 *   npx ts-node --project ../scripts/tsconfig.json ../scripts/seed_test_sandbox.ts --apply --password=<pw>
 */

import { getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ---------------------------------------------------------------------------
// Fixed identity. Deterministic so re-runs converge and the rules match
// (resource.data.kinfolkId == request.auth.token.testTribeId).
// ---------------------------------------------------------------------------
export const TEST_TRIBE_ID = 'test-kinfolk-001';
// Reserved RFC 6761 TLD (.test) - never deliverable, never confused with a real
// kinfolk email.
export const TEST_ADMIN_EMAIL = 'test-admin+sandbox@tribetails.test';
export const TEST_ADMIN_DISPLAY_NAME = 'TEST SANDBOX Admin';
// Fixed uid: clients/{uid} must exist BEFORE first sign-in, so the uid cannot
// be auto-generated. createUser({ uid }) pins it.
export const TEST_ADMIN_UID = 'V8Z4YsabpNfrHTTOLJw0YY3Wx5G3';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
interface Args {
  apply: boolean;
  password: string | null;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, password: null, projectId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') {
      args.apply = true;
    } else if (a.startsWith('--password=')) {
      const v = a.slice('--password='.length);
      if (!v) throw new Error('--password requires a value (--password=<pw>)');
      args.password = v;
    } else if (a === '--project') {
      const v = argv[i + 1];
      if (!v) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'seed_test_sandbox.ts - Stage 0I test-admin sandbox seed',
          '',
          'Usage:',
          '  ts-node seed_test_sandbox.ts                  # dry-run (default)',
          '  ts-node seed_test_sandbox.ts --apply          # create user + claim + write docs',
          '  ts-node seed_test_sandbox.ts --apply --password=<pw>  # also set a password',
          '  ts-node seed_test_sandbox.ts --project <id>   # override project',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service-account JSON path (required for --apply)',
          '  GCLOUD_PROJECT                  Firebase project id (default auntieos-ttpc)',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Doc shapes. Field names mirror the portal read mappers EXACTLY (see header).
// Everything carries isTestData: true.
// ---------------------------------------------------------------------------

/** AuntieOS-flat kinfolk identity doc (kinfolk/{id}). */
export interface KinfolkDoc {
  _id: string;
  businessName: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  status: 'active';
  isTestData: true;
}

/** families/{id} - getMyHome.displayName + getMyInvoices.accountBalanceCents. */
export interface FamilyDoc {
  _id: string;
  kinfolkId: string;
  displayName: string;
  accountBalanceCents: number;
  isTestData: true;
}

/** clients/{uid} - getMyAccess/resolveKinfolkAccess entry point. */
export interface ClientDoc {
  _id: string;
  kinfolkIds: string[];
  isTestData: true;
}

/** families/{id}/kin/{kinId} - getMyKin mapper fields. */
export interface KinDoc {
  _id: string;
  kinfolkId: string;
  name: string;
  species: string;
  breed: string;
  ageYears: number;
  photoUrl: string | null;
  status: 'active' | 'noLongerWithUs';
  feedingInstructions: string | null;
  walkingInstructions: string | null;
  medications: string | null;
  allergies: string | null;
  emergencyNotes: string | null;
  sitterNotes: string | null;
  isTestData: true;
}

/** families/{id}/bookings/{batchId} - getMyBookings envelope mapper fields. */
export interface BookingEnvelopeDoc {
  _id: string;
  familyId: string;
  kinfolkId: string;
  envelopeStatus: 'requested' | 'partiallyConfirmed' | 'confirmed' | 'inProgress' | 'completed' | 'cancelled';
  pattern: 'individual' | 'weekly';
  serviceName: string;
  kinIds: string[];
  kinNames: string[];
  notes: string;
  visitCount: number;
  confirmedCount: number;
  completedCount: number;
  firstStartTime: Timestamp;
  lastStartTime: Timestamp;
  isTestData: true;
}

export type KinCareStatus = 'requested' | 'confirmed' | 'completed' | 'cancelled';

/**
 * families/{id}/bookings/{batchId}/kinCares/{visitId} - the per-visit doc
 * getMyBookings finds via collectionGroup('kinCares').where('familyId'==...).
 * status is LOWERCASE; startTime/endTime are Firestore Timestamps (the mapper
 * tsMillis() also accepts numbers, but Timestamps match AuntieOS writes).
 */
export interface KinCareDoc {
  _id: string;
  batchId: string;
  familyId: string;
  kinfolkId: string;
  status: KinCareStatus;
  serviceType: string;
  serviceName: string;
  title: string;
  startTime: Timestamp;
  endTime: Timestamp;
  kinIds: string[];
  kinNames: string[];
  auntieDisplayName: string;
  notes: string;
  requestedByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  visitProgress: null;
  sourceBookingId: null;
  /** Back-reference to the flat kin_care_sessions mirror (same doc id). */
  sessionId: string;
  isTestData: true;
}

export type SessionStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';

/**
 * FLAT kin_care_sessions/{id} - getMyVisits overlay. AuntieOS casing
 * (uppercase status) and ISO-string times (stringOrNull mapper).
 */
export interface SessionDoc {
  _id: string;
  kinfolkId: string;
  kinIds: string[];
  kinfolkName: string;
  serviceType: string;
  status: SessionStatus;
  startTime: string;
  endTime: string;
  arrivedAt: string | null;
  departedAt: string | null;
  gpsSummary?: {
    distanceMeters: number;
    durationSeconds: number;
    startLat: number;
    startLng: number;
    endLat: number;
    endLng: number;
    route: Array<{ lat: number; lng: number; t: number }>;
    computedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  isTestData: true;
}

export type InvoiceStatus = 'open' | 'paid' | 'credit';

/** FLAT invoices/{id} - getMyInvoices mapper fields. */
export interface InvoiceDoc {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  /**
   * Canonical status field. Named `status` to match all 14 real invoices, which
   * were backfilled to real statuses on 2026-07-20 (they previously held a
   * meaningless "Yes"/"No" from the original import). The old `invoiceStatus`
   * spelling is still READ as a fallback by getMyInvoices and redeemCredit, but
   * nothing writes it any more.
   */
  status: InvoiceStatus;
  total: number;
  amountDue: number;
  date: string;
  dueDate: string;
  lineItems: Array<{ label: string; amount: number }>;
  /** Join to flat kin_care_sessions (lineItems join being added portal-side). */
  sessionIds: string[];
  paymentsHistory: string | null;
  /**
   * "Yes" | "No", NOT a boolean. Every real invoice stores this as a string and
   * both AuntieOS Kotlin models decode it as one, so a boolean here throws in
   * CustomClassMapper and takes the entire toObjects(Invoice) batch with it.
   */
  viewed: 'Yes' | 'No';
  creditTarget: 'accountBalance' | 'originalPaymentMethod' | null;
  creditRedeemedAt: string | null;
  isTestData: true;
}

export interface PaymentDoc {
  _id: string;
  kinfolkId: string;
  invoiceId: string;
  amount: number;
  currency: 'usd';
  status: 'succeeded';
  paidAt: string;
  isTestData: true;
}

/** FLAT kin_care_reports/{id} - getMyKinTales mapper fields (sentAt > ''). */
export interface ReportDoc {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  sessionId: string | null;
  kinIds: string[];
  authorId: string;
  authorDisplayName: string;
  serviceType: string;
  visitDate: string;
  title: string;
  bodyCopy: string;
  mediaFileIds: string[];
  sharedAsIds: string[];
  petMoodSelections?: Record<string, string>;
  status: 'SENT';
  sentAt: string;
  createdAt: string;
  updatedAt: string;
  isTestData: true;
}

export interface MediaFileDoc {
  _id: string;
  kinfolkId: string;
  kinId: string;
  storageUrl: string;
  contentType: string;
  isProfilePhoto: boolean;
  uploadedAt: string;
  isTestData: true;
}

/**
 * formSchemas/kinProfile - getFormSchema source. Copied from
 * scripts/seedDemoKinfolk.ts buildFormSchemas() kinProfile definition.
 * getFormSchema ignores unknown top-level keys, so isTestData is tolerated.
 */
export interface FormSchemaDoc {
  _id: string;
  id: string;
  name: string;
  description: string;
  version: number;
  sections: Array<{
    title: string;
    description: string;
    fields: Array<{
      key: string;
      label: string;
      type: 'text' | 'textarea' | 'number';
      required: boolean;
    }>;
  }>;
  isTestData: true;
}

export interface SandboxPayload {
  kinfolk: KinfolkDoc;
  family: FamilyDoc;
  client: ClientDoc;
  kin: KinDoc[];
  envelopes: BookingEnvelopeDoc[];
  kinCares: KinCareDoc[];
  sessions: SessionDoc[];
  invoices: InvoiceDoc[];
  payment: PaymentDoc;
  reports: ReportDoc[];
  media: MediaFileDoc;
  formSchema: FormSchemaDoc;
}

// ---------------------------------------------------------------------------
// Deterministic id helpers keyed off TEST_TRIBE_ID.
// ---------------------------------------------------------------------------
function kinId(n: number): string {
  return `${TEST_TRIBE_ID}-kin-${n}`;
}
function visitId(n: number): string {
  return `${TEST_TRIBE_ID}-visit-${n}`;
}
function batchId(tag: string): string {
  return `${TEST_TRIBE_ID}-batch-${tag}`;
}

// ---------------------------------------------------------------------------
// Time helpers. Booking buckets in getMyBookings are relative to Date.now()
// ("upcoming" requires startTime >= now - 60s), so the seed anchors on the run
// time. Idempotency comes from fixed doc ids + merge:false overwrite, NOT from
// byte-identical timestamps: a re-run resets the sandbox to "now"-relative
// state, which is exactly what a live-looking sandbox needs. Tests inject a
// fixed `now` for determinism.
// ---------------------------------------------------------------------------
function dayAt(now: Date, dayOffset: number, hourUtc: number, minuteUtc = 0): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, minuteUtc, 0, 0);
  return d;
}
function iso(d: Date): string {
  return d.toISOString();
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function ts(d: Date): Timestamp {
  return Timestamp.fromDate(d);
}

/**
 * Pure builder. No Firestore I/O (Timestamp.fromDate needs no app). Returns
 * the full sandbox payload; every doc tagged isTestData: true and scoped to
 * TEST_TRIBE_ID.
 *
 * @param now  Anchor for relative times (default: run time). Tests pass a
 *             fixed date so the payload is deterministic.
 * @param uid  Auth uid the clients doc is keyed by (default TEST_ADMIN_UID).
 */
export function buildSandboxPayload(now: Date = new Date(), uid: string = TEST_ADMIN_UID): SandboxPayload {
  const kinfolkName = 'TEST SANDBOX';
  const auntieName = 'TEST SANDBOX Auntie';

  const kinfolk: KinfolkDoc = {
    _id: TEST_TRIBE_ID,
    businessName: kinfolkName,
    displayName: kinfolkName,
    firstName: 'TEST',
    lastName: 'SANDBOX',
    email: TEST_ADMIN_EMAIL,
    phoneNumber: '+15550100199',
    status: 'active',
    isTestData: true,
  };

  const family: FamilyDoc = {
    _id: TEST_TRIBE_ID,
    kinfolkId: TEST_TRIBE_ID,
    displayName: kinfolkName,
    accountBalanceCents: 1500,
    isTestData: true,
  };

  const client: ClientDoc = {
    _id: uid,
    kinfolkIds: [TEST_TRIBE_ID],
    isTestData: true,
  };

  // 3 kin: dog with the full care-field set, cat with minimal fields, bird
  // noLongerWithUs to exercise the memorial state in the kin list.
  const kin: KinDoc[] = [
    {
      _id: kinId(1),
      kinfolkId: TEST_TRIBE_ID,
      name: 'Sandbox Dog',
      species: 'Dog',
      breed: 'Labrador Retriever',
      ageYears: 4,
      photoUrl: null,
      status: 'active',
      feedingInstructions: 'One cup kibble at 7am and 6pm. Slow-feeder bowl, he gulps.',
      walkingInstructions: '30 minutes around the block. Harness only, he backs out of collars.',
      medications: 'Apoquel 16mg, half tablet with breakfast.',
      allergies: 'Chicken. Check treat labels.',
      emergencyNotes: 'Vet: TEST Clinic, +1 555-010-0142. Microchip 985112000000001.',
      sitterNotes: 'Hides under the bed during thunder. Sit with him, do not crate.',
      isTestData: true,
    },
    {
      _id: kinId(2),
      kinfolkId: TEST_TRIBE_ID,
      name: 'Sandbox Cat',
      species: 'Cat',
      breed: 'Domestic Shorthair',
      ageYears: 7,
      photoUrl: null,
      status: 'active',
      feedingInstructions: 'Wet food half can, morning only. Dry food stays out.',
      walkingInstructions: null,
      medications: null,
      allergies: null,
      emergencyNotes: null,
      sitterNotes: null,
      isTestData: true,
    },
    {
      _id: kinId(3),
      kinfolkId: TEST_TRIBE_ID,
      name: 'Sandbox Bird',
      species: 'Bird',
      breed: 'Cockatiel',
      ageYears: 12,
      photoUrl: null,
      status: 'noLongerWithUs',
      feedingInstructions: null,
      walkingInstructions: null,
      medications: null,
      allergies: null,
      emergencyNotes: null,
      sitterNotes: null,
      isTestData: true,
    },
  ];
  const activeKinIds = [kinId(1), kinId(2)];
  const activeKinNames = ['Sandbox Dog', 'Sandbox Cat'];

  // -------------------------------------------------------------------------
  // Bookings: families tree. Envelope A holds 2 upcoming confirmed visits
  // (tomorrow, +3 days); envelope B holds 2 past visits (completed -7d,
  // cancelled -14d). kinCare ids double as the flat session ids.
  // -------------------------------------------------------------------------
  const upcomingBatch = batchId('upcoming');
  const pastBatch = batchId('past');

  const t1Start = dayAt(now, 1, 15); // tomorrow 15:00Z
  const t1End = dayAt(now, 1, 16);
  const t2Start = dayAt(now, 3, 16); // +3 days 16:00Z
  const t2End = dayAt(now, 3, 17);
  const p1Start = dayAt(now, -7, 15); // completed last week
  const p1End = dayAt(now, -7, 16);
  const p2Start = dayAt(now, -14, 15); // cancelled two weeks ago
  const p2End = dayAt(now, -14, 16);
  const p3Start = dayAt(now, -21, 15); // extra flat-only completed session
  const p3End = dayAt(now, -21, 16);

  const mkKinCare = (
    n: number,
    batch: string,
    status: KinCareStatus,
    start: Date,
    end: Date,
    title: string,
    notes: string,
  ): KinCareDoc => ({
    _id: visitId(n),
    batchId: batch,
    familyId: TEST_TRIBE_ID,
    kinfolkId: TEST_TRIBE_ID,
    status,
    serviceType: 'visit_60',
    serviceName: '60-Minute Drop-In',
    title,
    startTime: ts(start),
    endTime: ts(end),
    kinIds: activeKinIds,
    kinNames: activeKinNames,
    auntieDisplayName: auntieName,
    notes,
    requestedByUid: uid,
    createdAt: ts(dayAt(now, -30, 12)),
    updatedAt: ts(start),
    visitProgress: null,
    sourceBookingId: null,
    sessionId: visitId(n),
    isTestData: true,
  });

  const kinCares: KinCareDoc[] = [
    mkKinCare(1, upcomingBatch, 'confirmed', t1Start, t1End, 'Midday drop-in', 'Key is in the lockbox, code 0000.'),
    mkKinCare(2, upcomingBatch, 'confirmed', t2Start, t2End, 'Midday drop-in', 'Key is in the lockbox, code 0000.'),
    mkKinCare(3, pastBatch, 'completed', p1Start, p1End, 'Midday drop-in', ''),
    mkKinCare(4, pastBatch, 'cancelled', p2Start, p2End, 'Midday drop-in', 'Cancelled by kinfolk: travel plans changed.'),
  ];

  const envelopes: BookingEnvelopeDoc[] = [
    {
      _id: upcomingBatch,
      familyId: TEST_TRIBE_ID,
      kinfolkId: TEST_TRIBE_ID,
      envelopeStatus: 'confirmed',
      pattern: 'individual',
      serviceName: '60-Minute Drop-In',
      kinIds: activeKinIds,
      kinNames: activeKinNames,
      notes: 'Key is in the lockbox, code 0000.',
      visitCount: 2,
      confirmedCount: 2,
      completedCount: 0,
      firstStartTime: ts(t1Start),
      lastStartTime: ts(t2Start),
      isTestData: true,
    },
    {
      _id: pastBatch,
      familyId: TEST_TRIBE_ID,
      kinfolkId: TEST_TRIBE_ID,
      envelopeStatus: 'completed',
      pattern: 'individual',
      serviceName: '60-Minute Drop-In',
      kinIds: activeKinIds,
      kinNames: activeKinNames,
      notes: '',
      visitCount: 2,
      confirmedCount: 0,
      completedCount: 1,
      firstStartTime: ts(p2Start),
      lastStartTime: ts(p1Start),
      isTestData: true,
    },
  ];

  // -------------------------------------------------------------------------
  // Flat kin_care_sessions mirrors (getMyVisits overlay). Same ids as the
  // kinCares, AuntieOS uppercase status, ISO-string times. visit-5 is a
  // flat-only older completed session so the paid invoice has its own visit.
  // -------------------------------------------------------------------------
  const mkSession = (
    n: number,
    status: SessionStatus,
    start: Date,
    end: Date,
  ): SessionDoc => ({
    _id: visitId(n),
    kinfolkId: TEST_TRIBE_ID,
    kinIds: activeKinIds,
    kinfolkName,
    serviceType: 'visit_60',
    status,
    startTime: iso(start),
    endTime: iso(end),
    arrivedAt: status === 'COMPLETED' ? iso(new Date(start.getTime() + 2 * 60000)) : null,
    departedAt: status === 'COMPLETED' ? iso(new Date(end.getTime() - 3 * 60000)) : null,
    createdAt: iso(dayAt(now, -30, 12)),
    updatedAt: iso(end),
    isTestData: true,
  });

  const sessions: SessionDoc[] = [
    mkSession(1, 'SCHEDULED', t1Start, t1End),
    mkSession(2, 'SCHEDULED', t2Start, t2End),
    {
      ...mkSession(3, 'COMPLETED', p1Start, p1End),
      // GPS replay for the Schedule screen route map.
      gpsSummary: {
        distanceMeters: 1830,
        durationSeconds: 1740,
        startLat: 40.0161,
        startLng: -105.2811,
        endLat: 40.0161,
        endLng: -105.2811,
        route: [
          { lat: 40.0161, lng: -105.2811, t: p1Start.getTime() + 120000 },
          { lat: 40.0175, lng: -105.2790, t: p1Start.getTime() + 600000 },
          { lat: 40.0188, lng: -105.2812, t: p1Start.getTime() + 1200000 },
          { lat: 40.0161, lng: -105.2811, t: p1End.getTime() - 180000 },
        ],
        computedAt: iso(p1End),
      },
    },
    mkSession(4, 'CANCELLED', p2Start, p2End),
    mkSession(5, 'COMPLETED', p3Start, p3End),
  ];

  // -------------------------------------------------------------------------
  // Invoices (flat). One per getMyInvoices bucket. sessionIds reference the
  // seeded flat sessions (lineItems join is being added portal-side).
  // -------------------------------------------------------------------------
  const invoices: InvoiceDoc[] = [
    {
      _id: `${TEST_TRIBE_ID}-invoice-open`,
      kinfolkId: TEST_TRIBE_ID,
      kinfolkName,
      status: 'open',
      total: 4500,
      amountDue: 4500,
      date: isoDate(p1End),
      dueDate: isoDate(dayAt(now, 7, 0)),
      lineItems: [{ label: '60-Minute Drop-In', amount: 4500 }],
      sessionIds: [visitId(3)],
      paymentsHistory: null,
      viewed: 'No',
      creditTarget: null,
      creditRedeemedAt: null,
      isTestData: true,
    },
    {
      _id: `${TEST_TRIBE_ID}-invoice-paid`,
      kinfolkId: TEST_TRIBE_ID,
      kinfolkName,
      status: 'paid',
      total: 6000,
      amountDue: 0,
      date: isoDate(p3End),
      dueDate: isoDate(dayAt(now, -11, 0)),
      lineItems: [{ label: '60-Minute Drop-In', amount: 6000 }],
      sessionIds: [visitId(5)],
      paymentsHistory: `${isoDate(dayAt(now, -18, 0))}: 6000 paid, card ending 4242`,
      viewed: 'Yes',
      creditTarget: null,
      creditRedeemedAt: null,
      isTestData: true,
    },
    {
      _id: `${TEST_TRIBE_ID}-invoice-credit`,
      kinfolkId: TEST_TRIBE_ID,
      kinfolkName,
      status: 'credit',
      total: -2000,
      amountDue: -2000,
      date: isoDate(p2End),
      dueDate: isoDate(p2End),
      lineItems: [{ label: 'Credit for cancelled visit', amount: -2000 }],
      sessionIds: [visitId(4)],
      paymentsHistory: null,
      viewed: 'No',
      creditTarget: 'accountBalance',
      creditRedeemedAt: null,
      isTestData: true,
    },
  ];

  const payment: PaymentDoc = {
    _id: `${TEST_TRIBE_ID}-payment-1`,
    kinfolkId: TEST_TRIBE_ID,
    invoiceId: `${TEST_TRIBE_ID}-invoice-paid`,
    amount: 6000,
    currency: 'usd',
    status: 'succeeded',
    paidAt: isoDate(dayAt(now, -18, 0)),
    isTestData: true,
  };

  // -------------------------------------------------------------------------
  // KinTales (flat kin_care_reports). sentAt strictly descending; the newest
  // carries the media reference + a pet mood.
  // -------------------------------------------------------------------------
  const mediaId = `${TEST_TRIBE_ID}-media-1`;
  const mkReport = (
    n: number,
    sessionRef: string | null,
    sentAtDate: Date,
    title: string,
    bodyCopy: string,
    mediaFileIds: string[],
  ): ReportDoc => ({
    _id: `${TEST_TRIBE_ID}-report-${n}`,
    kinfolkId: TEST_TRIBE_ID,
    kinfolkName,
    sessionId: sessionRef,
    kinIds: activeKinIds,
    authorId: 'test-sandbox-author',
    authorDisplayName: auntieName,
    serviceType: 'visit_60',
    visitDate: isoDate(sentAtDate),
    title,
    bodyCopy,
    mediaFileIds,
    sharedAsIds: [],
    status: 'SENT',
    sentAt: iso(sentAtDate),
    createdAt: iso(new Date(sentAtDate.getTime() - 30 * 60000)),
    updatedAt: iso(sentAtDate),
    isTestData: true,
  });

  const reports: ReportDoc[] = [
    {
      ...mkReport(
        1,
        visitId(3),
        p1End,
        'Around the block twice, then a nap in the sun',
        'Sandbox Dog met me at the door with his leash hopes up. We did two laps of the block, 1.8 km in about 29 minutes. Back home he got his Apoquel half tablet in a spoon of peanut butter. Sandbox Cat supervised from the windowsill and accepted exactly four chin scratches.',
        [mediaId],
      ),
      petMoodSelections: { [kinId(1)]: 'happy', [kinId(2)]: 'relaxed' },
    },
    mkReport(
      2,
      null,
      dayAt(now, -13, 16),
      'Quick check-in before the storm',
      'Dropped by ahead of the forecast hail. Refilled water bowls, closed the porch windows, and set up the under-bed blanket fort Sandbox Dog uses for thunder. Both fed on schedule.',
      [],
    ),
    mkReport(
      3,
      visitId(5),
      p3End,
      'First visit: introductions all around',
      'Meet-and-greet visit. Sandbox Dog took the harness without a fuss once treats appeared. Sandbox Cat kept a floor lamp between us for the first twenty minutes, then decided my lap was acceptable. Notes on the lockbox and alarm are saved to the profile.',
      [],
    ),
  ];

  const media: MediaFileDoc = {
    _id: mediaId,
    kinfolkId: TEST_TRIBE_ID,
    kinId: kinId(1),
    storageUrl: 'https://example.test/sandbox-media-1.jpg',
    contentType: 'image/jpeg',
    isProfilePhoto: false,
    uploadedAt: iso(p1End),
    isTestData: true,
  };

  // formSchemas/kinProfile - copied from seedDemoKinfolk.ts buildFormSchemas().
  const formSchema: FormSchemaDoc = {
    _id: 'kinProfile',
    id: 'kinProfile',
    name: 'Kin Profile',
    description: 'The details that help your Auntie care for your Kin.',
    version: 1,
    sections: [
      {
        title: 'Profile',
        description: 'The basics about your Kin.',
        fields: [
          { key: 'species', label: 'Species (dog, cat, etc.)', type: 'text', required: false },
          { key: 'breed', label: 'Breed', type: 'text', required: false },
          { key: 'ageYears', label: 'Age (years)', type: 'number', required: false },
        ],
      },
      {
        title: 'Care',
        description: 'Feeding, walks, meds, and notes for your Auntie.',
        fields: [
          { key: 'feedingInstructions', label: 'Feeding Instructions', type: 'textarea', required: false },
          { key: 'walkingInstructions', label: 'Walking Instructions', type: 'textarea', required: false },
          { key: 'medications', label: 'Medications', type: 'textarea', required: false },
          { key: 'allergies', label: 'Allergies', type: 'textarea', required: false },
          { key: 'emergencyNotes', label: 'Emergency Notes', type: 'textarea', required: false },
          { key: 'sitterNotes', label: 'Sitter Notes', type: 'textarea', required: false },
        ],
      },
    ],
    isTestData: true,
  };

  return {
    kinfolk,
    family,
    client,
    kin,
    envelopes,
    kinCares,
    sessions,
    invoices,
    payment,
    reports,
    media,
    formSchema,
  };
}

export interface PlannedWrite {
  path: string;
  data: Record<string, unknown>;
}

/**
 * Flatten the sandbox payload into {path, data} planned writes. Pure.
 * Both shapes on purpose (see header): the families tree feeds the portal
 * list callables; the flat collections feed the visits/invoices/KinTales
 * overlays plus AuntieOS-side tooling.
 */
export function planAllWrites(now: Date = new Date(), uid: string = TEST_ADMIN_UID): PlannedWrite[] {
  const p = buildSandboxPayload(now, uid);
  const writes: PlannedWrite[] = [];
  const rec = (data: unknown): Record<string, unknown> => data as Record<string, unknown>;

  // Identity + access.
  writes.push({ path: `kinfolk/${p.kinfolk._id}`, data: rec(p.kinfolk) });
  writes.push({ path: `families/${p.family._id}`, data: rec(p.family) });
  writes.push({ path: `clients/${p.client._id}`, data: rec(p.client) });

  // Kin: families tree (portal reads) + flat mirror (AuntieOS-side tooling).
  for (const k of p.kin) {
    writes.push({ path: `families/${TEST_TRIBE_ID}/kin/${k._id}`, data: rec(k) });
    writes.push({ path: `kin/${k._id}`, data: rec(k) });
  }

  // Bookings: envelope + kinCares subcollection (collectionGroup target).
  for (const env of p.envelopes) {
    writes.push({ path: `families/${TEST_TRIBE_ID}/bookings/${env._id}`, data: rec(env) });
  }
  for (const kc of p.kinCares) {
    writes.push({
      path: `families/${TEST_TRIBE_ID}/bookings/${kc.batchId}/kinCares/${kc._id}`,
      data: rec(kc),
    });
  }

  // Flat overlays.
  for (const s of p.sessions) writes.push({ path: `kin_care_sessions/${s._id}`, data: rec(s) });
  for (const inv of p.invoices) writes.push({ path: `invoices/${inv._id}`, data: rec(inv) });
  writes.push({ path: `payments/${p.payment._id}`, data: rec(p.payment) });
  for (const r of p.reports) writes.push({ path: `kin_care_reports/${r._id}`, data: rec(r) });
  writes.push({ path: `media_files/${p.media._id}`, data: rec(p.media) });

  // Global form schema.
  writes.push({ path: `formSchemas/${p.formSchema._id}`, data: rec(p.formSchema) });

  return writes;
}

// Fixed paths that are scoped by their doc id rather than a kinfolkId field.
function allowedFixedPaths(uid: string): Set<string> {
  return new Set([
    `kinfolk/${TEST_TRIBE_ID}`,
    `families/${TEST_TRIBE_ID}`,
    `clients/${uid}`,
    'formSchemas/kinProfile',
  ]);
}

/**
 * Safety invariant: every planned write must be scoped to the test tribe and
 * carry isTestData: true. Scoping is satisfied by a kinfolkId or familyId
 * field == TEST_TRIBE_ID, or by being one of the fixed allowlisted doc paths.
 * Throws (fail-loud) on any doc that escapes the sandbox.
 */
export function assertAllScoped(writes: PlannedWrite[], uid: string = TEST_ADMIN_UID): void {
  const fixed = allowedFixedPaths(uid);
  for (const w of writes) {
    if (w.data.isTestData !== true) {
      throw new Error(`assertAllScoped: ${w.path} missing isTestData:true`);
    }
    if (fixed.has(w.path)) continue;
    const scoped = w.data.kinfolkId === TEST_TRIBE_ID || w.data.familyId === TEST_TRIBE_ID;
    if (!scoped) {
      throw new Error(
        `assertAllScoped: ${w.path} kinfolkId=${JSON.stringify(w.data.kinfolkId)} familyId=${JSON.stringify(
          w.data.familyId,
        )} != ${TEST_TRIBE_ID}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Auth user provisioning (Admin SDK). Idempotent: looks up by email first;
// creates with the FIXED uid so clients/{uid} lines up.
// ---------------------------------------------------------------------------
async function ensureTestAdminUser(password: string | null): Promise<string> {
  const auth = getAuth();
  let uid: string;
  try {
    const existing = await auth.getUserByEmail(TEST_ADMIN_EMAIL);
    uid = existing.uid;
    console.log(`[auth] test admin already exists uid=${uid}`);
    if (uid !== TEST_ADMIN_UID) {
      console.warn(
        `[auth] WARNING: existing uid ${uid} != expected ${TEST_ADMIN_UID}; ` +
          'clients doc will be written under the ACTUAL uid.',
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'auth/user-not-found') {
      throw err; // fail loud on any non-"not found" error
    }
    const created = await auth.createUser({
      uid: TEST_ADMIN_UID,
      email: TEST_ADMIN_EMAIL,
      emailVerified: false,
      displayName: TEST_ADMIN_DISPLAY_NAME,
      disabled: false,
      ...(password ? { password } : {}),
    });
    uid = created.uid;
    console.log(`[auth] created test admin uid=${uid}`);
  }

  // Set the claim every run so it converges. NEVER admin:true.
  await auth.setCustomUserClaims(uid, { testTribeId: TEST_TRIBE_ID });
  console.log(`[auth] set custom claim { testTribeId: '${TEST_TRIBE_ID}' } on uid=${uid}`);
  return uid;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const planPreview = planAllWrites(now);
  // Belt-and-suspenders: never let an out-of-scope doc reach Firestore.
  assertAllScoped(planPreview);

  console.log(`seed_test_sandbox  mode=${args.apply ? 'apply' : 'dry-run'}  tribe=${TEST_TRIBE_ID}`);
  console.log(`[plan] ${planPreview.length} doc writes + 1 Auth user + 1 custom claim`);
  for (const w of planPreview) {
    console.log(`  [plan] ${w.path}`);
  }
  console.log(`  [plan] auth user ${TEST_ADMIN_EMAIL} (uid ${TEST_ADMIN_UID}) -> claim { testTribeId: '${TEST_TRIBE_ID}' }`);

  if (!args.apply) {
    console.log('\nDRY-RUN. No Auth or Firestore writes performed. Re-run with --apply to commit.');
    return;
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS not set. Export the auntieos-ttpc service-account key path before --apply. Refusing to fall back silently.',
    );
  }

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId });
  }
  console.log(`\n[init] projectId=${projectId}`);

  const uid = await ensureTestAdminUser(args.password);

  // Rebuild the plan against the ACTUAL uid (matters only if a pre-existing
  // user has a different uid than TEST_ADMIN_UID).
  const writes = uid === TEST_ADMIN_UID ? planPreview : planAllWrites(now, uid);
  assertAllScoped(writes, uid);

  const db = getFirestore();
  let written = 0;
  for (const w of writes) {
    // merge:false + fixed doc ids -> re-runs RESET the sandbox to this exact
    // baseline (stale fields from manual testing are wiped, not merged around).
    await db.doc(w.path).set(w.data, { merge: false });
    console.log(`[seeded] ${w.path}`);
    written += 1;
  }

  console.log(`\nfinal: written=${written} docs, test admin uid=${uid}`);
  console.log(
    'Next: operator sets/resets the test admin password via the Firebase console ' +
      '(or re-run with --apply --password=<pw>).',
  );
}

// Run main only when invoked directly. Importing for tests does not write.
if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
