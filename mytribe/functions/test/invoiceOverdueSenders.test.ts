import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import type { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #871: EVERY INVOICE STATE AGAINST EVERY PATH THAT COULD CHASE A HOUSEHOLD.
 *
 *   overdue scan    invoiceOverdueCron's per-doc decision (the one overdue sender)
 *   reminder scan   invoiceRemindersCron's per-doc decision
 *   button          the sendInvoiceReminder callable
 *   trigger         onInvoicesWrite, which must never send invoice.overdue
 *
 * The dispatcher is mocked here so each row counts exactly what each path asked
 * to send. invoiceOverdueDispatcherGuard.test.ts runs the real dispatcher for
 * the exactly-once claims.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  enqueueDetailed: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: mocks.enqueueDetailed,
}));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

import {
  OVERDUE_DEDUPE_WINDOW_MS,
  overdueDedupeKey,
  processOverdueInvoice,
  processReminderInvoice,
} from '../src/scheduled/invoiceRemindersCron';
import { sendInvoiceReminderHandler } from '../src/admin/sendInvoiceReminder';
import { invoiceWriteNoticeKey, onInvoicesWriteHandler } from '../src/triggers/onInvoicesWrite';
import { INVOICE_STATES, invoiceStateOf } from '../src/lib/invoiceEditPolicy';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
/** The business's day for NOW (10:00 in Chicago). */
const TODAY = '2026-09-14';
const PAST_DUE = '2026-09-01';
const DUE_SOON = '2026-09-15';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.enqueueDetailed.mockReset().mockResolvedValue({ written: ['n1'], suppressed: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** One doc per classifier state, each with a positive balance wherever the state allows one. */
const STATE_FIXTURES: Record<string, Record<string, unknown>> = {
  quote: { status: 'quote', invoiceStatus: 'quote', amountDue: 40, total: 40 },
  draft: { status: 'draft', amountDue: 40, total: 40 },
  cancelled: { status: 'cancelled', amountDue: 40, total: 40 },
  credit: { status: 'credit', amountDue: 40, total: 40 },
  redeemed: { status: 'redeemed', amountDue: -25, total: -25, creditRedeemedAt: 'ts' },
  paid: { status: 'paid', amountDue: 0, total: 40 },
  zero: { status: 'open', amountDue: 0, total: 0 },
  open: { status: 'open', amountDue: 40, total: 40 },
};

interface Case {
  name: string;
  doc: Record<string, unknown>;
  payments?: Record<string, Record<string, unknown>>;
  chase: boolean;
}

const CASES: Case[] = [
  ...INVOICE_STATES.map((s) => ({ name: `state ${s}`, doc: STATE_FIXTURES[s]!, chase: s === 'open' })),
  { name: 'a declined quote', doc: { ...STATE_FIXTURES.quote, quoteDecision: 'denied' }, chase: false },
  {
    name: 'an accepted quote (re-stamped open)',
    doc: { status: 'open', invoiceStatus: 'open', quoteDecision: 'accepted', amountDue: 40, total: 40 },
    chase: true,
  },
  {
    name: 'an unanswered quote whose status alone was relabelled open',
    doc: { status: 'open', invoiceStatus: 'quote', amountDue: 40, total: 40 },
    chase: false,
  },
  { name: 'an archived open bill', doc: { ...STATE_FIXTURES.open, archivedAt: 'ts' }, chase: false },
  // #902 CHANGED THIS ROW. A migrated bill with a `total` and no `amountDue`
  // used to classify `paid`, and #871 refused to chase it unless its payment
  // rows proved a balance. The shared rule reads it as owing its total, so an
  // unpaid one is an open bill and the office may chase it. The two rows below
  // are unchanged: only the rows can say a legacy bill was already paid off.
  { name: 'a legacy total-only bill with no payment rows', doc: { status: 'sent', total: 40 }, chase: true },
  {
    name: 'a legacy total-only bill whose rows cover the total',
    doc: { status: 'sent', total: 40 },
    payments: { p1: { amountCents: 4000 } },
    chase: false,
  },
  {
    name: 'a legacy total-only bill whose rows prove a balance',
    doc: { status: 'sent', total: 40 },
    payments: { p1: { amountCents: 1500 } },
    chase: true,
  },
];

function seed(c: Case, dueDate: string) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9', dueDate, ...c.doc },
  };
  for (const [id, row] of Object.entries(c.payments ?? {})) docs[`invoices/inv1/payments/${id}`] = row;
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

async function snapOf(ctx: ReturnType<typeof seed>) {
  return (await ctx.db.collection('invoices').doc('inv1').get()) as never;
}

function sendsOf(key: string): number {
  return [...mocks.enqueue.mock.calls, ...mocks.enqueueDetailed.mock.calls].filter((c) => c[0]?.key === key).length;
}

function req(): CallableRequest<unknown> {
  return {
    data: { invoiceId: 'inv1' },
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('#871 state × sender: only an open bill is ever chased', () => {
  it('the eight state fixtures classify as their own state', () => {
    for (const s of INVOICE_STATES) expect(invoiceStateOf(STATE_FIXTURES[s]!)).toBe(s);
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it(`overdue scan ${c.chase ? 'sends one notice' : 'sends nothing and stamps nothing'}`, async () => {
        const ctx = seed(c, PAST_DUE);
        const sent = await processOverdueInvoice(await snapOf(ctx), NOW, TODAY);
        expect(sent).toBe(c.chase);
        expect(sendsOf('invoice.overdue')).toBe(c.chase ? 1 : 0);
        expect(ctx.writes.filter((w) => w.path === 'invoices/inv1')).toHaveLength(c.chase ? 1 : 0);
      });

      it(`reminder scan ${c.chase ? 'sends one reminder' : 'sends nothing'}`, async () => {
        const ctx = seed(c, DUE_SOON);
        const sent = await processReminderInvoice(await snapOf(ctx), NOW, TODAY);
        expect(sent).toBe(c.chase);
        expect(sendsOf('invoice.reminder')).toBe(c.chase ? 1 : 0);
      });

      it(`button ${c.chase ? 'sends' : 'is refused with failed-precondition and sends nothing'}`, async () => {
        seed(c, PAST_DUE);
        if (c.chase) {
          expect((await sendInvoiceReminderHandler(req())).sent).toBe(true);
          expect(sendsOf('invoice.reminder')).toBe(1);
        } else {
          await expect(sendInvoiceReminderHandler(req())).rejects.toMatchObject({
            code: 'failed-precondition',
            details: { code: 'invoice_not_remindable' },
          });
          expect(sendsOf('invoice.reminder')).toBe(0);
        }
      });

      it('trigger never sends invoice.overdue for it, created or edited, labelled past due or not', async () => {
        const open = STATE_FIXTURES.open!;
        const writes: Array<[Record<string, unknown> | undefined, Record<string, unknown>]> = [
          [undefined, c.doc],
          [open, c.doc],
          [c.doc, { ...c.doc, status: 'past_due' }],
          [c.doc, { ...c.doc, status: 'overdue' }],
          [undefined, { ...c.doc, status: 'Past Due' }],
        ];
        for (const [before, after] of writes) {
          expect(invoiceWriteNoticeKey(before, after)).not.toBe('invoice.overdue');
          await onInvoicesWriteHandler({
            params: { invoiceId: 'inv1' },
            data: { before: { data: () => before }, after: { data: () => ({ kinfolkId: 'fam1', ...after }) } },
          } as never);
        }
        expect(sendsOf('invoice.overdue')).toBe(0);
      });
    });
  }
});

describe('#871 the overdue notice itself', () => {
  it('carries a stable event id, a week of ledger look-back, the target, and the real due date', async () => {
    const ctx = seed(CASES.find((c) => c.name === 'state open')!, PAST_DUE);
    await processOverdueInvoice(await snapOf(ctx), NOW, TODAY);
    expect(mocks.enqueueDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDetailed.mock.calls[0][0]).toMatchObject({
      key: 'invoice.overdue',
      recipientUid: 'kin-uid-1',
      targetType: 'invoice',
      targetId: 'inv1',
      dedupeKey: 'invoice:inv1:overdue',
      dedupeWindowMs: OVERDUE_DEDUPE_WINDOW_MS,
      data: { kinfolkId: 'fam1', invoiceId: 'inv1', invoiceDueDate: PAST_DUE, daysPastDue: 13 },
    });
    expect(overdueDedupeKey('inv1')).toBe('invoice:inv1:overdue');
    expect(OVERDUE_DEDUPE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('due today is not overdue: nothing is sent on the due day', async () => {
    const ctx = seed(CASES.find((c) => c.name === 'state open')!, TODAY);
    expect(await processOverdueInvoice(await snapOf(ctx), NOW, TODAY)).toBe(false);
    expect(sendsOf('invoice.overdue')).toBe(0);
  });

  it('an invoice already stamped is never sent again', async () => {
    const ctx = seed({ name: 'stamped', doc: { ...STATE_FIXTURES.open, overdueNotifiedAtMs: NOW - 86_400_000 }, chase: true }, PAST_DUE);
    expect(await processOverdueInvoice(await snapOf(ctx), NOW, TODAY)).toBe(false);
    expect(sendsOf('invoice.overdue')).toBe(0);
  });

  it('the trigger and the cron together send exactly one overdue notice for one invoice', async () => {
    const open = { kinfolkId: 'fam1', dueDate: PAST_DUE, ...STATE_FIXTURES.open };
    const ctx = seed({ name: 'open', doc: open, chase: true }, PAST_DUE);
    // A write labels the bill past due (a hand edit or an import), twice over (redelivery).
    for (let i = 0; i < 2; i += 1) {
      await onInvoicesWriteHandler({
        params: { invoiceId: 'inv1' },
        data: { before: { data: () => open }, after: { data: () => ({ ...open, status: 'past_due' }) } },
      } as never);
    }
    // Then the daily run.
    await processOverdueInvoice(await snapOf(ctx), NOW, TODAY);
    expect(sendsOf('invoice.overdue')).toBe(1);
  });
});
