import baseSeed, { put, seedNow } from './seed';
import { VISUAL_NOW } from './visual/fixtures';

/**
 * One instant, named once. The browser freezes its clock at `VISUAL_NOW` and the
 * seed dates itself against the same value, so neither the npm script nor
 * anything else has to repeat the literal and get it subtly wrong. An explicit
 * `E2E_SEED_NOW` still wins, for the operator who wants to see what a different
 * "today" looks like before recording.
 */
process.env.E2E_SEED_NOW ??= VISUAL_NOW;

/**
 * globalSetup for the REACT VISUAL surface only (`VISUAL_CAPTURE=1`).
 *
 * It runs the ordinary e2e seed first and then adds rows, so there is one
 * account set, one wipe and one set of bookings across both harnesses. It does
 * NOT add to `seed.ts` itself: `bookings.spec.ts` asserts an exact row count on
 * `kin_care_sessions`, so extra visits there would turn a passing suite red for
 * a screenshot's benefit.
 *
 * EVERY DATE HERE IS DERIVED FROM `seedNow()`, which the visual run pins to
 * `VISUAL_NOW` through `E2E_SEED_NOW`. That is not tidiness. Most of these
 * screens filter on a rolling window that the BROWSER computes from its own
 * clock (`Invoices` defaults to the last 7 days, `KinTales` the same,
 * `Sessions` to −30/+15 days), so a row written against the wall clock and read
 * against a frozen clock drops out of view on some runs and not others. Pinned
 * on both sides, the window and the rows move together or not at all.
 *
 * WHAT IT DELIBERATELY DOES NOT SEED: the collections behind screens whose data
 * arrives through a CALLABLE (Templates, Form Schemas, most of Home, the Inbox
 * thread panel). The functions emulator is not running, so those screens
 * photograph their error state no matter what is in Firestore. That is still a
 * real screenshot of a real state, and it is stable, but nothing written here
 * would change it.
 */

/** `YYYY-MM-DD`, UTC, `days` from the pinned now. The shape the invoice date
 *  filter compares as a plain string. */
function dayIso(days: number): string {
  return new Date(seedNow() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Full ISO instant, `days` from the pinned now. */
function isoAt(days: number): string {
  return new Date(seedNow() + days * 86_400_000).toISOString();
}

/** A real `Date`, which `put`'s encoder turns into a Firestore Timestamp. */
function stampAt(days: number): Date {
  return new Date(seedNow() + days * 86_400_000);
}

export default async function seedForVisuals(): Promise<void> {
  await baseSeed();

  // ── kin (Directory's second stream, and CareFlagsWidget on Home) ───────────
  // Sorted by document id (`orderBy('__name__')`), so the ids fix the order.
  await put('kin', 'vis-kin-1', {
    kinfolkId: 'e2e-kf-1',
    name: 'Biscuit',
    species: 'Dog',
    breed: 'Border Collie',
    age: '4',
    sex: 'Female',
    status: 'active',
    reactive: false,
    feedingBrand: 'Wellness Core, half cup twice daily',
    updatedAt: stampAt(-6),
  });
  await put('kin', 'vis-kin-2', {
    kinfolkId: 'e2e-kf-2',
    name: 'Marbles',
    species: 'Cat',
    breed: 'British Shorthair',
    age: '9',
    sex: 'Male',
    status: 'active',
    reactive: true,
    medicationHealthNotes: 'Thyroid tablet with breakfast.',
    updatedAt: stampAt(-5),
  });

  // ── invoices ──────────────────────────────────────────────────────────────
  // `date` is a plain `YYYY-MM-DD` STRING and is both the sort key and the range
  // filter, so it has to sit inside the screen's default "Last 7 days" window or
  // the list is empty AND the `?invoiceId=` deep link reports that it missed
  // (Invoices.tsx resolves the id out of the rows it already paged, not by a
  // per-document read).
  await put('invoices', 'vis-invoice-001', {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Wanda Thorne',
    client: 'Wanda Thorne',
    invoiceNumber: 'AO-2026-0184',
    date: dayIso(-2),
    dueDate: dayIso(12),
    total: 240,
    amountDue: 240,
    status: 'open',
    editScope: 'all',
    sessionIds: ['e2e-sess-completed'],
    lineItems: [
      { description: 'Overnight stay', qty: 2, unitCents: 9000 },
      { description: 'Drop-in visit', qty: 3, unitCents: 2000 },
    ],
    createdAt: stampAt(-2),
  });
  await put('invoices', 'vis-invoice-002', {
    kinfolkId: 'e2e-kf-2',
    kinfolkName: 'Nora Halbrook',
    client: 'Nora Halbrook',
    invoiceNumber: 'AO-2026-0183',
    date: dayIso(-5),
    dueDate: dayIso(9),
    total: 85,
    amountDue: 0,
    status: 'paid',
    editScope: 'metadataOnly',
    sessionIds: [],
    lineItems: [{ description: 'Dog walk', qty: 5, unitCents: 1700 }],
    createdAt: stampAt(-5),
  });

  // ── kin_care_reports (KinTales list + the kintale-report detail) ───────────
  // `createdAt` is an ISO STRING here, not a Timestamp: the list filters it with
  // a string `>=` comparison, and a Timestamp would sort ahead of every string
  // and match nothing.
  await put('kin_care_reports', 'vis-kintale-001', {
    sessionId: 'e2e-sess-completed',
    kinfolkId: 'e2e-kf-2',
    kinfolkName: 'Nora Halbrook',
    authorDisplayName: 'Auntie',
    kinIds: ['vis-kin-2'],
    serviceType: 'Overnight stay',
    visitDate: dayIso(-4),
    title: 'Marbles held court from the windowsill',
    titleGeneratedByAi: false,
    bodyCopy:
      'Marbles supervised the whole evening from the sill and came down twice, ' +
      'once for the thyroid tablet and once to check the food bowl was still ' +
      'where he left it. Litter clean, water topped up, blinds left half open ' +
      'the way he likes them.',
    mediaFileIds: [],
    status: 'sent',
    sentVia: 'email',
    sentAt: isoAt(-4),
    createdAt: isoAt(-4),
  });
  await put('kin_care_reports', 'vis-kintale-002', {
    sessionId: 'e2e-sess-cancelled',
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Wanda Thorne',
    authorDisplayName: 'Auntie',
    kinIds: ['vis-kin-1'],
    serviceType: 'Drop-in visit',
    visitDate: dayIso(-1),
    title: 'Short walk, long puddle',
    titleGeneratedByAi: true,
    bodyCopy: 'Biscuit found the one puddle on the block and stood in it. Towelled off indoors.',
    mediaFileIds: [],
    status: 'draft',
    createdAt: isoAt(-1),
  });

  // ── activity_log ──────────────────────────────────────────────────────────
  // Sorted on `seq` (a NUMBER), not on `timestamp`. A row without a numeric
  // `seq` is excluded by Firestore and never appears.
  const activity: ReadonlyArray<[number, number, string, string, string]> = [
    [3, -1, 'UPDATE_SETTINGS', 'Business hours updated for Saturday.', 'SUCCESS'],
    [2, -2, 'CREATE_BOOKING', 'Overnight stay booked for Nora Halbrook.', 'SUCCESS'],
    [1, -3, 'LOGIN', 'Operator signed in from a new device.', 'SUCCESS'],
  ];
  for (const [seq, days, actionType, description, status] of activity) {
    await put('activity_log', `vis-activity-${seq}`, {
      seq,
      timestamp: isoAt(days),
      actionType,
      description,
      status,
      actorId: 'visual-operator',
    });
  }

  // ── notifications ─────────────────────────────────────────────────────────
  // `createdAt` IS a real Timestamp here (the feed calls `.toDate()` on it), the
  // opposite of `kin_care_reports` above. Omitting `readAt` is what makes a row
  // unread; omitting `archivedAt` is what keeps it in the feed.
  await put('notifications', 'vis-note-1', {
    key: 'kincare.booking.confirm',
    category: 'booking',
    title: 'Booking confirmed',
    description: 'Wanda Thorne confirmed the drop-in visit.',
    actorName: 'Wanda Thorne',
    status: 'dispatched',
    mode: 'trigger',
    channels: ['inApp', 'email'],
    targetType: 'booking',
    targetId: 'e2e-sess-scheduled',
    createdAt: stampAt(-0.5),
  });
  await put('notifications', 'vis-note-2', {
    key: 'invoice.issued',
    category: 'invoice',
    title: 'Invoice AO-2026-0184 issued',
    description: 'Sent to Wanda Thorne, due in twelve days.',
    actorName: 'Auntie',
    status: 'dispatched',
    mode: 'batched',
    channels: ['email'],
    targetType: 'invoice',
    targetId: 'vis-invoice-001',
    createdAt: stampAt(-2),
  });
  await put('notifications', 'vis-note-3', {
    key: 'kintale.sent',
    category: 'kintale',
    title: 'KinTale delivered',
    description: 'Marbles held court from the windowsill.',
    actorName: 'Auntie',
    status: 'dispatched',
    mode: 'trigger',
    channels: ['inApp'],
    targetType: 'kintale',
    targetId: 'vis-kintale-001',
    createdAt: stampAt(-4),
    readAt: stampAt(-3),
  });
}
