import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

/**
 * Sentry is stubbed for the whole file so the guard's Sentry leg is
 * observable. `vi.hoisted` because `vi.mock` is lifted above every import: a
 * spy declared normally is still in its temporal dead zone when the factory's
 * closure is built, and the capture silently never registers.
 */
const { captureFunctionError } = vi.hoisted(() => ({
  captureFunctionError: vi.fn(() => 'sentry-1'),
}));
vi.mock('../src/lib/sentry', () => ({
  initSentry: vi.fn(),
  captureFunctionError,
  captureCritical: vi.fn(() => 'sentry-c'),
}));

/**
 * ADR-0001 step W3-1: the invoice money surface's RESPONSE schemas, exercised.
 *
 * `callableContract.test.ts` freezes the field SETS of these same schemas (a
 * rename fails there). This file is the other half: what each schema ACCEPTS
 * and what it REFUSES, so the guard is pinned to the meaning of the fields
 * rather than to their names. Every case below is one sentence about money:
 * a negative balance is the credit signal, a null price is not a free visit,
 * `''` is a standalone payment. Each is the kind of statement that
 * survives a rename and dies in a rewrite.
 *
 * The schemas are imported from the callables themselves, never re-declared
 * here: a test that carried its own copy of the shape would pass while the
 * deployed one drifted, which is the exact failure ADR-0001 exists to end.
 */
import { Result as CreateInvoiceResult } from '../src/admin/createInvoice';
import { Result as CreateQuoteResult } from '../src/admin/createQuote';
import { Result as UpdateInvoiceResult } from '../src/admin/updateInvoice';
import { Result as LinkInvoiceSessionsResult } from '../src/admin/linkInvoiceSessions';
import { Result as RecordPaymentResult } from '../src/admin/recordPayment';
import { Result as MarkInvoicePaidResult } from '../src/admin/markInvoicePaid';
import { Result as ArchiveInvoiceResult } from '../src/admin/archiveInvoice';
import { Result as UnarchiveInvoiceResult } from '../src/admin/unarchiveInvoice';
import { Result as PostInvoiceEventResult } from '../src/admin/postInvoiceEvent';
import { Result as ReviewAndSendDraftInvoiceResult } from '../src/admin/reviewAndSendDraftInvoice';
import { Result as SendInvoiceReminderResult } from '../src/admin/sendInvoiceReminder';
import { Result as GenerateReceiptResult } from '../src/admin/generateReceipt';
import { Result as RepairInvoicePaymentsResult } from '../src/admin/repairInvoicePayments';
import { Result as ListUninvoicedSessionsResult } from '../src/admin/listUninvoicedSessions';
import { Result as GenerateInvoicePdfResult } from '../src/admin/generateInvoicePdf';
import { Result as GetMyInvoicePdfResult } from '../src/portal/getMyInvoicePdf';
import { Result as GetMyInvoicesResult } from '../src/portal/getMyInvoices';
import { Result as PayInvoiceResult } from '../src/portal/payInvoice';
import { Result as RedeemCreditResult } from '../src/portal/redeemCredit';

/**
 * The money half of a `recordPayment` response, complete and believable.
 *
 * Spread into each case so a case can spoil ONE field and still be a real
 * payment in every other respect. Defaults are a plain $40 collection with no
 * tip, no fee and nothing applied, which is what the two pre-existing cases
 * below were before the fee tranche gave the response its money fields.
 */
function paymentMoney(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amountCents: 4000,
    tipCents: 0,
    feeCents: 0,
    tipBasis: 'gross',
    appliedCents: 0,
    unappliedCents: 4000,
    proceedsCents: 4000,
    tipNetCents: 0,
    autoApply: false,
    application: null,
    creditedToAccountCents: 0,
    confirmationEmailSent: false,
    ...over,
  };
}
/** A complete, believable invoice DTO. Cases below clone and spoil one field. */
function invoiceDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv1',
    kinfolkId: 'fam1',
    kinfolkName: 'The Kims',
    client: 'Ada Kim',
    total: 40,
    amountDue: 40,
    isPaid: false,
    status: 'open',
    editScope: 'all',
    paidCents: 0,
    partiallyPaid: false,
    date: '2026-07-01',
    dueDate: '2026-07-15',
    discount: null,
    terms: 'Net 14',
    paymentsHistory: null,
    address: '1 Main St',
    viewed: false,
    quoteDecision: null,
    quoteDecidedAtMs: null,
    creditAmountCents: null,
    creditTarget: null,
    creditRedeemedAtMs: null,
    ...over,
  };
}

function emptyBuckets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { open: [], paid: [], credits: [], accountBalanceCents: 0, ...over };
}

function repairFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invoiceId: 'inv1',
    invoiceNumber: 'INV-9',
    kinfolkId: 'fam1',
    totalCents: 4000,
    paidCents: 2000,
    claimedAmountDueCents: 0,
    correctAmountDueCents: 2000,
    understatedCents: 2000,
    status: 'paid',
    ...over,
  };
}

const FULL_SKIP_TALLY = {
  no_payments: 0,
  payments_cover_total: 0,
  no_total: 0,
  balance_already_correct: 0,
  would_lower_balance: 0,
};

function repairResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    mode: 'detect',
    scanned: 3,
    findings: [repairFinding()],
    repaired: 0,
    skipped: FULL_SKIP_TALLY,
    nextCursor: null,
    ...over,
  };
}

function uninvoicedResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: [
      {
        sessionId: 's1',
        kinfolkId: 'fam1',
        serviceType: 'Dog walking',
        durationMinutes: 30,
        startTime: '2026-07-01T14:00:00.000Z',
        unitCents: 2500,
      },
    ],
    unpriceable: [],
    unplaceable: [],
    rateCardLoaded: true,
    scanned: 1,
    truncated: false,
    ...over,
  };
}

/**
 * One passing shape and at least one refusal per schema. The refusals are
 * chosen for what they MEAN, not for coverage: each is a value some plausible
 * future edit would let through, and each would reach a household or an
 * operator as a wrong number rather than as an error.
 */
const CASES: Array<{
  name: string;
  schema: z.ZodType;
  accepts: Array<[string, unknown]>;
  refuses: Array<[string, unknown]>;
}> = [
  {
    name: 'createInvoice',
    schema: CreateInvoiceResult,
    accepts: [['the minted id', { ok: true, invoiceId: 'inv1' }]],
    refuses: [
      // `ok` is a literal, so there is exactly one success channel and
      // `HttpsError` is the only failure one.
      ['ok: false, which would be a second undocumented failure channel', { ok: false, invoiceId: 'inv1' }],
      ['an empty invoiceId, which no caller could load', { ok: true, invoiceId: '' }],
      ['a missing invoiceId', { ok: true }],
    ],
  },
  {
    name: 'createQuote',
    schema: CreateQuoteResult,
    accepts: [['the minted id', { ok: true, invoiceId: 'q1' }]],
    refuses: [['an empty invoiceId', { ok: true, invoiceId: '' }]],
  },
  {
    name: 'updateInvoice',
    schema: UpdateInvoiceResult,
    accepts: [
      [
        'a recomputed itemized invoice',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 10000, totalCents: 8500, paidCents: 0, amountDueCents: 8500 } },
      ],
      // THE SHAPE LIE W3-1 FOUND, pinned as a fact rather than fixed. `totals`
      // is the RAW signed arithmetic; the DOC is written from `settleInvoice`,
      // which clamps at 0 and moves the excess to `overpaidCents`. An edit that
      // cuts an invoice below what was collected answers negative here.
      [
        'a NEGATIVE amountDueCents on an over-collected edit (the doc stores 0 + overpaidCents)',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 2500, totalCents: 2500, paidCents: 6000, amountDueCents: -3500 } },
      ],
      // The un-itemized path: money deliberately not recomputed, so `totals`
      // is the zero-line computation and says nothing about the real invoice.
      [
        'the all-zero totals of an un-itemized metadata edit, with -paidCents due',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 0, totalCents: 0, paidCents: 3000, amountDueCents: -3000 } },
      ],
    ],
    refuses: [
      [
        'a fractional cent, which means a re-rounding crept in',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 10000, totalCents: 8500.5, paidCents: 0, amountDueCents: 8500 } },
      ],
      [
        'a NEGATIVE totalCents: the invoice-discount guard refuses one, so it cannot reach the wire',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 0, totalCents: -100, paidCents: 0, amountDueCents: -100 } },
      ],
      [
        'a totals block missing a figure',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 1, totalCents: 1, paidCents: 0 } },
      ],
      [
        'overpaidCents smuggled into totals, which would be a shape change',
        { ok: true, invoiceId: 'inv1', totals: { subtotalCents: 1, totalCents: 1, paidCents: 0, amountDueCents: 1, overpaidCents: 0 } },
      ],
    ],
  },
  {
    name: 'linkInvoiceSessions',
    schema: LinkInvoiceSessionsResult,
    accepts: [
      [
        'a link with a delta',
        { ok: true, invoiceId: 'inv1', sessionIds: ['s1', 's2'], added: ['s2'], removed: [], status: 'open', editScope: 'all' },
      ],
      [
        'the full unlink, which is an empty set and not a no-op',
        { ok: true, invoiceId: 'inv1', sessionIds: [], added: [], removed: ['s1'], status: 'paid', editScope: 'none' },
      ],
    ],
    refuses: [
      // The whole point of the stamp: the response ships the CLASSIFIED state,
      // never the doc's raw spelling. A client that saw 'QUOTE' here would need
      // the classifier this ADR-0002 work deleted.
      [
        "a raw stored spelling ('QUOTE') instead of the classified state",
        { ok: true, invoiceId: 'inv1', sessionIds: [], added: [], removed: [], status: 'QUOTE', editScope: 'all' },
      ],
      [
        'a ninth invoice state',
        { ok: true, invoiceId: 'inv1', sessionIds: [], added: [], removed: [], status: 'refunded', editScope: 'all' },
      ],
      [
        'a fourth editScope',
        { ok: true, invoiceId: 'inv1', sessionIds: [], added: [], removed: [], status: 'open', editScope: 'readOnly' },
      ],
      [
        'a null status, which linking always stamps',
        { ok: true, invoiceId: 'inv1', sessionIds: [], added: [], removed: [], status: null, editScope: 'all' },
      ],
    ],
  },
  {
    name: 'recordPayment',
    schema: RecordPaymentResult,
    accepts: [
      ['a household payment', { ok: true, paymentId: 'pay1', kinfolkId: 'fam1', ...paymentMoney() }],
      // `''` is the admin Payments tab's standalone row: a real payment that
      // belongs to no household. Refusing it here would report every one of
      // them as a server bug.
      [
        'an EMPTY kinfolkId, which is a standalone payment',
        { ok: true, paymentId: 'pay1', kinfolkId: '', ...paymentMoney() },
      ],
      // The whole point of the fee tranche: a $137.50 collection carrying a
      // $10.00 gross tip and a $2.71 processor fee, applied $127.50 to one
      // invoice. `amount = applied + tipGross + unapplied` closes at 137.50.
      [
        'invoice #1029, the row the dropped fee made unreadable',
        {
          ok: true,
          paymentId: 'pay1',
          kinfolkId: 'fam1',
          ...paymentMoney({
            amountCents: 13750,
            tipCents: 1000,
            feeCents: 271,
            appliedCents: 12750,
            unappliedCents: 0,
            proceedsCents: 13479,
            tipNetCents: 729,
            application: {
              invoiceId: 'inv1029',
              invoiceNumber: '1029',
              paymentId: 'sub1',
              appliedCents: 12750,
              state: 'settled',
              totalCents: 12750,
              paidCents: 12750,
              amountDueCents: 0,
              overpaidCents: 0,
            },
          }),
        },
      ],
      // The leftover routed into the EXISTING account-credit ledger, which is
      // what Auto-apply does: $300 collected, $180 applied, $120 held for a
      // future invoice. `creditedToAccountCents` is what was DONE with the
      // leftover; `unappliedCents` is what the leftover IS. Two facts.
      [
        'an auto-applied leftover held as account credit',
        {
          ok: true,
          paymentId: 'pay1',
          kinfolkId: 'fam1',
          ...paymentMoney({
            amountCents: 30000,
            appliedCents: 18000,
            unappliedCents: 12000,
            proceedsCents: 30000,
            autoApply: true,
            creditedToAccountCents: 12000,
          }),
        },
      ],
      // A NEGATIVE unapplied balance is accepted BY SCHEMA on purpose. The
      // callable refuses to create one, but a row written before the field
      // existed can carry it, and clamping it to 0 on the way out would hide
      // the one condition an operator has to see.
      [
        'an over-applied row, which the schema must be able to REPORT',
        { ok: true, paymentId: 'pay1', kinfolkId: 'fam1', ...paymentMoney({ unappliedCents: -500 }) },
      ],
    ],
    refuses: [
      [
        'a missing kinfolkId, which hides which household the row landed under',
        { ok: true, paymentId: 'pay1', ...paymentMoney() },
      ],
      ['an empty paymentId', { ok: true, paymentId: '', kinfolkId: 'fam1', ...paymentMoney() }],
      // `tipBasis` is the marker that says whether the tip beside it is gross
      // or net. A response that omits it puts the reader back where invoice
      // #1029 left them.
      [
        'a response with no tipBasis, which is the ambiguity this tranche exists to end',
        (() => {
          const { tipBasis: _dropped, ...rest } = paymentMoney();
          return { ok: true, paymentId: 'pay1', kinfolkId: 'fam1', ...rest };
        })(),
      ],
      [
        'a tipBasis outside the three-value vocabulary',
        { ok: true, paymentId: 'pay1', kinfolkId: 'fam1', ...paymentMoney({ tipBasis: 'net-ish' }) },
      ],
      // Cents are integers by construction everywhere on this surface. A float
      // means a re-rounding crept in.
      [
        'a fractional feeCents',
        { ok: true, paymentId: 'pay1', kinfolkId: 'fam1', ...paymentMoney({ feeCents: 271.4 }) },
      ],
    ],
  },
  {
    name: 'markInvoicePaid',
    schema: MarkInvoicePaidResult,
    accepts: [
      [
        'a settling payment',
        { ok: true, invoiceId: 'inv1', paymentId: 'p1', state: 'settled', totalCents: 4000, paidCents: 4000, amountDueCents: 0, overpaidCents: 0 },
      ],
      [
        'a partial, which leaves a real balance',
        { ok: true, invoiceId: 'inv1', paymentId: 'p1', state: 'partial', totalCents: 4000, paidCents: 2000, amountDueCents: 2000, overpaidCents: 0 },
      ],
      [
        'an overpayment: balance clamped at 0, excess reported',
        { ok: true, invoiceId: 'inv1', paymentId: 'p1', state: 'overpaid', totalCents: 4000, paidCents: 5000, amountDueCents: 0, overpaidCents: 1000 },
      ],
    ],
    refuses: [
      // A negative balance is this codebase's CREDIT signal. One leaking out of
      // here reads downstream as money owed BACK to the household.
      [
        'a NEGATIVE amountDueCents, which downstream reads as a credit',
        { ok: true, invoiceId: 'inv1', paymentId: 'p1', state: 'overpaid', totalCents: 4000, paidCents: 5000, amountDueCents: -1000, overpaidCents: 0 },
      ],
      [
        'a fifth settlement state',
        { ok: true, invoiceId: 'inv1', paymentId: 'p1', state: 'refunded', totalCents: 4000, paidCents: 4000, amountDueCents: 0, overpaidCents: 0 },
      ],
      [
        'dollars where cents belong',
        { ok: true, invoiceId: 'inv1', paymentId: 'p1', state: 'settled', totalCents: 40.5, paidCents: 40.5, amountDueCents: 0, overpaidCents: 0 },
      ],
    ],
  },
  {
    name: 'archiveInvoice',
    schema: ArchiveInvoiceResult,
    accepts: [['the archived id', { ok: true, invoiceId: 'inv1' }]],
    refuses: [['a forced flag echoed back, which is a shape change', { ok: true, invoiceId: 'inv1', forced: true }]],
  },
  {
    name: 'unarchiveInvoice',
    schema: UnarchiveInvoiceResult,
    accepts: [['the restored id', { ok: true, invoiceId: 'inv1' }]],
    refuses: [['a missing invoiceId', { ok: true }]],
  },
  {
    name: 'postInvoiceEvent',
    schema: PostInvoiceEventResult,
    accepts: [['the bare ack', { ok: true }]],
    refuses: [
      // This callable merges an arbitrary payload; it must not start echoing
      // the doc back, which would make the merge's result a client contract.
      ['an echoed invoiceId, which this callable deliberately does not ship', { ok: true, invoiceId: 'inv1' }],
      ['ok: false', { ok: false }],
    ],
  },
  {
    name: 'reviewAndSendDraftInvoice',
    schema: ReviewAndSendDraftInvoiceResult,
    accepts: [['the sent id', { ok: true, invoiceId: 'inv1' }]],
    refuses: [['ok: false', { ok: false, invoiceId: 'inv1' }]],
  },
  {
    name: 'sendInvoiceReminder',
    schema: SendInvoiceReminderResult,
    accepts: [['the reminded id', { ok: true, invoiceId: 'inv1' }]],
    refuses: [['an empty invoiceId', { ok: true, invoiceId: '' }]],
  },
  {
    name: 'generateReceipt',
    schema: GenerateReceiptResult,
    accepts: [['the bare ack', { ok: true }]],
    refuses: [['a receipt url, which this callable does not produce', { ok: true, receiptUrl: 'https://x.test/r.pdf' }]],
  },
  {
    name: 'repairInvoicePayments',
    schema: RepairInvoicePaymentsResult,
    accepts: [
      ['a detect pass with a finding', repairResult()],
      ['a repair pass', repairResult({ mode: 'repair', repaired: 1 })],
      ['a page with a cursor', repairResult({ nextCursor: 'inv9' })],
      // The claim is whatever the corrupt doc says, and a negative one is
      // exactly the kind of doc this pass exists to find.
      [
        'a NEGATIVE claimedAmountDueCents, which is a corrupt doc, not a bad response',
        repairResult({ findings: [repairFinding({ claimedAmountDueCents: -500, understatedCents: 2500 })] }),
      ],
    ],
    refuses: [
      // A partial tally cannot distinguish "no invoice hit this reason" from
      // "this reason was dropped from the report".
      ['a partial skip tally', repairResult({ skipped: { no_payments: 0 } })],
      ['a third mode', repairResult({ mode: 'fix' })],
      [
        'understatedCents of 0, which is not a finding',
        repairResult({ findings: [repairFinding({ understatedCents: 0 })] }),
      ],
      [
        'a finding whose invoiceNumber is absent rather than null',
        repairResult({ findings: [(({ invoiceNumber: _drop, ...rest }) => rest)(repairFinding())] }),
      ],
    ],
  },
  {
    name: 'listUninvoicedSessions',
    schema: ListUninvoicedSessionsResult,
    accepts: [
      ['a priced page', uninvoicedResult()],
      [
        'an unpriceable visit: NULL, plus its entry in unpriceable',
        uninvoicedResult({
          sessions: [
            {
              sessionId: 's1',
              kinfolkId: 'fam1',
              serviceType: 'Overnight',
              durationMinutes: 720,
              startTime: '2026-07-01T22:00:00.000Z',
              unitCents: null,
            },
          ],
          unpriceable: [{ sessionId: 's1', serviceType: 'Overnight' }],
        }),
      ],
      ['an empty window, honestly reported', uninvoicedResult({ sessions: [], scanned: 0 })],
      [
        'a billable visit no date window can reach, reported rather than dropped',
        uninvoicedResult({ unplaceable: [{ sessionId: 'vis_lost', kinfolkId: 'fam1' }] }),
      ],
    ],
    refuses: [
      // Absent would let a client read it as 0 and bill a household nothing
      // for real work. Null is a value someone has to handle.
      [
        'an ABSENT unitCents instead of an explicit null',
        uninvoicedResult({
          sessions: [
            { sessionId: 's1', kinfolkId: 'fam1', serviceType: 'Dog walking', durationMinutes: 30, startTime: '2026-07-01T14:00:00.000Z' },
          ],
        }),
      ],
      ['an `ok` field, which this pure read does not ship', uninvoicedResult({ ok: true })],
      [
        'a Timestamp-shaped startTime, which this collection never stores',
        uninvoicedResult({
          sessions: [
            { sessionId: 's1', kinfolkId: 'fam1', serviceType: 'Dog walking', durationMinutes: 30, startTime: { seconds: 1 }, unitCents: 2500 },
          ],
        }),
      ],
    ],
  },
  {
    name: 'generateInvoicePdf',
    schema: GenerateInvoicePdfResult,
    accepts: [['a stored pdf url', { ok: true, invoiceId: 'inv1', pdfUrl: 'https://storage.test/inv1.pdf?token=x' }]],
    refuses: [
      // An empty url reaches the operator as a Download button that opens
      // nothing, which is indistinguishable from a broken network.
      ['an EMPTY pdfUrl, which is a button that opens nothing', { ok: true, invoiceId: 'inv1', pdfUrl: '' }],
    ],
  },
  {
    name: 'getMyInvoicePdf',
    schema: GetMyInvoicePdfResult,
    accepts: [['a stored pdf url', { ok: true, invoiceId: 'inv1', pdfUrl: 'https://storage.test/inv1.pdf?token=x' }]],
    refuses: [['raw pdf bytes instead of a url', { ok: true, invoiceId: 'inv1', pdfUrl: 'https://x.test/a.pdf', bytes: 'JVBER' }]],
  },
  {
    name: 'getMyInvoices',
    schema: GetMyInvoicesResult,
    accepts: [
      ['a household with nothing outstanding', emptyBuckets()],
      ['an open invoice', emptyBuckets({ open: [invoiceDto()] })],
      // The fail-soft absent case every client already handles: a present
      // null, never an absent key.
      ['an invoice whose stamp carries NO editScope (a pre-backfill seed)', emptyBuckets({ open: [invoiceDto({ editScope: null })] })],
      [
        'a redeemed credit, with the whole credit block populated',
        emptyBuckets({
          credits: [
            invoiceDto({
              status: 'redeemed',
              amountDue: -25,
              total: -25,
              editScope: 'none',
              creditAmountCents: 2500,
              creditTarget: 'accountBalance',
              creditRedeemedAtMs: 1_780_000_000_000,
            }),
          ],
          accountBalanceCents: 2500,
        }),
      ],
      [
        'a part-paid invoice: still open, still payable, and honest about the money in',
        emptyBuckets({ open: [invoiceDto({ paidCents: 2000, partiallyPaid: true, amountDue: 20 })] }),
      ],
      [
        'stored line items, which win over the session fallback',
        emptyBuckets({
          open: [
            invoiceDto({
              lineItems: [
                { lineId: 'stored:0', source: 'stored', sessionId: '', label: 'Dog walking', dateIso: null, amountCents: 4000, qty: 2, unitCents: 2000 },
              ],
            }),
          ],
        }),
      ],
      [
        'a derived session line, which carries a date and no qty',
        emptyBuckets({
          open: [
            invoiceDto({
              lineItems: [
                { lineId: 'session:s1', source: 'session', sessionId: 's1', label: 'Overnight', dateIso: '2026-07-01T22:00:00.000Z', amountCents: null, qty: null, unitCents: null },
              ],
            }),
          ],
        }),
      ],
    ],
    refuses: [
      [
        'a ninth status, which no client has a branch for',
        emptyBuckets({ open: [invoiceDto({ status: 'refunded' })] }),
      ],
      [
        'a raw uppercase stored status, which the stamp canonicalizes',
        emptyBuckets({ open: [invoiceDto({ status: 'OPEN' })] }),
      ],
      // Nullable, not optional: an absent key would be a third state.
      [
        'an ABSENT editScope instead of an explicit null',
        emptyBuckets({ open: [(({ editScope: _drop, ...rest }) => rest)(invoiceDto())] }),
      ],
      [
        'a null lineItems, when absence is how "no lines" is expressed',
        emptyBuckets({ open: [invoiceDto({ lineItems: null })] }),
      ],
      [
        'a NEGATIVE paidCents, which is not a payment',
        emptyBuckets({ open: [invoiceDto({ paidCents: -100 })] }),
      ],
      [
        'a fractional paidCents, which means a float got treated as money',
        emptyBuckets({ open: [invoiceDto({ paidCents: 1999.5 })] }),
      ],
      [
        'a refund credit target, which does not exist: credits are not refundable',
        emptyBuckets({ credits: [invoiceDto({ status: 'credit', creditTarget: 'originalPaymentMethod' })] }),
      ],
      [
        'a fourth bucket',
        emptyBuckets({ cancelled: [] }),
      ],
      [
        'a line item with an unknown key',
        emptyBuckets({
          open: [
            invoiceDto({
              lineItems: [
                { lineId: 'stored:0', source: 'stored', sessionId: '', label: 'x', dateIso: null, amountCents: 1, qty: 1, unitCents: 1, taxCents: 0 },
              ],
            }),
          ],
        }),
      ],
    ],
  },
  {
    name: 'payInvoice',
    schema: PayInvoiceResult,
    accepts: [
      ['a checkout for the remaining balance', { checkoutUrl: 'https://checkout.stripe.test/c/1', sessionId: 'cs_1', amountCents: 2000, currency: 'usd' }],
    ],
    refuses: [
      // `session.url ?? ''` is what the handler writes, so the empty case is
      // reachable, and it reaches the household as a Pay button that opens
      // nothing.
      ['an EMPTY checkoutUrl, which is a Pay button that opens nothing', { checkoutUrl: '', sessionId: 'cs_1', amountCents: 2000, currency: 'usd' }],
      ['a charge of nothing, which the handler refuses before Stripe', { checkoutUrl: 'https://x.test/c', sessionId: 'cs_1', amountCents: 0, currency: 'usd' }],
      ['a negative charge', { checkoutUrl: 'https://x.test/c', sessionId: 'cs_1', amountCents: -100, currency: 'usd' }],
      ['dollars where cents belong', { checkoutUrl: 'https://x.test/c', sessionId: 'cs_1', amountCents: 20.5, currency: 'usd' }],
    ],
  },
  {
    name: 'redeemCredit',
    schema: RedeemCreditResult,
    accepts: [
      ['a redemption to account balance', { ok: true, redeemedAmountCents: 2500, target: 'accountBalance', newAccountBalanceCents: 2500 }],
      ['an unreadable balance, reported as null rather than guessed', { ok: true, redeemedAmountCents: 2500, target: 'accountBalance', newAccountBalanceCents: null }],
    ],
    refuses: [
      // The removed Stripe leg. A schema that said `string` here would invite
      // a client to render a refund that cannot happen.
      ['a refund target, which was removed: credits are NOT refundable', { ok: true, redeemedAmountCents: 2500, target: 'originalPaymentMethod', newAccountBalanceCents: 0 }],
      ['a refundId, which no longer exists', { ok: true, redeemedAmountCents: 2500, target: 'accountBalance', newAccountBalanceCents: 0, refundId: 're_1' }],
      ['a negative redemption', { ok: true, redeemedAmountCents: -2500, target: 'accountBalance', newAccountBalanceCents: 0 }],
    ],
  },
];

describe('ADR-0001 W3-1 invoice response schemas', () => {
  for (const { name, schema, accepts, refuses } of CASES) {
    for (const [label, value] of accepts) {
      it(`${name} ACCEPTS ${label}`, () => {
        const parsed = schema.safeParse(value);
        expect(
          parsed.success,
          parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
        ).toBe(true);
      });
    }
    for (const [label, value] of refuses) {
      it(`${name} REFUSES ${label}`, () => {
        expect(schema.safeParse(value).success).toBe(false);
      });
    }
  }

  // Uniform, so nobody has to remember it per schema: `.strict()` everywhere is
  // what makes these schemas a COMPLETE description, which ADR-0001 decision 2
  // needs. A permissive schema generates a client type that lies by omission.
  it('every invoice response schema refuses an unknown field', () => {
    for (const { name, schema, accepts } of CASES) {
      const [, good] = accepts[0]!;
      const spoiled = { ...(good as Record<string, unknown>), _injected: 'x' };
      expect(schema.safeParse(spoiled).success, `${name} must refuse an unknown field`).toBe(false);
    }
  });

  it('every invoice response schema refuses an empty object', () => {
    for (const { name, schema } of CASES) {
      expect(schema.safeParse({}).success, `${name} must refuse {}`).toBe(false);
    }
  });
});

/**
 * The shared guard itself (`lib/callableResponse.ts`).
 *
 * These four cases ARE the W3-1 failure-mode ruling, expressed as tests: a
 * response that fails its own schema is reported loudly and returned anyway,
 * because the money write it describes has already committed and every client
 * renders a thrown error as a retry affordance.
 */
describe('validateResponse (the W3-1 outbound guard)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captureFunctionError.mockClear();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  const Schema = z.object({ ok: z.literal(true), amountCents: z.number().int() }).strict();

  it('returns the value UNCHANGED on success, and does not substitute the parse result', async () => {
    const { validateResponse } = await import('../src/lib/callableResponse');
    const value = { ok: true as const, amountCents: 100 };
    expect(validateResponse('t', Schema, value)).toBe(value);
    expect(captureFunctionError).not.toHaveBeenCalled();
  });

  it('DOES NOT THROW on a violation: the money write has already committed', async () => {
    const { validateResponse } = await import('../src/lib/callableResponse');
    const bad = { ok: true as const, amountCents: 'lots' };
    expect(() => validateResponse('t', Schema, bad)).not.toThrow();
  });

  it('returns the ORIGINAL object on a violation, so no field is silently stripped', async () => {
    const { validateResponse } = await import('../src/lib/callableResponse');
    // A zod object STRIPS unknown keys. Returning the parse result would delete
    // `extra` from a live response the moment the schema fell behind.
    const bad = { ok: true as const, amountCents: 100, extra: 'still here' };
    const out = validateResponse('t', Schema, bad);
    expect(out).toBe(bad);
    expect(out.extra).toBe('still here');
  });

  it('reports the violation at error severity, to Sentry, with PATHS and NO values', async () => {
    const { validateResponse, RESPONSE_CONTRACT_EVENT, RESPONSE_CONTRACT_CODE } = await import(
      '../src/lib/callableResponse'
    );
    validateResponse('markInvoicePaid', Schema, { ok: true, amountCents: 'four thousand dollars' });

    expect(errorSpy).toHaveBeenCalled();
    const line = String(errorSpy.mock.calls[0]![0]);
    const logged = JSON.parse(line) as {
      severity: string;
      event: string;
      errorCode: string;
      extra: { violations: Array<{ path: string; code: string }>; issueCount: number };
    };
    expect(logged.severity).toBe('error');
    expect(logged.event).toBe(RESPONSE_CONTRACT_EVENT);
    expect(logged.errorCode).toBe(RESPONSE_CONTRACT_CODE);
    expect(logged.extra.violations.map((v) => v.path)).toEqual(['amountCents']);
    // Invoice responses carry household names and addresses. The report is
    // paths and issue codes; the offending VALUE never leaves the process.
    expect(line).not.toContain('four thousand dollars');
    expect(captureFunctionError).toHaveBeenCalledTimes(1);
  });

  it('caps the reported issues but still says how many there were', async () => {
    const { validateResponse, MAX_REPORTED_ISSUES } = await import('../src/lib/callableResponse');
    const Wide = z.object(
      Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, z.string()])),
    );
    validateResponse('t', Wide, {});
    const logged = JSON.parse(String(errorSpy.mock.calls[0]![0])) as {
      extra: { violations: unknown[]; issueCount: number };
    };
    expect(logged.extra.violations).toHaveLength(MAX_REPORTED_ISSUES);
    expect(logged.extra.issueCount).toBe(25);
  });

  it('survives its own reporting failing, because the write is already durable', async () => {
    const { validateResponse } = await import('../src/lib/callableResponse');
    captureFunctionError.mockImplementationOnce(() => {
      throw new Error('sentry transport down');
    });
    const bad = { ok: true as const, amountCents: 'lots' };
    expect(() => validateResponse('t', Schema, bad)).not.toThrow();
    expect(validateResponse('t', Schema, bad)).toBe(bad);
  });
});
