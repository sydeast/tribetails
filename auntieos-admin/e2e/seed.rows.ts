/**
 * The DENSE ROWS: the content that makes a list screen a list screen.
 *
 * WHY IT MOVED HERE. Every row below used to live in `seed.visual.ts`, the seed
 * for the removed screenshot-capture run. The ordinary `npm run e2e` database
 * therefore had two households and three visits and nothing else, so Invoices,
 * Activity Log, Notifications, KinTales and the Inbox channel lists all
 * rendered their EMPTY state to every spec in the suite. PR #209's phone-width
 * sweep hit exactly that wall: it could prove no screen's chrome overflowed at
 * 390px and could prove nothing at all about the row grids, because there were
 * no rows. An empty list cannot overflow.
 *
 * So `seed.ts` calls this and `seed.visual.ts` no longer adds anything: one
 * database, one set of rows, and the phone-width assertions in
 * `phone-layout.spec.ts` measure a real five-column invoice row rather than a
 * blank panel. The capture surface photographs the same content it always did.
 *
 * EVERY DATE IS DERIVED FROM `seedNow()`, never from `Date.now()` directly.
 * Most of these screens filter on a rolling window the BROWSER computes from
 * its own clock (Invoices and KinTales default to the last 7 days, Sessions to
 * -30/+15 days), and the visual run freezes both sides at `VISUAL_NOW`. A row
 * written against the wall clock and read against a frozen clock drops out of
 * view on some runs and not others.
 *
 * WHAT IS DELIBERATELY NOT HERE: the collections behind screens whose data
 * arrives through a CALLABLE (Templates, Form Schemas, most of Home, the Inbox
 * THREAD list and the conversation panel). The functions emulator is not
 * running, and the visual surface answers those callables with fixed route
 * stubs instead (`e2e/visual/callableStubs.ts`), so a document written here
 * would be read by nobody. The rule is about the READER, not about the
 * collection, and two things fall on the other side of it:
 *
 *   the Inbox CHANNEL lists, which `api/inboxChannels.ts` streams straight
 *   through `useCollection`, and
 *   `conversations`, which the nav rail's unread badge streams through
 *   `lib/useUnreadInbox.ts` on every screen even though the thread list itself
 *   is callable-backed. Those documents are seeded at the bottom of this file
 *   and have to say the same thing the stub says.
 */

/**
 * `seed.ts`'s writer, handed in rather than imported.
 *
 * `seed.ts` imports THIS module, so importing `put` back out of it would make a
 * cycle whose resolution depends on which bundler Playwright happens to compile
 * the globalSetup with. One parameter is cheaper than that dependency.
 */
type Put = (collection: string, id: string, doc: Record<string, unknown>) => Promise<void>;

export async function seedDenseRows(put: Put, now: number): Promise<void> {
  /** `YYYY-MM-DD`, UTC, `days` from the seed's now. The shape the invoice date
   *  filter compares as a plain string. */
  const dayIso = (days: number): string =>
    new Date(now + days * 86_400_000).toISOString().slice(0, 10);

  /** Full ISO instant, `days` from the seed's now. */
  const isoAt = (days: number): string => new Date(now + days * 86_400_000).toISOString();

  /** A real `Date`, which `put`'s encoder turns into a Firestore Timestamp. */
  const stampAt = (days: number): Date => new Date(now + days * 86_400_000);

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
  //
  // The names are LONG on purpose. A five-column row (`Invoices.css`) whose
  // household column holds "Wanda Thorne" fits at any width; the width question
  // is only asked by a name that does not. These are ordinary real-world
  // household names, not padding.
  // PARTIALLY PAID, and these are the same figures
  // `e2e/visual/callableStubs.ts` hands back from `getInvoiceLedger`: $240.00
  // billed, $60.00 collected, $180.00 still owed. The detail overlay prints
  // "Paid so far" and "Still owed" from THIS document, then prints "Collected"
  // and "Still owed" again a few rows lower from the callable. Two sources, one
  // screen, so they have to agree or the panel shows an invoice arguing with
  // itself.
  //
  // `editScope` is `metadataOnly` for the same reason: a payment exists, so the
  // server freezes the money and leaves the metadata open, and a fixture
  // claiming `all` would describe an invoice the server would refuse to edit
  // that way.
  await put('invoices', 'vis-invoice-001', {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Wanda Thorne',
    client: 'Wanda Thorne',
    invoiceNumber: 'AO-2026-0184',
    date: dayIso(-2),
    dueDate: dayIso(12),
    total: 240,
    amountDue: 180,
    paidCents: 6000,
    status: 'open',
    editScope: 'metadataOnly',
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
  await put('invoices', 'vis-invoice-003', {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Constance Fairweather-Okonkwo',
    client: 'Constance Fairweather-Okonkwo',
    invoiceNumber: 'AO-2026-0185',
    date: dayIso(-1),
    dueDate: dayIso(-1),
    total: 1284.5,
    amountDue: 1284.5,
    // `open` with a due date already past, NOT `overdue`. The eight states the
    // stamp may carry are listed in `api/invoices.ts` (`INVOICE_STATES`) and
    // overdue is not one of them; an unrecognized stamp fails soft to "no
    // stamp", which hides every money affordance including Edit. Overdue is
    // derived from `dueDate`, not stored.
    status: 'open',
    editScope: 'all',
    sessionIds: ['e2e-sess-scheduled', 'e2e-sess-completed'],
    lineItems: [
      { description: 'Overnight stay, extended', qty: 7, unitCents: 12000 },
      { description: 'Medication administration', qty: 14, unitCents: 1500 },
      { description: 'Transport to veterinary appointment', qty: 1, unitCents: 22450 },
    ],
    createdAt: stampAt(-1),
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
    [4, -1, 'CANCEL_BOOKING_SERIES', 'Cancelled the remaining four overnight stays for Constance Fairweather-Okonkwo after the household rescheduled.', 'FAILURE'],
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

  // ── inbox channels ────────────────────────────────────────────────────────
  // The one part of the Inbox that is NOT callable-backed. `timestamp` is an
  // ISO STRING in all four collections and is the order key; a Timestamp here
  // would sort after every string and the row would never appear
  // (`api/inboxChannels.ts` says so at length).
  await put('voicemails', 'vis-vm-1', {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Wanda Thorne',
    callerNumber: '+15125550188',
    transcript:
      'Hi, it is Wanda, just checking whether Biscuit needs to come in with her own bowl on Thursday. Give me a ring back when you get a moment.',
    durationSec: 34,
    replyStatus: 'unread',
    timestamp: isoAt(-0.2),
  });
  await put('calls_log', 'vis-call-1', {
    kinfolkId: 'e2e-kf-2',
    kinfolkName: 'Nora Halbrook',
    callerNumber: '+15125550142',
    direction: 'inbound',
    durationSec: 212,
    timestamp: isoAt(-0.6),
  });
  await put('sms_messages', 'vis-sms-1', {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Constance Fairweather-Okonkwo',
    fromNumber: '+15125550133',
    body: 'Running about twenty minutes late for the handover, the gate code still works though.',
    direction: 'inbound',
    timestamp: isoAt(-1.1),
  });
  await put('emails', 'vis-email-1', {
    kinfolkId: 'e2e-kf-2',
    kinfolkName: 'Nora Halbrook',
    fromAddress: 'nora@example.test',
    subject: 'Thyroid tablet timing for the week of the fourteenth',
    body: 'Could we move the tablet to breakfast rather than the evening while I am away?',
    direction: 'inbound',
    timestamp: isoAt(-1.4),
  });

  // ── conversations ─────────────────────────────────────────────────────────
  // The message THREADS arrive through `listConversations`, a callable, which
  // `e2e/visual/callableStubs.ts` answers. These documents
  // are here because the callable is not the only reader: `useUnreadInbox`
  // streams this collection on every screen to put the unread count on the nav
  // rail, and it does that with or without a functions emulator. The two must
  // therefore describe the same two threads and the same read state, or the
  // rail and the Inbox disagree on one screen that shows both.
  //
  // Both READ. An unread thread would be a fine state to seed, but the badge it
  // puts on the rail is on EVERY screen, so one thread's state would change what
  // every other spec sees.
  await put('conversations', 'e2e-kf-1', {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Wanda Thorne',
    unreadForAdmin: false,
    lastMessageAtMs: Date.parse(`${dayIso(0)}T09:12:00.000Z`),
    messageCount: 14,
  });
  await put('conversations', 'e2e-kf-2', {
    kinfolkId: 'e2e-kf-2',
    kinfolkName: 'Nora Halbrook',
    unreadForAdmin: false,
    lastMessageAtMs: Date.parse(`${dayIso(-1)}T17:40:00.000Z`),
    messageCount: 6,
  });
}
