import type { Page, Route } from '@playwright/test';
import type { GetInvoiceLedgerResult } from '../../src/contracts/invoiceContracts.generated';
import { VISUAL_NOW } from './fixtures';

/**
 * The callable answers the captured screens need, and nothing else.
 *
 * WHY THIS FILE EXISTS, and it is not a convenience. `src/lib/firebase.ts` pins
 * the Functions SDK at `127.0.0.1:5399` for every e2e run and nothing serves
 * that port, so a callable ALWAYS fails, identically and in a few milliseconds.
 * That is the right design and this file does not change it: it is what makes
 * reaching production structurally impossible and what turns a would-be flake
 * into a deterministic refusal. `lib/fns.ts` then names the refusal
 * (`CallableNotStubbedError`) and says what to do about it, in one sentence:
 * stub the callable in the spec with `page.route`.
 *
 * Nobody had. Nine of the nineteen captures were photographs of a red error
 * panel, and SEVEN OF THE APPROVED GOLDENS ALREADY WERE: Home, Inbox, Activity
 * Log, Template Bank, Template Assignments, Form Schemas and KinTale detail were
 * all recorded on 2026-08-01 with `…failed: internal` where their content should
 * be. The other two are newer. `invoice-detail`'s whole Payment History renders
 * as "Couldn't load this invoice's payments or visits", and KinTales' triage
 * section as "Couldn't load orphaned KinTales", because both panels landed after
 * that recording, so the drift read as design work and was one approve away from
 * being enshrined.
 *
 * That approve is the failure this file exists to prevent. A regression in the
 * payments table cannot show up in a picture that has no payments table in it.
 *
 * FOUR RULES HOLD EVERY FIXTURE BELOW, and each one is load-bearing:
 *
 *   1. DETERMINISTIC. Every value is a literal or is derived from `VISUAL_NOW`,
 *      the same instant the page's clock and the seed are pinned to. No
 *      `Date.now()`, no randomness, no ordering that depends on a map's
 *      iteration. A golden has to be byte-identical across runs.
 *   2. THE SHAPE IS THE SERVER'S. Every response matches the callable's own
 *      contract: `getInvoiceLedger` is typed against
 *      `contracts/invoiceContracts.generated.ts`, which is generated from the
 *      server zod schema, and the rest match the response types their `api/`
 *      module declares. A stub whose shape merely LOOKS plausible is worse than
 *      the error panel, because the client mis-renders it silently and the
 *      golden records the mis-render as correct.
 *   3. IT AGREES WITH THE DATABASE. Where a callable reports on something the
 *      seed also writes, the two say the same thing: the ledger's payments sum
 *      to the `paidCents` on `vis-invoice-001`, its one visit is the session
 *      that invoice claims, the chain verifier scans the four `activity_log`
 *      rows that exist, and the conversations are the two seeded households and
 *      are all read, because the nav rail's unread badge counts the
 *      `conversations` collection rather than this callable. A golden that
 *      contradicts itself on screen is a golden nobody can read.
 *   4. AN UNSTUBBED CALLABLE STILL FAILS LOUD. `route.fallback()` hands anything
 *      not named here back to the catch-all, which continues to the unserved
 *      port, so a screen that grows a new callable gets the same red panel and
 *      the same instruction rather than a fabricated empty response. That
 *      applies to an unknown ARGUMENT too: `getInvoiceLedger` for an invoice
 *      with no fixture falls through rather than inventing a zero ledger.
 */

const NOW_MS = Date.parse(VISUAL_NOW);
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD`, UTC, `days` from the frozen now. */
function dayIso(days: number): string {
  return new Date(NOW_MS + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A full ISO instant on the day `days` from the frozen now, at a FIXED wall
 * clock. The time is spelled out rather than carried over from `VISUAL_NOW` so
 * that a row's displayed clock is legible here and cannot drift if the frozen
 * instant is ever moved to another hour.
 */
function isoAt(days: number, hhmmss: string): string {
  return `${dayIso(days)}T${hhmmss}.000Z`;
}

/** Epoch milliseconds for the same fixed instant. */
function msAt(days: number, hhmmss: string): number {
  return Date.parse(isoAt(days, hhmmss));
}

/**
 * `getInvoiceLedger`, per invoice id, and ONLY for the invoice the harness
 * actually opens.
 *
 * Every figure here is checked against `seed.rows.ts`'s `vis-invoice-001`:
 * a $240.00 invoice with $60.00 collected and $180.00 still owed, so the two
 * payment rows below sum to the seeded `paidCents` and `amountDueCents` is the
 * seeded `amountDue`. The panel prints "Collected" and "Still owed" straight
 * from these, directly beneath the invoice's own "Paid so far" and "Still owed"
 * which come from Firestore, and the two pairs have to be the same numbers.
 *
 * The second payment carries no reference on purpose: a blank reference renders
 * as a styled "none" rather than an empty cell (`InvoiceLedger.tsx`), and that
 * branch is worth having in a golden.
 *
 * `ledgerPayments` is EMPTY, deliberately. The root ledger is real money that
 * the balance arithmetic never reads, and a fixture that put a row there would
 * either duplicate a payment already shown above it or trip the "the ledger
 * shows money this balance does not" warning. Photographing an anomaly banner
 * as the ordinary appearance of the screen is the same mistake as
 * photographing an error panel.
 *
 * The one session is `e2e-sess-completed`, which is the single id
 * `vis-invoice-001.sessionIds` names, with the service, status and dates that
 * session doc carries. It has no recorded length, which the panel says as "not
 * recorded" rather than "0 min". `linkedBack` is true because the seed now
 * writes `invoiceId` back onto that session; without it the panel would raise a
 * broken-link warning, correctly, and the golden would record a fixture defect.
 */
const INVOICE_LEDGERS: Readonly<Record<string, GetInvoiceLedgerResult>> = {
  'vis-invoice-001': {
    invoiceId: 'vis-invoice-001',
    payments: [
      {
        paymentId: 'vis-payment-001',
        amountCents: 4000,
        method: 'Check',
        reference: '2041',
        paidAt: isoAt(-3, '15:20:00'),
        recordedBy: 'e2e-admin',
        // Null is the honest value, not a placeholder. Both of these are
        // settlement rows with no root `payments` record behind them, which is
        // exactly what `markInvoicePaid` writes and what every row predating
        // the field carries. Fabricating an id would photograph a tip-and-fee
        // link this fixture does not have, and the golden would then assert a
        // screen that cannot occur.
        sourcePaymentId: null,
      },
      {
        paymentId: 'vis-payment-002',
        amountCents: 2000,
        method: 'Cash',
        reference: null,
        paidAt: isoAt(-1, '18:05:00'),
        recordedBy: 'e2e-admin',
        sourcePaymentId: null,
      },
    ],
    paidCents: 6000,
    totalCents: 24000,
    amountDueCents: 18000,
    ledgerPayments: [],
    // Empty for the same reason as `ledgerPayments` above, plus one of its own:
    // this list is household money NO invoice claims, and the React panel does
    // not render it at all. It exists so the staff Android screen can stop
    // reading the root `payments` collection directly, which is what kept the
    // 100x units defect alive there. A fixture row would photograph nothing.
    unlinkedKinfolkPayments: [],
    sessions: [
      {
        sessionId: 'e2e-sess-completed',
        serviceType: 'Overnight stay',
        status: 'completed',
        startTime: isoAt(-4, '12:00:00'),
        completedAt: isoAt(-4, '12:00:00'),
        durationMinutes: null,
        linkedBack: true,
      },
    ],
    missingSessionIds: [],
    orphanSessionIds: [],
    truncated: false,
    // Zero, because every fixture amount above is a real reading. A non-zero
    // count would photograph the could-not-be-read caveat as the ordinary
    // appearance of the ledger, which is the same mistake as photographing an
    // error panel.
    unresolvedAmountCount: 0,
  },
};

/**
 * The two seeded households as message threads, BOTH READ.
 *
 * Not a stylistic choice. `AppShell` streams the `conversations` COLLECTION
 * through `useUnreadInbox` for the nav rail's unread badge, on every screen,
 * and the seed writes those two documents with `unreadForAdmin: false`. A stub
 * claiming an unread thread would put "you have unread mail" in the widget on
 * Home and nothing on the rail beside it, in the same picture.
 */
const CONVERSATIONS = [
  {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: 'Wanda Thorne',
    lastMessagePreview: 'Thanks for squaring away the gate code, Thursday still works for us.',
    lastMessageAtMs: msAt(0, '09:12:00'),
    lastSenderRole: 'kinfolk',
    unreadForAdmin: false,
    messageCount: 14,
  },
  {
    kinfolkId: 'e2e-kf-2',
    kinfolkName: 'Nora Halbrook',
    lastMessagePreview: 'Moved the thyroid tablet to breakfast for the week you are away.',
    lastMessageAtMs: msAt(-1, '17:40:00'),
    lastSenderRole: 'auntie',
    unreadForAdmin: false,
    messageCount: 6,
  },
] as const;

/**
 * `listAllInvites`, the only read behind the Invites screen.
 *
 * SHAPE IS `AdminInviteDTO` FROM THE SERVER, field for field
 * (`mytribe/functions/src/admin/listAllInvites.ts`, whose rows are
 * `listInvites.ts#mapInviteDoc` plus one `householdName`). Nothing is trimmed
 * to what the screen happens to render: `proposedRole` and
 * `proposedPermissions` appear nowhere on this screen, and they are here
 * because the callable always sends them.
 *
 * THE HOUSEHOLDS ARE THE SEEDED ONES, and that is load-bearing rather than
 * decorative. Every card's heading is a `Link` to
 * `/household-members/$kinfolkId`, so a made-up `tribeId` would photograph a
 * row whose only control leads nowhere. `householdName` is what the server's
 * `householdNameFor` returns for those two `kinfolk` docs: Wanda Thorne gives
 * "the Thornes" and Nora Halbrook gives "the Halbrooks", sibilant rule
 * included.
 *
 * `effectiveStatus` AND `redeemable` ARE THE SERVER'S ANSWER, not the
 * document's. `mapInviteDoc` reconciles a lapsed PENDING/EMAIL_SENT to EXPIRED
 * at read time and sets `redeemable` only for the two live states, and the
 * screen files every row by `effectiveStatus` alone. The third row below is
 * exactly that case, written the way the server writes it: `status:
 * 'EMAIL_SENT'` with an `expiresAt` behind the frozen clock, so it reads
 * Expired. A fixture that quietly agreed the two fields would drop the one row
 * that proves the reconciliation reaches the picture.
 *
 * ONE ROW PER SECTION AND PER CHIP. `SECTION_ORDER` is Pending, Expired,
 * Accepted, Revoked and the four filter chips carry counts, so a fixture of
 * outstanding rows alone would photograph three empty sections and three
 * zeroes and prove nothing about any of them.
 *
 * NEWEST FIRST, already sorted the way `sortInvitesNewestFirst` sorts on the
 * server, because the screen renders the order it is handed.
 */
const ADMIN_INVITES = [
  {
    inviteId: 'vis-invite-pending-01',
    tribeId: 'e2e-kf-1',
    householdName: 'the Thornes',
    invitedEmail: 'rowan.thorne@example.test',
    secondaryLabel: 'Rowan (son)',
    proposedRole: 'SECONDARY',
    proposedPermissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: false,
      kintales_only: true,
      home_access: false,
    },
    status: 'EMAIL_SENT',
    effectiveStatus: 'EMAIL_SENT',
    redeemable: true,
    createdAt: isoAt(-2, '10:05:00'),
    sentToInviteeAt: isoAt(-2, '10:05:00'),
    expiresAt: isoAt(12, '10:05:00'),
    revokedAt: null,
    acceptedUid: null,
  },
  {
    inviteId: 'vis-invite-pending-02',
    tribeId: 'e2e-kf-2',
    householdName: 'the Halbrooks',
    invitedEmail: 'delia.halbrook@example.test',
    secondaryLabel: null,
    proposedRole: 'SECONDARY',
    proposedPermissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: false,
      kin_edit: false,
      kintales_only: true,
      home_access: false,
    },
    // Minted and not yet emailed, so `sentToInviteeAt` is null and the card
    // falls back to `createdAt` for its "Sent" line. That fallback is a branch
    // worth having in a golden.
    status: 'PENDING',
    effectiveStatus: 'PENDING',
    redeemable: true,
    createdAt: isoAt(-5, '16:30:00'),
    sentToInviteeAt: null,
    expiresAt: isoAt(9, '16:30:00'),
    revokedAt: null,
    acceptedUid: null,
  },
  {
    inviteId: 'vis-invite-expired-01',
    tribeId: 'e2e-kf-1',
    householdName: 'the Thornes',
    invitedEmail: 'marla.finch@example.test',
    secondaryLabel: 'Marla (neighbour)',
    proposedRole: 'SECONDARY',
    proposedPermissions: {
      billing_full: false,
      messaging_direct: false,
      messaging_group: false,
      kin_edit: false,
      kintales_only: true,
      home_access: true,
    },
    status: 'EMAIL_SENT',
    effectiveStatus: 'EXPIRED',
    redeemable: false,
    createdAt: isoAt(-40, '08:15:00'),
    sentToInviteeAt: isoAt(-40, '08:15:00'),
    expiresAt: isoAt(-26, '08:15:00'),
    revokedAt: null,
    acceptedUid: null,
  },
  {
    inviteId: 'vis-invite-accepted-01',
    tribeId: 'e2e-kf-2',
    householdName: 'the Halbrooks',
    invitedEmail: 'nora@example.test',
    secondaryLabel: null,
    proposedRole: 'PRIMARY',
    proposedPermissions: {
      billing_full: true,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: true,
      kintales_only: true,
      home_access: true,
    },
    status: 'ACCEPTED',
    effectiveStatus: 'ACCEPTED',
    redeemable: false,
    createdAt: isoAt(-64, '11:00:00'),
    sentToInviteeAt: isoAt(-64, '11:00:00'),
    expiresAt: isoAt(-50, '11:00:00'),
    revokedAt: null,
    // The uid the portal recorded on acceptance. Not rendered here; the server
    // sends it on every accepted invite.
    acceptedUid: 'vis-uid-halbrook-primary',
  },
  {
    inviteId: 'vis-invite-revoked-01',
    tribeId: 'e2e-kf-1',
    householdName: 'the Thornes',
    invitedEmail: 'old.address@example.test',
    secondaryLabel: 'Wrong address',
    proposedRole: 'SECONDARY',
    proposedPermissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: false,
      kin_edit: false,
      kintales_only: true,
      home_access: false,
    },
    status: 'REVOKED',
    effectiveStatus: 'REVOKED',
    redeemable: false,
    createdAt: isoAt(-71, '09:45:00'),
    sentToInviteeAt: isoAt(-71, '09:45:00'),
    expiresAt: isoAt(-57, '09:45:00'),
    revokedAt: isoAt(-70, '14:20:00'),
    acceptedUid: null,
  },
] as const;

/**
 * Every callable a captured screen invokes, and the answer it gets.
 *
 * A handler returns the callable's `data`, or `undefined` to decline, which
 * falls through to the unserved port and the app's own error panel.
 */
export type CallableHandler = (payload: Record<string, unknown>) => unknown;

const HANDLERS: Readonly<Record<string, CallableHandler>> = {
  // ── invoice detail ──────────────────────────────────────────────────────
  /**
   * Keyed on the id, and declining an id it has no fixture for. A default
   * "empty ledger" here would report every other invoice as having collected
   * nothing and billing no work, which is a claim about money, made up, and
   * indistinguishable on screen from the truth.
   */
  getInvoiceLedger: (payload) => INVOICE_LEDGERS[String(payload['invoiceId'])],

  // ── home + inbox ────────────────────────────────────────────────────────
  listConversations: () => ({ conversations: CONVERSATIONS }),

  // ── invites ─────────────────────────────────────────────────────────────
  /**
   * `scanned` and `households` are the server's own two counters and are sent
   * even though `src/api/members.ts` reads only `invites` today: a stub that
   * answers less than the callable does is a stub that stops matching it.
   * `scanned` is the row count before the sort, and `households` the distinct
   * `tribeId` count, which is 2 for the seeded pair.
   */
  listAllInvites: () => ({
    invites: ADMIN_INVITES,
    scanned: ADMIN_INVITES.length,
    households: new Set(ADMIN_INVITES.map((i) => i.tribeId)).size,
  }),

  /**
   * Home's expiration countdown, which keeps anything inside 60 days and sorts
   * by date. Three rows spread across that window so the "soon" styling (<= 7
   * days) and the plain rows are both in the picture.
   */
  listExpirations: () => ({
    expirations: [
      {
        _id: 'vis-exp-1',
        label: 'Biscuit rabies certificate',
        kind: 'vetRecord',
        dateIso: dayIso(6),
        kinfolkId: 'e2e-kf-1',
      },
      {
        _id: 'vis-exp-2',
        label: 'Thorne side gate code',
        kind: 'gateCode',
        dateIso: dayIso(23),
        kinfolkId: 'e2e-kf-1',
      },
      {
        _id: 'vis-exp-3',
        label: 'Business card on file',
        kind: 'card',
        dateIso: dayIso(48),
      },
    ],
  }),

  /**
   * The route for TODAY, which is the only date the widget asks for. One stop,
   * because `kin_care_sessions` holds exactly one visit dated today
   * (`e2e-sess-today`, Constance Fairweather-Okonkwo), and the stop names that
   * session and that household.
   */
  optimizeRoute: (payload) =>
    payload['date'] === dayIso(0)
      ? {
          stops: [
            {
              order: 1,
              sessionId: 'e2e-sess-today',
              kinfolkId: 'e2e-kf-1',
              household: 'Constance Fairweather-Okonkwo',
              address: '1804 Ravenswood Ln, Austin, TX',
              arrivalEta: '12:00',
            },
          ],
          totalMiles: 7.4,
          totalMinutes: 22,
          unroutable: [],
        }
      : undefined,

  listExpenses: () => ({
    expenses: [
      {
        _id: 'vis-expense-1',
        kind: 'gas',
        amountCents: 4215,
        note: 'Half tank before the overnight run',
        occurredAt: isoAt(-1, '08:30:00'),
      },
      {
        _id: 'vis-expense-2',
        kind: 'supplies',
        amountCents: 1899,
        note: 'Poop bags, two boxes',
        occurredAt: isoAt(-3, '16:05:00'),
      },
      {
        _id: 'vis-expense-3',
        kind: 'parking',
        amountCents: 600,
        note: '',
        occurredAt: isoAt(-5, '11:45:00'),
      },
    ],
    weekTotalCents: 6714,
    monthTotalCents: 21430,
  }),

  listSupplies: () => ({
    supplies: [
      { _id: 'vis-supply-1', name: 'Poop bags', onHand: 2, par: 8, unit: 'boxes' },
      { _id: 'vis-supply-2', name: 'Enzyme cleaner', onHand: 1, par: 3, unit: 'bottles' },
      { _id: 'vis-supply-3', name: 'Leash clips', onHand: 12, par: 6, unit: 'clips' },
    ],
    // The two rows above par-line, counted here rather than left for the client
    // to derive: the server sends this number and the widget prints it.
    lowCount: 2,
  }),

  // ── activity log ────────────────────────────────────────────────────────
  /**
   * `seed.rows.ts` writes exactly four chained `activity_log` rows, seq 1 to 4,
   * and no legacy unchained ones. The verdict says so.
   */
  verifyActivityLogChain: () => ({
    ok: true,
    scanned: 4,
    firstSeq: 1,
    lastSeq: 4,
    unchainedCount: 0,
  }),

  // ── kintales ────────────────────────────────────────────────────────────
  /**
   * Both seeded `kin_care_reports` name a `kinfolkId`, so neither is an orphan
   * and the triage section renders its empty state. `scanned` is the two rows
   * it looked at, which is what makes an empty answer mean "nothing to triage"
   * rather than "nothing was read".
   */
  listOrphanReports: () => ({ reports: [], scanned: 2 }),

  getKinTaleComments: (payload) =>
    payload['taleId'] === 'vis-kintale-001'
      ? {
          comments: [
            {
              id: 'vis-comment-1',
              authorRole: 'kinfolk',
              authorUid: 'e2e-kf-2',
              guestName: null,
              body: 'That windowsill is his whole personality. Thank you for the photo.',
              parentCommentId: null,
              createdAtMs: msAt(-4, '19:02:00'),
            },
            {
              id: 'vis-comment-2',
              authorRole: 'auntie',
              authorUid: 'e2e-admin',
              guestName: null,
              body: 'He supervised the litter change from up there too.',
              parentCommentId: 'vis-comment-1',
              createdAtMs: msAt(-4, '19:31:00'),
            },
          ],
        }
      : undefined,

  getKinTaleReaction: (payload) =>
    payload['taleId'] === 'vis-kintale-001' ? { loved: true, loveCount: 3 } : undefined,

  // ── templates ───────────────────────────────────────────────────────────
  /**
   * Three templates: two categorized and one untagged, so the Template Bank's
   * three stat cards (Templates, Categories, Untagged) each read a number that
   * these rows justify.
   *
   * `listTemplates` serves both the whole-collection read and the paged one
   * (`listTemplatesPage`), so the answer carries `nextCursor: null`: one page,
   * no "Load more".
   */
  listTemplates: () => ({
    templates: [
      {
        templateId: 'vis-tpl-booking-confirm',
        subject: 'Your booking is confirmed',
        body: 'Hi {{firstName}}, we have you down for {{serviceType}} on {{visitDate}}.',
        html: null,
        title: 'Booking confirmation',
        description: 'Sent when a booking request is accepted.',
        tags: ['booking', 'transactional'],
        category: 'Bookings',
        usageInstructions: 'Triggered by kincare.booking.confirm. Do not send by hand.',
        sectionDefinitions: [],
      },
      {
        templateId: 'vis-tpl-invoice-issued',
        subject: 'Invoice {{invoiceNumber}} from Tribe Tails',
        body: 'Hi {{firstName}}, your invoice for {{amountDue}} is ready.',
        html: null,
        title: 'Invoice issued',
        description: 'Sent when an invoice leaves draft.',
        tags: ['invoice'],
        category: 'Billing',
        usageInstructions: 'Triggered by invoice.issued.',
        sectionDefinitions: [],
      },
      {
        templateId: 'vis-tpl-welcome',
        subject: 'Welcome to the Den',
        body: 'Hi {{firstName}}, here is what happens next.',
        html: null,
        title: 'Household welcome',
        description: null,
        tags: [],
        category: null,
        usageInstructions: 'Sent by hand after the intake call.',
        sectionDefinitions: [],
      },
    ],
    nextCursor: null,
  }),

  listCategories: () => ({ categories: ['Billing', 'Bookings'], schemaVersion: 1 }),

  /**
   * One binding, naming a template the list above actually contains. A binding
   * pointing at a template id that is not in `listTemplates` renders as a
   * dangling row, which is a real state worth testing somewhere and a
   * misleading one to freeze as the expected picture.
   */
  listTemplateBindings: () => ({
    bindings: [
      {
        catalogKey: 'invoice.issued',
        templateId: 'vis-tpl-invoice-issued',
        audience: 'kinfolk',
        triggerKey: 'invoice.issued',
        active: true,
      },
    ],
  }),

  // ── form schemas ────────────────────────────────────────────────────────
  /**
   * Sorted newest-first by the screen itself, so the order here is not what
   * decides the picture; the dates are still fixed relative to the frozen now
   * so the rendered "updated" text cannot drift.
   */
  listFormSchemas: () => ({
    schemas: [
      {
        id: 'intake-household',
        name: 'Household intake',
        appliesTo: 'kinfolk',
        version: 4,
        updatedAt: isoAt(-2, '10:15:00'),
        updatedBy: 'e2e-admin',
      },
      {
        id: 'kin-profile',
        name: 'Kin profile',
        appliesTo: 'kin',
        version: 2,
        updatedAt: isoAt(-11, '14:40:00'),
        updatedBy: 'e2e-admin',
      },
      {
        id: 'meet-and-greet',
        name: 'Meet and greet checklist',
        appliesTo: 'booking',
        version: 1,
        updatedAt: null,
        updatedBy: null,
      },
    ],
  }),

  // ── feature flags ───────────────────────────────────────────────────────
  /**
   * NO OVERRIDES, which resolves every flag to its catalog default.
   *
   * This one is invisible and is stubbed anyway. `RecipientContextPanel` reads
   * the flags on Communicate and CATCHES a failure, leaving the comms recap
   * off, which is also the default. So the failing call changed no pixel and
   * the Communicate golden is not wrong today. It was still a callable failing
   * inside a golden capture, one catch block away from deciding what the screen
   * looks like, and "it happens to fail into the same state" is not a property
   * worth depending on.
   */
  getFeatureFlags: () => ({ flags: {} }),
};

/** The name at the end of `http://127.0.0.1:5399/<project>/<region>/<name>`. */
function callableName(url: string): string {
  const segments = new URL(url).pathname.split('/').filter((s) => s !== '');
  return segments[segments.length - 1] ?? '';
}

/**
 * The headers that make a fulfilled response acceptable to the browser.
 *
 * The page is served from `127.0.0.1:5174` and the callable port is
 * `127.0.0.1:5399`, so every one of these requests is CROSS-ORIGIN: a different
 * port is a different origin. Without these headers the browser discards the
 * stubbed response and the app sees the same transport failure it saw with no
 * stub at all, which would have made this whole file look like it did nothing.
 *
 * `*` rather than the page's origin, and no `allow-credentials`: the SDK sends
 * its ID token in an `Authorization` header and no cookies, so the wildcard is
 * both sufficient and the form that stays correct if the dev port moves.
 * `requested` echoes the preflight's `access-control-request-headers` so the
 * list cannot fall behind whatever the Firebase SDK decides to send.
 */
function corsHeaders(requested?: string): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers':
      requested !== undefined && requested !== ''
        ? requested
        : 'authorization, content-type, x-firebase-appcheck, x-firebase-client, x-firebase-gmpid',
    // Not cached. A preflight held over from one test into the next is one more
    // thing that could differ between the first capture and the eighteenth.
    'access-control-max-age': '0',
  };
}

/**
 * Installs the stubs on `page`.
 *
 * REGISTERED AFTER the catch-all abort in the capture spec, and that order is
 * the whole trick. Playwright checks route handlers in REVERSE registration
 * order, so this one is consulted first for the callable port and the catch-all
 * still owns every other request, including the non-local abort that keeps a
 * golden from being decided by anything off this machine. Nothing here loosens
 * it: `127.0.0.1:5399` is loopback, so both rules hold at once.
 *
 * `overrides` REPLACES a named handler for one spec, and is how a layout test
 * gets a screen state the goldens deliberately do not photograph. The fixtures
 * above are the APPROVED APPEARANCE of each screen and are chosen for that:
 * `getInvoiceLedger` sends no `ledgerPayments`, because a row there would trip
 * the "the ledger shows money this balance does not" banner and freeze an
 * anomaly as the ordinary picture. A phone-layout test needs the opposite, the
 * widest state the panel can reach, and it must be able to ask for it without
 * moving a single golden. Omitting it changes nothing, so `visual.capture.spec`
 * keeps the exact fixtures it had.
 */
export async function installCallableStubs(
  page: Page,
  overrides: Readonly<Record<string, CallableHandler>> = {},
): Promise<void> {
  const handlers: Readonly<Record<string, CallableHandler>> = { ...HANDLERS, ...overrides };
  await page.route(`**/127.0.0.1:5399/**`, async (route: Route) => {
    const request = route.request();

    // The SDK's POST is `content-type: application/json`, which is not a simple
    // cross-origin request (the page is :5174, the callable port is :5399), so
    // the browser sends a preflight first. Answered here rather than left to
    // Playwright, so the stub works the same whichever way a future version
    // decides to treat an intercepted OPTIONS.
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: corsHeaders(request.headers()['access-control-request-headers']),
      });
      return;
    }

    const name = callableName(request.url());
    const handler = handlers[name];
    if (handler === undefined) {
      await route.fallback();
      return;
    }

    let payload: Record<string, unknown> = {};
    try {
      const body = request.postDataJSON() as { data?: unknown } | null;
      if (body !== null && typeof body === 'object' && typeof body.data === 'object') {
        payload = (body.data ?? {}) as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }

    const result = handler(payload);
    if (result === undefined) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      // The callable protocol's envelope: the SDK unwraps `result` and hands
      // `data` to the caller. A bare object here resolves as `undefined`.
      body: JSON.stringify({ result }),
    });
  });
}
