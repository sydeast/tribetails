/**
 * seedDemoKinfolk.ts — Phase 1 demo kinfolk mock data seed.
 *
 * Seeds two demo kinfolk fixtures (`demo-family-001`, `demo-family-002`) plus
 * downstream collections so MyTribe + AuntieOS operator-mode QA has realistic
 * test data without polluting prod with arbitrary fake content.
 *
 * Per [[never-author-user-facing-copy]]: ALL kinfolk-facing text on these docs
 * is an explicit placeholder ("TODO: ...") so the user can replace it later.
 * We populate structure + schema only; no real copy.
 *
 * Collections seeded (canonical names — Android repository + MyTribe portal fns):
 *   - kinfolk/{id}               doc per family
 *   - kin/{id}                   2 pets per family
 *   - kin_care_sessions/{id}     3 historical sessions per family
 *   - kin_care_reports/{id}      1-2 reports per session
 *   - the_411/{id}               one per kin (keyed by 411_{kinId})
 *   - dossiers/{id}              one per family (keyed by dossier_{kinfolkId})
 *
 * Idempotency: every doc has a deterministic id derived from the demo family id.
 * Re-runs use set({merge: true}) so the payload re-converges. Running twice
 * never duplicates docs and never corrupts existing fields.
 *
 * Safety: refuses to write to prod unless `--allow-prod` is passed. Default is
 * a dry-run that logs every planned write.
 *
 * Service account auth: requires GOOGLE_APPLICATION_CREDENTIALS env var OR
 * Application Default Credentials. Fails loud if creds missing.
 */

import * as admin from 'firebase-admin';

// ---------------------------------------------------------------------------
// Demo family ids — these must match the placeholders already in the
// `clients/{adminUid}.kinfolkIds` array. Do NOT change these without a
// matching clients-doc update.
// ---------------------------------------------------------------------------
export const DEMO_FAMILY_IDS = ['demo-family-001', 'demo-family-002'] as const;
export type DemoFamilyId = (typeof DEMO_FAMILY_IDS)[number];

// ---------------------------------------------------------------------------
// Placeholder text marker — every user-facing string written by this script
// MUST begin with "TODO" or "[placeholder]" so it's grep-able + obviously fake.
// ---------------------------------------------------------------------------
const TODO = (s: string): string => `TODO: ${s}`;
const PLACEHOLDER_RE = /^(TODO:|\[placeholder\])/;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
interface Args {
  dryRun: boolean;
  allowProd: boolean;
  projectId: string | null;
  linkUid: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true, allowProd: false, projectId: null, linkUid: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a.startsWith('--link-uid=')) {
      const v = a.slice('--link-uid='.length);
      if (!v) throw new Error('--link-uid requires a value (--link-uid=<uid>)');
      args.linkUid = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'seedDemoKinfolk.ts — Phase 1 demo kinfolk mock data seed',
          '',
          'Usage:',
          '  ts-node seedDemoKinfolk.ts                       # dry-run (default)',
          '  ts-node seedDemoKinfolk.ts --allow-prod          # actually write',
          '  ts-node seedDemoKinfolk.ts --project <projectId> # override project',
          '  ts-node seedDemoKinfolk.ts --link-uid=<uid>      # link tester uid to demo-family-001',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service account JSON path (or ADC)',
          '  GCLOUD_PROJECT                  Firebase project id (default auntieos-ttpc)',
          '  FIRESTORE_EMULATOR_HOST         when set, --allow-prod not required',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  // --allow-prod implies non-dry-run
  if (args.allowProd) args.dryRun = false;
  return args;
}

// ---------------------------------------------------------------------------
// Payload shape — pure typed builders. All exported for vitest use.
// ---------------------------------------------------------------------------
export interface KinfolkDoc {
  _id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phoneNumber: string;
  status: 'active';
  joinDate: string; // ISO-8601
  householdMemberCount: number;
  _demo: true;
  _demoCreatedAt: string;
}

export interface KinDoc {
  _id: string;
  kinfolkId: string;
  name: string;
  species: string;
  breed: string;
  age: string;
  status: 'active';
  _demo: true;
}

export interface SessionDoc {
  _id: string;
  kinfolkId: string;
  kinIds: string[];
  kinfolkName: string;
  serviceType: string;
  startTime: string;
  endTime: string;
  status: 'COMPLETED';
  arrivedAt: string;
  departedAt: string;
  completedAt: string;
  reportIds: string[];
  createdAt: string;
  updatedAt: string;
  _demo: true;
}

export interface ReportDoc {
  _id: string;
  sessionId: string;
  kinfolkId: string;
  kinfolkName: string;
  kinIds: string[];
  authorId: string;
  authorDisplayName: string;
  serviceType: string;
  visitDate: string;
  arrivedAt: string;
  departedAt: string;
  bodyCopy: string;
  mediaFileIds: string[];
  status: 'SENT';
  sentAt: string;
  sentVia: 'demo_seed';
  createdAt: string;
  updatedAt: string;
  _demo: true;
}

export interface Kin411Doc {
  _id: string;
  kinId: string;
  breed: string;
  personality: string;
  quirksAndPreferences: string;
  medicalNotes: string;
  dietaryDetails: string;
  rawSummary: string;
  feedingAmount: string;
  feedingFrequency: string;
  pottyRoutine: string;
  reactive: false;
  lastUpdated: string;
  lastReconciledAt: string;
  lastReconcileSourceLogIds: string[];
  needsMoreSamples: true;
  _demo: true;
  _placeholder: true;
}

export interface DossierDoc {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  communicationStyle: string;
  householdNotes: string;
  relationshipWithAuntie: string;
  importantLifeContext: string;
  preferredContactMethod: string;
  rawSummary: string;
  lastReconciledAt: string;
  lastReconcileSourceLogIds: string[];
  needsMoreSamples: true;
  _demo: true;
  _placeholder: true;
}

// ---------------------------------------------------------------------------
// MyTribe-portal-shaped docs (separate `families/` collection tree). These let
// getMyHome (name + balance), getMyBookings, and getMyInvoices resolve demo
// data without an AuntieOS round-trip. Field names mirror the portal callables:
//   - getMyHome.ts          reads families/{fam}.displayName
//   - getMyInvoices.ts      reads families/{fam}.accountBalanceCents
//   - getMyBookings.ts      reads families/{fam}/bookings/* (lowercase status enum)
//   - getMyInvoices.ts      reads flat invoices/{id} where kinfolkId == fam
// ---------------------------------------------------------------------------
export interface FamilyDoc {
  _id: string;
  displayName: string;
  accountBalanceCents: number;
  _demo: true;
}

// Status casing matches getMyBookings.ts bucketing (lowercase enum). The reader
// puts active/enRoute -> liveVisit, requested/confirmed (future) -> upcoming,
// completed/cancelled -> recent. startTime/endTime are epoch millis numbers
// because getMyBookings tsMillis() accepts a plain number, keeping the payload
// deterministic for deep-equal idempotency checks.
export interface BookingDoc {
  _id: string;
  kinfolkId: string;
  status: 'requested' | 'confirmed' | 'enRoute' | 'active' | 'completed' | 'cancelled';
  serviceType: string;
  serviceName: string;
  title: string;
  startTime: number;
  endTime: number;
  kinIds: string[];
  kinNames: string[];
  auntieDisplayName: string;
  notes: string;
  requestBatchId: string;
  visitProgress: 'confirmed' | 'enRoute' | 'active' | 'ended' | null;
  createdAt: number;
  updatedAt: number;
  _demo: true;
}

// Invoice shape matches getMyInvoices.ts. `invoiceStatus` is the canonical
// status field the reader keys on; amountDue/total drive the credit math.
export interface InvoiceDoc {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  invoiceStatus: 'open' | 'paid' | 'credit';
  total: number;
  amountDue: number;
  date: string;
  dueDate: string;
  lineItems: Array<{ label: string; amount: number }>;
  // Credit-only fields (present on the credit doc so redeemCredit + the UI work).
  creditTarget: 'accountBalance' | 'originalPaymentMethod' | null;
  creditRedeemedAt: string | null;
  _demo: true;
}

// formSchemas/{id} doc shape read by getFormSchema.ts. The reader only consumes
// name/description/version/sections and ignores unknown top-level keys, so the
// extra `_demo: true` marker is tolerated (verified against getFormSchema.ts).
export interface FormSchemaField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'multiselect' | 'date' | 'number' | 'checkbox' | 'phone' | 'email';
  required: boolean;
  helperText?: string;
  options?: string[];
}
export interface FormSchemaSection {
  title: string;
  description: string;
  fields: FormSchemaField[];
}
export interface FormSchemaDoc {
  _id: string;
  id: string;
  name: string;
  description: string;
  version: number;
  sections: FormSchemaSection[];
  _demo: true;
}

export interface PlannedWrite {
  path: string;
  data: Record<string, unknown>;
}

export interface SeedPayload {
  kinfolk: KinfolkDoc;
  kin: KinDoc[];
  sessions: SessionDoc[];
  reports: ReportDoc[];
  the411: Kin411Doc[];
  dossier: DossierDoc;
  family: FamilyDoc;
  bookings: BookingDoc[];
  invoices: InvoiceDoc[];
}

// ---------------------------------------------------------------------------
// Deterministic id helpers
// ---------------------------------------------------------------------------
function kinId(fam: string, n: number): string {
  return `${fam}-kin-${n}`;
}
function sessionId(fam: string, n: number): string {
  return `${fam}-session-${n}`;
}
function reportId(fam: string, n: number): string {
  return `${fam}-report-${n}`;
}
function the411Id(kinDocId: string): string {
  // Mirrors the Python seed convention `411_{kinId}` so admin tooling that
  // expects that prefix continues to work.
  return `411_${kinDocId}`;
}
function dossierId(fam: string): string {
  return `dossier_${fam}`;
}
function bookingId(fam: string, n: number): string {
  return `${fam}-booking-${n}`;
}
function invoiceId(fam: string, n: number): string {
  return `${fam}-invoice-${n}`;
}

// ---------------------------------------------------------------------------
// Deterministic timestamps — keyed off the family id so re-runs converge to
// the same ISO strings, keeping idempotency tight even on field comparisons.
// ---------------------------------------------------------------------------
function baseDateForFamily(fam: DemoFamilyId): Date {
  // Anchor: 2026-01-01 + index*7 days. 001 → Jan 1, 002 → Jan 8, etc.
  const idx = DEMO_FAMILY_IDS.indexOf(fam);
  if (idx < 0) throw new Error(`baseDateForFamily: unknown family ${fam}`);
  return new Date(Date.UTC(2026, 0, 1 + idx * 7, 9, 0, 0));
}

function isoOffsetDays(base: Date, days: number, hours = 0): string {
  const d = new Date(base.getTime() + days * 86400000 + hours * 3600000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Payload builder — pure. No Firestore deps. Tested in isolation.
// ---------------------------------------------------------------------------
export function buildSeedPayload(fam: DemoFamilyId): SeedPayload {
  if (!DEMO_FAMILY_IDS.includes(fam)) {
    throw new Error(`buildSeedPayload: ${fam} is not a known demo family id`);
  }
  const base = baseDateForFamily(fam);
  const joinIso = isoOffsetDays(base, -180); // joined ~6 months ago

  const familyLabel = fam === 'demo-family-001' ? 'Alpha' : 'Beta';
  const isAlpha = fam === 'demo-family-001';

  // Mock data — clearly fake names, real-looking values so operator UI demo
  // mode renders cleanly. `_demo: true` + `_placeholder: true` flags remain
  // the canonical "this is seed data" signal at every consumer.
  const mock = isAlpha
    ? {
        kinfolkFirst: 'Sandy',
        kinfolkLast: 'Demo',
        kinfolkDisplay: 'Sandy Demo',
        pet1Name: 'Buddy',
        pet1Breed: 'Golden Retriever',
        pet2Name: 'Whiskers',
        pet2Breed: 'Tabby Cat',
        kinTaleBody:
          'Demo visit narrative — Buddy was happy and playful, ran to greet me at the door. Whiskers napped on the windowsill. Both pets ate well; fresh water topped off before I left.',
        pet1Personality: 'Playful, food-motivated, loves people',
        pet1Quirks: 'Loves belly rubs. Jumps when excited. Heavy shedder.',
        pet1Medical: 'None — annual vaccines current',
        pet1Diet: 'Kibble (Hill’s Science Diet adult)',
        pet1FeedAmt: '1 cup',
        pet1FeedFreq: 'Morning + evening',
        pet1Potty: 'Outside every 4 hours, sleeps through night',
        pet2Personality: 'Independent, affectionate in evenings',
        pet2Quirks: 'Hides under bed when stressed. Loves laser pointers.',
        pet2Medical: 'None — indoor cat, annual check-ups',
        pet2Diet: 'Wet food (Fancy Feast) morning, dry overnight',
        pet2FeedAmt: '1/2 can wet + 1/4 cup dry',
        pet2FeedFreq: 'Twice daily',
        pet2Potty: 'Self-serve litter box, scoop daily',
        commStyle: 'Text message preferred, photo updates welcome',
        household: 'Single-family home. Two pets, no children. Quiet neighborhood.',
        relationship: 'Demo kinfolk for operator QA testing',
        lifeContext: 'Seed data — this row exists for app-mode demonstration.',
        contact: 'SMS',
      }
    : {
        kinfolkFirst: 'Pat',
        kinfolkLast: 'Mock',
        kinfolkDisplay: 'Pat Mock',
        pet1Name: 'Rex',
        pet1Breed: 'German Shepherd',
        pet2Name: 'Luna',
        pet2Breed: 'Persian',
        kinTaleBody:
          'Demo visit narrative — Rex enjoyed his walk and was very alert. Luna lounged in the sunbeam most of the visit. Standard 60-minute drop-in completed without incident.',
        pet1Personality: 'Loyal, alert, protective',
        pet1Quirks: 'Barks at delivery trucks. Loves the back yard.',
        pet1Medical: 'Joint supplement (1 chew daily) for hips',
        pet1Diet: 'Dry food (Purina Pro Plan) + chicken topper',
        pet1FeedAmt: '2 cups',
        pet1FeedFreq: 'Morning + evening',
        pet1Potty: 'Outside every 6 hours, sleeps in crate at night',
        pet2Personality: 'Calm, low-energy indoor cat',
        pet2Quirks: 'Grooms after meals. Sensitive to loud noises.',
        pet2Medical: 'Regular brushing required to prevent matting',
        pet2Diet: 'Premium dry food (Royal Canin Persian)',
        pet2FeedAmt: '1/4 cup',
        pet2FeedFreq: 'Twice daily',
        pet2Potty: 'Upstairs litter box, scoop daily',
        commStyle: 'Email preferred for scheduling, text for emergencies',
        household: 'Townhouse. Two pets, work-from-home kinfolk most days.',
        relationship: 'Newer demo kinfolk for operator QA testing',
        lifeContext: 'Seed data — this row exists for app-mode demonstration.',
        contact: 'Email',
      };
  const auntieDisplayName = 'Auntie Demo';

  const kinfolk: KinfolkDoc = {
    _id: fam,
    firstName: mock.kinfolkFirst,
    lastName: mock.kinfolkLast,
    displayName: mock.kinfolkDisplay,
    // Reserved RFC 6761 TLD — never deliverable, never confused with real kinfolk.
    email: `demo+${familyLabel.toLowerCase()}@tribetails.test`,
    phoneNumber: isAlpha ? '+15550100101' : '+15550100102',
    status: 'active',
    joinDate: joinIso,
    householdMemberCount: 2,
    _demo: true,
    _demoCreatedAt: joinIso,
  };

  // Two kin per family. Schema mirrors Kin model (FirestoreClient.kt + Android Models.kt).
  const kin: KinDoc[] = [
    {
      _id: kinId(fam, 1),
      kinfolkId: fam,
      name: mock.pet1Name,
      species: 'Dog',
      breed: mock.pet1Breed,
      age: '4',
      status: 'active',
      _demo: true,
    },
    {
      _id: kinId(fam, 2),
      kinfolkId: fam,
      name: mock.pet2Name,
      species: 'Cat',
      breed: mock.pet2Breed,
      age: '7',
      status: 'active',
      _demo: true,
    },
  ];

  const kinIds = kin.map((k) => k._id);

  // Three historical completed sessions per family. ~30/14/3 days back.
  const sessionOffsets = [-30, -14, -3];
  const sessions: SessionDoc[] = sessionOffsets.map((offset, i) => {
    const start = isoOffsetDays(base, offset, 10);   // 10:00 UTC
    const arrived = isoOffsetDays(base, offset, 10);
    const departed = isoOffsetDays(base, offset, 11); // 1hr visit
    const end = departed;
    return {
      _id: sessionId(fam, i + 1),
      kinfolkId: fam,
      kinIds,
      kinfolkName: mock.kinfolkDisplay,
      serviceType: 'visit_60',
      startTime: start,
      endTime: end,
      status: 'COMPLETED',
      arrivedAt: arrived,
      departedAt: departed,
      completedAt: departed,
      reportIds: [reportId(fam, i + 1)],
      createdAt: start,
      updatedAt: departed,
      _demo: true,
    };
  });

  // One report per session = 3 per family (>= 2 required by spec).
  const reports: ReportDoc[] = sessions.map((s, i) => ({
    _id: reportId(fam, i + 1),
    sessionId: s._id,
    kinfolkId: fam,
    kinfolkName: mock.kinfolkDisplay,
    kinIds,
    authorId: 'demo-seed-author',
    authorDisplayName: auntieDisplayName,
    serviceType: s.serviceType,
    visitDate: s.startTime.slice(0, 10),
    arrivedAt: s.arrivedAt,
    departedAt: s.departedAt,
    bodyCopy: mock.kinTaleBody,
    mediaFileIds: [],
    status: 'SENT',
    sentAt: s.departedAt,
    sentVia: 'demo_seed',
    createdAt: s.startTime,
    updatedAt: s.departedAt,
    _demo: true,
  }));

  // 411 per kin. Marked _demo + _placeholder + needsMoreSamples so the UI
  // can still surface a "demo data" badge while showing realistic content.
  const the411: Kin411Doc[] = kin.map((k, idx) => {
    const isFirst = idx === 0;
    return {
      _id: the411Id(k._id),
      kinId: k._id,
      breed: isFirst ? mock.pet1Breed : mock.pet2Breed,
      personality: isFirst ? mock.pet1Personality : mock.pet2Personality,
      quirksAndPreferences: isFirst ? mock.pet1Quirks : mock.pet2Quirks,
      medicalNotes: isFirst ? mock.pet1Medical : mock.pet2Medical,
      dietaryDetails: isFirst ? mock.pet1Diet : mock.pet2Diet,
      rawSummary: '',
      feedingAmount: isFirst ? mock.pet1FeedAmt : mock.pet2FeedAmt,
      feedingFrequency: isFirst ? mock.pet1FeedFreq : mock.pet2FeedFreq,
      pottyRoutine: isFirst ? mock.pet1Potty : mock.pet2Potty,
      reactive: false,
      lastUpdated: joinIso,
      lastReconciledAt: '',
      lastReconcileSourceLogIds: [],
      needsMoreSamples: true,
      _demo: true,
      _placeholder: true,
    };
  });

  // Dossier per family. Same demo flagging as 411.
  const dossier: DossierDoc = {
    _id: dossierId(fam),
    kinfolkId: fam,
    kinfolkName: mock.kinfolkDisplay,
    communicationStyle: mock.commStyle,
    householdNotes: mock.household,
    relationshipWithAuntie: mock.relationship,
    importantLifeContext: mock.lifeContext,
    preferredContactMethod: mock.contact,
    rawSummary: '',
    lastReconciledAt: '',
    lastReconcileSourceLogIds: [],
    needsMoreSamples: true,
    _demo: true,
    _placeholder: true,
  };

  // MyTribe `families/{fam}` doc so getMyHome resolves displayName (its #1
  // fallback) and getMyInvoices resolves accountBalanceCents.
  const family: FamilyDoc = {
    _id: fam,
    displayName: mock.kinfolkDisplay,
    accountBalanceCents: isAlpha ? 2500 : 0,
    _demo: true,
  };

  // Bookings spanning every getMyBookings bucket. Times are epoch-millis
  // numbers (deterministic, no Date.now()). Upcoming visits anchor to a fixed
  // far-future date so they always satisfy the reader's `startTime >= now`
  // filter without depending on wall-clock time at seed-build.
  const dayMs = 86400000;
  const liveStartMs = base.getTime();                 // anchored "today" for the demo family
  const liveEndMs = liveStartMs + 60 * 60000;         // 1hr visit
  // 2099-anchored upcoming so they never fall out of the future window.
  const upcomingBase = Date.UTC(2099, 0, 1, 14, 0, 0);
  const upcoming1StartMs = upcomingBase + (isAlpha ? 0 : 7 * dayMs);
  const upcoming2StartMs = upcoming1StartMs + 3 * dayMs;
  const completedStartMs = liveStartMs - 5 * dayMs;
  const requestBatchId = `demo-batch-${fam}`;
  const kinNames = [mock.pet1Name, mock.pet2Name];

  const bookings: BookingDoc[] = [
    {
      _id: bookingId(fam, 1),
      kinfolkId: fam,
      status: 'active',
      serviceType: 'visit_60',
      serviceName: '60-minute drop-in',
      title: '60-minute drop-in',
      startTime: liveStartMs,
      endTime: liveEndMs,
      kinIds,
      kinNames,
      auntieDisplayName,
      notes: 'Demo live visit in progress for app-mode preview.',
      requestBatchId,
      visitProgress: 'active',
      createdAt: liveStartMs - dayMs,
      updatedAt: liveStartMs,
      _demo: true,
    },
    {
      _id: bookingId(fam, 2),
      kinfolkId: fam,
      status: 'requested',
      serviceType: 'visit_30',
      serviceName: '30-minute drop-in',
      title: '30-minute drop-in',
      startTime: upcoming1StartMs,
      endTime: upcoming1StartMs + 30 * 60000,
      kinIds,
      kinNames,
      auntieDisplayName,
      notes: 'Demo upcoming visit, awaiting Auntie confirmation.',
      requestBatchId,
      visitProgress: null,
      createdAt: liveStartMs,
      updatedAt: liveStartMs,
      _demo: true,
    },
    {
      _id: bookingId(fam, 3),
      kinfolkId: fam,
      status: 'confirmed',
      serviceType: 'visit_60',
      serviceName: '60-minute drop-in',
      title: '60-minute drop-in',
      startTime: upcoming2StartMs,
      endTime: upcoming2StartMs + 60 * 60000,
      kinIds,
      kinNames,
      auntieDisplayName,
      notes: 'Demo upcoming visit, confirmed by your Auntie.',
      requestBatchId,
      visitProgress: null,
      createdAt: liveStartMs,
      updatedAt: liveStartMs,
      _demo: true,
    },
    {
      _id: bookingId(fam, 4),
      kinfolkId: fam,
      status: 'completed',
      serviceType: 'visit_60',
      serviceName: '60-minute drop-in',
      title: '60-minute drop-in',
      startTime: completedStartMs,
      endTime: completedStartMs + 60 * 60000,
      kinIds,
      kinNames,
      auntieDisplayName,
      notes: 'Demo completed visit, KinTale already sent.',
      requestBatchId,
      visitProgress: 'ended',
      createdAt: completedStartMs - dayMs,
      updatedAt: completedStartMs + 60 * 60000,
      _demo: true,
    },
  ];

  // Invoices: one open, one paid, one credit. getMyInvoices keys on
  // invoiceStatus and uses amountDue/total for the credit math. The credit doc
  // carries creditTarget + creditRedeemedAt so the redeem flow + UI render.
  const invDate = isoOffsetDays(base, -20).slice(0, 10);
  const invDue = isoOffsetDays(base, 10).slice(0, 10);
  const invoices: InvoiceDoc[] = [
    {
      _id: invoiceId(fam, 1),
      kinfolkId: fam,
      kinfolkName: mock.kinfolkDisplay,
      invoiceStatus: 'open',
      total: 60,
      amountDue: 60,
      date: invDate,
      dueDate: invDue,
      lineItems: [{ label: '60-minute drop-in', amount: 60 }],
      creditTarget: null,
      creditRedeemedAt: null,
      _demo: true,
    },
    {
      _id: invoiceId(fam, 2),
      kinfolkId: fam,
      kinfolkName: mock.kinfolkDisplay,
      invoiceStatus: 'paid',
      total: 90,
      amountDue: 0,
      date: isoOffsetDays(base, -45).slice(0, 10),
      dueDate: isoOffsetDays(base, -35).slice(0, 10),
      lineItems: [
        { label: '60-minute drop-in', amount: 60 },
        { label: '30-minute drop-in', amount: 30 },
      ],
      creditTarget: null,
      creditRedeemedAt: null,
      _demo: true,
    },
    {
      _id: invoiceId(fam, 3),
      kinfolkId: fam,
      kinfolkName: mock.kinfolkDisplay,
      invoiceStatus: 'credit',
      total: -25,
      amountDue: -25,
      date: isoOffsetDays(base, -10).slice(0, 10),
      dueDate: isoOffsetDays(base, -10).slice(0, 10),
      lineItems: [{ label: 'Goodwill credit for a rescheduled visit', amount: -25 }],
      creditTarget: 'accountBalance',
      creditRedeemedAt: null,
      _demo: true,
    },
  ];

  return { kinfolk, kin, sessions, reports, the411, dossier, family, bookings, invoices };
}

// ---------------------------------------------------------------------------
// Global form-schema seeds. These are NOT _demo-scoped collections (formSchemas
// are global, read by getFormSchema.ts), but getFormSchema only consumes
// name/description/version/sections and ignores unknown top-level keys, so the
// `_demo: true` marker rides along harmlessly. Built once (not per-family) and
// gated behind the same dry-run / --allow-prod safety as everything else.
// ---------------------------------------------------------------------------
export function buildFormSchemas(): FormSchemaDoc[] {
  return [
    {
      _id: 'tribeProfile',
      id: 'tribeProfile',
      name: 'Tribe Profile',
      description: 'Tell us about your household so your Auntie shows up ready.',
      version: 1,
      sections: [
        {
          title: 'About your tribe',
          description: 'The basics about your household.',
          fields: [
            { key: 'displayName', label: 'Household name', type: 'text', required: true, helperText: 'How we address your tribe.' },
            { key: 'aboutUs', label: 'About your household', type: 'textarea', required: false },
          ],
        },
        {
          title: 'Reaching you',
          description: 'How to get in touch during a visit.',
          fields: [
            { key: 'primaryPhone', label: 'Primary phone', type: 'phone', required: true },
            { key: 'contactPref', label: 'Preferred contact', type: 'select', required: false, options: ['Text', 'Call', 'Email'] },
          ],
        },
      ],
      _demo: true,
    },
    {
      _id: 'homeAccess',
      id: 'homeAccess',
      name: 'Home Access',
      description: 'How your Auntie gets in and what to know once inside.',
      version: 1,
      sections: [
        {
          title: 'Getting inside',
          description: 'Entry details for your home.',
          fields: [
            { key: 'entryMethod', label: 'Entry method', type: 'select', required: true, options: ['Lockbox', 'Keypad', 'Hidden key', 'I will be home'] },
            { key: 'entryCode', label: 'Entry code or lockbox combo', type: 'text', required: false, helperText: 'Leave blank if you will be home.' },
          ],
        },
        {
          title: 'Once inside',
          description: 'Anything to know after the door opens.',
          fields: [
            { key: 'alarmNotes', label: 'Alarm steps', type: 'textarea', required: false },
            { key: 'parkingNotes', label: 'Parking notes', type: 'textarea', required: false },
          ],
        },
      ],
      _demo: true,
    },
    {
      _id: 'account',
      id: 'account',
      name: 'Account Settings',
      description: 'Your contact details and a backup so we can always reach you.',
      version: 1,
      sections: [
        {
          title: 'Profile',
          description: 'How we address you and reach you day to day.',
          fields: [
            { key: 'displayName', label: 'Display Name', type: 'text', required: true },
            { key: 'phone', label: 'Phone', type: 'phone', required: false },
          ],
        },
        {
          title: 'Secondary Contact',
          description: 'A partner or family member who can step in.',
          fields: [
            { key: 'secondaryEmail', label: 'Email', type: 'email', required: false },
            { key: 'secondaryRole', label: 'Their role (e.g. Co-Parent, Sister)', type: 'text', required: false },
          ],
        },
        {
          title: 'Recovery',
          description: 'A backup email and phone in case you lose access.',
          fields: [
            { key: 'backupEmail', label: 'Backup Email', type: 'email', required: false },
            { key: 'backupPhone', label: 'Backup Phone', type: 'phone', required: false },
          ],
        },
      ],
      _demo: true,
    },
    {
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
      _demo: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Flatten the payload to a list of `{path, data}` planned writes. Pure.
// ---------------------------------------------------------------------------
export function planWritesForFamily(fam: DemoFamilyId): PlannedWrite[] {
  const p = buildSeedPayload(fam);
  const writes: PlannedWrite[] = [];
  writes.push({ path: `kinfolk/${p.kinfolk._id}`, data: p.kinfolk as unknown as Record<string, unknown> });
  for (const k of p.kin) writes.push({ path: `kin/${k._id}`, data: k as unknown as Record<string, unknown> });
  for (const s of p.sessions) writes.push({ path: `kin_care_sessions/${s._id}`, data: s as unknown as Record<string, unknown> });
  for (const r of p.reports) writes.push({ path: `kin_care_reports/${r._id}`, data: r as unknown as Record<string, unknown> });
  for (const f of p.the411) writes.push({ path: `the_411/${f._id}`, data: f as unknown as Record<string, unknown> });
  writes.push({ path: `dossiers/${p.dossier._id}`, data: p.dossier as unknown as Record<string, unknown> });

  // MyTribe-portal docs so booking / invoices / home screens render demo data.
  writes.push({ path: `families/${p.family._id}`, data: p.family as unknown as Record<string, unknown> });
  for (const b of p.bookings) {
    writes.push({ path: `families/${fam}/bookings/${b._id}`, data: b as unknown as Record<string, unknown> });
  }
  for (const inv of p.invoices) {
    // Known collection split: getMyInvoices reads the flat top-level collection,
    // while the family subcollection mirrors it for other consumers. Seed both.
    writes.push({ path: `invoices/${inv._id}`, data: inv as unknown as Record<string, unknown> });
    writes.push({ path: `families/${fam}/invoices/${inv._id}`, data: inv as unknown as Record<string, unknown> });
  }
  return writes;
}

// Global form-schema writes (not per-family). Seeded once.
export function planFormSchemaWrites(): PlannedWrite[] {
  return buildFormSchemas().map((s) => ({
    path: `formSchemas/${s._id}`,
    data: s as unknown as Record<string, unknown>,
  }));
}

// Optional tester-link write: clients/{uid}.kinfolkIds -> demo-family-001.
// Plain-array set merge (idempotent: re-running re-converges to the same value).
export function planLinkUidWrite(uid: string): PlannedWrite {
  return {
    path: `clients/${uid}`,
    data: { kinfolkIds: [DEMO_FAMILY_IDS[0]], _demo: true },
  };
}

export function planAllWrites(): PlannedWrite[] {
  return [
    ...DEMO_FAMILY_IDS.flatMap((fam) => planWritesForFamily(fam)),
    ...planFormSchemaWrites(),
  ];
}

// ---------------------------------------------------------------------------
// Placeholder-coverage assertion. Walks every string field on every planned
// write and confirms it's either a known structural value or carries a
// TODO/[placeholder] marker. Throws on any unmarked free-form copy.
// Exported for the vitest suite.
// ---------------------------------------------------------------------------
const STRUCTURAL_STRING_KEYS = new Set<string>([
  '_id',
  'kinfolkId',
  'kinId',
  'sessionId',
  'authorId',
  'status',
  'species',         // 'Dog' | 'Cat'
  'age',             // numeric-as-string
  'serviceType',     // 'visit_60' enum
  'sentVia',         // 'demo_seed' marker
  'email',           // tribetails.test reserved TLD — non-deliverable structural
  'phoneNumber',     // structural fake number
  'joinDate',
  'startTime',
  'endTime',
  'arrivedAt',
  'departedAt',
  'completedAt',
  'createdAt',
  'updatedAt',
  'visitDate',
  'sentAt',
  'lastUpdated',
  'lastReconciledAt',
  '_demoCreatedAt',
  'rawSummary',      // intentionally empty -> needsMoreSamples banner fires
]);

export function assertNoUserFacingCopy(writes: PlannedWrite[]): void {
  for (const w of writes) {
    // Demo docs carry explicit `_demo: true` flag — operator-visible UI
    // surfaces the "demo data" badge from that flag. Free-form mock copy
    // on demo docs is intentional per operator direction 2026-05-19.
    if (w.data._demo === true) continue;
    for (const [k, v] of Object.entries(w.data)) {
      if (typeof v !== 'string') continue;
      if (STRUCTURAL_STRING_KEYS.has(k)) continue;
      if (v.length === 0) continue;
      if (!PLACEHOLDER_RE.test(v)) {
        throw new Error(
          `assertNoUserFacingCopy: ${w.path}.${k} contains non-placeholder text: ${JSON.stringify(v)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Firestore write loop. Fail-loud — any error throws and aborts the run.
// ---------------------------------------------------------------------------
async function writeAll(db: admin.firestore.Firestore, writes: PlannedWrite[]): Promise<number> {
  let written = 0;
  for (const w of writes) {
    // merge:true preserves any non-seeded fields written by AuntieOS later
    // and keeps re-runs idempotent (deterministic id + same payload).
    await db.doc(w.path).set(w.data, { merge: true });
    console.log(`[seeded] ${w.path}`);
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const writes = planAllWrites();

  // Optional tester-link write rides the same plan + safety guards.
  if (args.linkUid) {
    writes.push(planLinkUidWrite(args.linkUid));
    console.log(`[plan] --link-uid: clients/${args.linkUid} -> kinfolkIds:[${DEMO_FAMILY_IDS[0]}]`);
  }

  // Belt-and-suspenders: refuse to ship if any string slipped through as
  // free-form copy. This must NEVER fail in CI — it would mean a developer
  // typed real text into the seed.
  assertNoUserFacingCopy(writes);

  console.log(`[plan] ${writes.length} writes across ${DEMO_FAMILY_IDS.length} demo families`);
  for (const w of writes) {
    const idSummary = (w.data as { _id?: string })._id ?? '(no _id)';
    console.log(`  [plan] ${w.path}  _id=${idSummary}`);
  }

  if (args.dryRun) {
    console.log(`\ndry-run complete — no Firestore writes. Use --allow-prod to commit.`);
    return;
  }

  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;

  if (!usingEmulator && !args.allowProd) {
    throw new Error(
      'seedDemoKinfolk: refusing to write — pass --allow-prod or set FIRESTORE_EMULATOR_HOST',
    );
  }

  const projectId =
    args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';

  // Service account or ADC. Fail loud if neither resolves.
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'seedDemoKinfolk: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator. Application Default Credentials may also work if `gcloud auth application-default login` was run, but this script refuses to silently fall back — set the env explicitly.',
    );
  }

  console.log(
    `\n[init] projectId=${projectId} emulator=${usingEmulator} allowProd=${args.allowProd}`,
  );

  admin.initializeApp({ projectId });
  const db = admin.firestore();

  const written = await writeAll(db, writes);
  console.log(`\nfinal: written=${written} (idempotent: merge:true on deterministic ids)`);
}

// Run main only when invoked directly. Importing for tests does not trigger writes.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
