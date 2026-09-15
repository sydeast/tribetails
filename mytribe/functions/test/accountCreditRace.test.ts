import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), delivered: new Set<string>() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: async () => 'kin-uid-1' }));
// #884: a dispatcher double that keeps the ledger's rule for these notices: one
// delivery per (key, invoice, payment row), however many sends race.
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotificationDetailed: async (args: { key: string; targetId?: string; data?: Record<string, unknown> }) => {
    const identity = `${args.key}|${args.targetId}|${String(args.data?.['paymentId'])}`;
    if (mocks.delivered.has(identity)) return { written: [], suppressed: [{ reason: 'duplicate' }], unresolved: [] };
    mocks.delivered.add(identity);
    return { written: ['n1'], suppressed: [], unresolved: [] };
  },
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import { balanceAfterDraw, drawAccountCredit } from '../src/lib/accountCredit';
import { onInvoiceAutoApplyHandler } from '../src/triggers/onInvoiceAutoApply';

beforeEach(() => mocks.dbFn.mockReset());

/**
 * TWO AUTO-APPLY PASSES IN FLIGHT AT ONCE (#830).
 *
 * The defect these cover is not a replay and no idempotency key closes it. The
 * operator's `runAutoApply` callable and the `onInvoiceAutoApply` trigger are
 * two independent callers of the same pass, so an operator pressing the button
 * while the trigger is mid-flight is two DIFFERENT calls reading the same held
 * credit — and before the fix both planned a draw from it and both committed
 * one, leaving the household's balance negative and their bill over-collected.
 *
 * ── WHY THESE TESTS BUILD THEIR OWN FIRESTORE DOUBLE ──────────────────────
 *
 * `buildDbMock`'s transaction shim runs the callback against a STATIC fixture
 * and never commits anything back, so under it a second pass reads the world as
 * though the first had never run and every one of these tests would pass no
 * matter what the code did. The double below is a live store instead:
 *
 *   - `runTransaction` SERIALISES (one transaction at a time, arrival order)
 *     and stages its writes, applying them only if the callback returns. That
 *     is the outcome Firestore's locking-plus-retry produces for two passes
 *     contending on `families/{id}` and `invoices/{id}`: the second one runs
 *     against what the first committed, and an aborted transaction writes
 *     nothing.
 *   - plain `.get()` and `batch().commit()` are NOT serialised, because they
 *     are not transactional in Firestore either. That is what lets the
 *     pre-#830 code interleave here exactly as it did in production, so
 *     reverting the fix fails these tests on the money rather than on a
 *     missing method.
 *   - `FieldValue.increment(n)` is applied to the stored number, so a draw
 *     written as an increment really does drive a balance below zero here.
 */

type Doc = Record<string, unknown>;

function buildRacingDb(seedDocs: Record<string, Doc>) {
  const store: Record<string, Doc> = {};
  for (const [path, data] of Object.entries(seedDocs)) store[path] = { ...data };
  /** Every write AS ASKED FOR, before the store resolves any FieldValue. */
  const writes: Array<{ path: string; data: Doc; merge: boolean }> = [];
  let autoId = 0;
  let txTail: Promise<unknown> = Promise.resolve();

  /** Resolves the FieldValue sentinels this suite's mock produces. */
  function resolveWrite(path: string, data: Doc): Doc {
    const out: Doc = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === 'object' && '__increment' in (v as Doc)) {
        const by = Number((v as { __increment: number }).__increment);
        const prev = store[path]?.[k];
        out[k] = (typeof prev === 'number' ? prev : 0) + by;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function commitWrite(path: string, data: Doc, merge: boolean): void {
    writes.push({ path, data, merge });
    const resolved = resolveWrite(path, data);
    store[path] = merge ? { ...(store[path] ?? {}), ...resolved } : resolved;
  }

  function makeDocRef(path: string): any {
    return {
      id: path.split('/').pop(),
      path,
      // Not serialised against anything: a plain read is a plain read.
      get: async () => {
        await Promise.resolve();
        const data = store[path];
        return { exists: data != null, data: () => data, id: path.split('/').pop() };
      },
      set: async (data: Doc, options?: { merge?: boolean }) => {
        commitWrite(path, data, options?.merge === true);
      },
      collection: (sub: string) => makeCollection(`${path}/${sub}`),
    };
  }

  function makeCollection(path: string): any {
    return {
      path,
      doc: (id?: string) => {
        if (id === undefined) {
          autoId += 1;
          return makeDocRef(`${path}/auto-${autoId}`);
        }
        return makeDocRef(`${path}/${id}`);
      },
      // A live prefix scan, so a pass DOES see the payment row a pass before it
      // wrote. A static fixture here would hide the whole defect.
      get: async () => {
        await Promise.resolve();
        const rows = Object.entries(store)
          .filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1)
          .map(([p, data]) => ({ id: p.split('/').pop(), exists: true, data: () => data }));
        return { docs: rows, size: rows.length, empty: rows.length === 0 };
      },
    };
  }

  const db: any = {
    collection: (path: string) => makeCollection(path),
    doc: (path: string) => makeDocRef(path),
    batch: () => {
      const staged: Array<{ path: string; data: Doc; merge: boolean }> = [];
      return {
        set: (ref: any, data: Doc, options?: { merge?: boolean }) =>
          staged.push({ path: ref.path, data, merge: options?.merge === true }),
        update: (ref: any, data: Doc) => staged.push({ path: ref.path, data, merge: true }),
        delete: () => {},
        commit: async () => {
          await Promise.resolve();
          for (const w of staged) commitWrite(w.path, w.data, w.merge);
        },
      };
    },
    runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const prev = txTail;
      let release: () => void = () => {};
      txTail = new Promise<void>((r) => {
        release = r;
      });
      await prev.catch(() => {});
      try {
        const staged: Array<{ path: string; data: Doc; merge: boolean }> = [];
        const tx = {
          get: async (ref: any) => ref.get(),
          set: (ref: any, data: Doc, options?: { merge?: boolean }) =>
            staged.push({ path: ref.path, data, merge: options?.merge === true }),
          update: (ref: any, data: Doc) => staged.push({ path: ref.path, data, merge: true }),
          delete: () => {},
          create: (ref: any, data: Doc) => staged.push({ path: ref.path, data, merge: false }),
        };
        // A throw from here reaches the caller with `staged` never applied,
        // which is what "the transaction aborts and writes nothing" means.
        const out = await fn(tx);
        for (const w of staged) commitWrite(w.path, w.data, w.merge);
        return out;
      } finally {
        release();
      }
    },
  };

  return { db, store, writes };
}

/** Every credit-funded payment row under an invoice, in write order. */
function creditRows(store: Record<string, Doc>, invoiceId: string): Doc[] {
  return Object.entries(store)
    .filter(([p, d]) => p.startsWith(`invoices/${invoiceId}/payments/`) && d.fromAccountCredit === true)
    .map(([, d]) => d);
}

function balanceOf(store: Record<string, Doc>, familyId: string): unknown {
  return store[`families/${familyId}`]?.accountBalanceCents;
}

describe('drawAccountCredit: two passes in flight over ONE invoice', () => {
  it('draws the credit ONCE, so the trigger racing the callable cannot over-collect', async () => {
    // The exact shape of the report: an invoice owing $127.50, a household
    // holding $120, and both callers looking at it in the same moment.
    const { db, store } = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);

    const [a, b] = await Promise.all([
      drawAccountCredit(db, { invoiceId: 'inv1', actorUid: 'admin1' }),
      drawAccountCredit(db, { invoiceId: 'inv1', actorUid: 'system:auto-apply' }),
    ]);

    // ONE draw of $120 between them, not two. Which pass won does not matter.
    expect(a.appliedCents + b.appliedCents).toBe(12000);
    expect([a.appliedCents, b.appliedCents].filter((c) => c > 0)).toHaveLength(1);
    expect(creditRows(store, 'inv1')).toHaveLength(1);

    // THE MONEY: the household's balance is spent exactly once and is not a debt.
    expect(balanceOf(store, 'fam1')).toBe(0);

    // The bill is credited with $120, not $240: still $7.50 owed, still open.
    expect(store['invoices/inv1']?.paidCents).toBe(12000);
    expect(store['invoices/inv1']?.amountDueCents).toBe(750);
    expect(store['invoices/inv1']?.status).toBe('open');

    // The loser reports a normal outcome, not an error: there was nothing left.
    const loser = a.appliedCents === 0 ? a : b;
    expect(loser.skipped).toBe('no_credit');
  });

  it('draws once when the credit COVERS the bill, and the loser reports the settled invoice', async () => {
    const { db, store } = buildRacingDb({
      'invoices/inv2': { kinfolkId: 'fam1', status: 'open', total: 50 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);

    const [a, b] = await Promise.all([
      drawAccountCredit(db, { invoiceId: 'inv2', actorUid: 'admin1' }),
      drawAccountCredit(db, { invoiceId: 'inv2', actorUid: 'system:auto-apply' }),
    ]);

    expect(a.appliedCents + b.appliedCents).toBe(5000);
    expect(creditRows(store, 'inv2')).toHaveLength(1);
    // $70 stays on account for the invoice after this one — it was never spent.
    expect(balanceOf(store, 'fam1')).toBe(7000);
    expect(store['invoices/inv2']?.status).toBe('paid');
    expect(store['invoices/inv2']?.overpaidCents).toBe(0);

    const loser = a.appliedCents === 0 ? a : b;
    expect(loser.skipped).toBe('invoice_not_collectable');
  });
});

describe('drawAccountCredit: two passes that settle ONE invoice tell the household once (#884)', () => {
  it('the winner sends the notice, and the loser finding the bill paid adds no second copy', async () => {
    mocks.delivered.clear();
    const { db, store } = buildRacingDb({
      'invoices/inv2': { kinfolkId: 'fam1', status: 'open', total: 50 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);

    const [a, b] = await Promise.all([
      drawAccountCredit(db, { invoiceId: 'inv2', actorUid: 'admin1' }),
      drawAccountCredit(db, { invoiceId: 'inv2', actorUid: 'system:auto-apply' }),
    ]);

    expect(a.appliedCents + b.appliedCents).toBe(5000);
    expect(creditRows(store, 'inv2')).toHaveLength(1);
    expect(mocks.delivered.size).toBe(1);
    expect(store['invoices/inv2']?.paymentAppliedNoticePending).toBe('');
  });
});

describe('drawAccountCredit: two invoices racing over ONE balance', () => {
  /**
   * The case a same-invoice test cannot reach. Both passes are legitimate and
   * both must draw — what must not happen is each of them drawing the whole
   * balance. The serialisation point is `families/{id}`, and this is the test
   * that proves it is one, because the invoice documents are different.
   */
  async function raceTwoInvoices(order: 'a-then-b' | 'b-then-a') {
    const { db, store } = buildRacingDb({
      'invoices/invA': { kinfolkId: 'fam1', status: 'open', total: 80 },
      'invoices/invB': { kinfolkId: 'fam1', status: 'open', total: 80 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);

    const drawA = () => drawAccountCredit(db, { invoiceId: 'invA', actorUid: 'admin1' });
    const drawB = () => drawAccountCredit(db, { invoiceId: 'invB', actorUid: 'system:auto-apply' });
    const [first, second] =
      order === 'a-then-b' ? await Promise.all([drawA(), drawB()]) : await Promise.all([drawB(), drawA()]);
    return { first, second, store };
  }

  for (const order of ['a-then-b', 'b-then-a'] as const) {
    it(`shares the balance instead of spending it twice (${order})`, async () => {
      const { first, second, store } = await raceTwoInvoices(order);

      // $120 held, $80 + $80 owed: the two draws add up to the balance and stop.
      expect(first.appliedCents + second.appliedCents).toBe(12000);
      expect([first.appliedCents, second.appliedCents].sort((x, y) => x - y)).toEqual([4000, 8000]);
      expect(balanceOf(store, 'fam1')).toBe(0);

      // Each invoice took exactly one credit row, worth what its pass reported.
      expect(creditRows(store, 'invA')).toHaveLength(1);
      expect(creditRows(store, 'invB')).toHaveLength(1);
      const paid = [store['invoices/invA']?.paidCents, store['invoices/invB']?.paidCents];
      expect(paid.sort((x: any, y: any) => x - y)).toEqual([4000, 8000]);
    });
  }
});

describe('the balance can never be written negative', () => {
  it('balanceAfterDraw returns the remainder, and REFUSES to return a debt', () => {
    expect(balanceAfterDraw(12000, 5000)).toBe(7000);
    expect(balanceAfterDraw(12000, 12000)).toBe(0);
    // The guard that has to exist at the write rather than only in the plan.
    expect(() => balanceAfterDraw(5000, 12000)).toThrow(/overdraw/);
  });

  it('writes an ABSOLUTE balance, never an increment that cannot be bounded', async () => {
    const { db, store, writes } = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);

    await drawAccountCredit(db, { invoiceId: 'inv1', actorUid: 'admin1' });

    // THE WRITE ITSELF, as asked for. An `increment(-draw)` applies whatever it
    // lands on, so the only figure that can be refused for being negative is an
    // absolute one — asserting on the resolved store would not tell them apart.
    const famWrite = writes.find((w) => w.path === 'families/fam1');
    expect(typeof famWrite?.data.accountBalanceCents).toBe('number');
    expect(famWrite?.data.accountBalanceCents).toBe(0);

    const stored = balanceOf(store, 'fam1');
    expect(stored).toBe(0);
    expect(stored as number).toBeGreaterThanOrEqual(0);
  });

  it('survives a burst of five overlapping passes on one household without going negative', async () => {
    // Five invoices of $50, $120 held. Three can be covered and a fourth part
    // paid; nothing may push the balance below zero, whatever the interleaving.
    const seedDocs: Record<string, Doc> = { 'families/fam1': { accountBalanceCents: 12000 } };
    for (let i = 1; i <= 5; i += 1) {
      seedDocs[`invoices/inv${i}`] = { kinfolkId: 'fam1', status: 'open', total: 50 };
    }
    const { db, store } = buildRacingDb(seedDocs);
    mocks.dbFn.mockReturnValue(db);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => drawAccountCredit(db, { invoiceId: `inv${i}`, actorUid: 'admin1' })),
    );

    const drawn = results.reduce((sum, r) => sum + r.appliedCents, 0);
    expect(drawn).toBe(12000);
    expect(balanceOf(store, 'fam1')).toBe(0);
    // Every invoice was credited with exactly what its pass reported, so the
    // money on the bills equals the money that left the account.
    const onBills = [1, 2, 3, 4, 5].reduce(
      (sum, i) => sum + Number(store[`invoices/inv${i}`]?.paidCents ?? 0),
      0,
    );
    expect(onBills).toBe(12000);
  });

  it('treats an ALREADY negative stored balance as no credit, and writes nothing', async () => {
    // Defensive: whatever put a debt there, a pass must not draw against it and
    // must not "fix" it by writing money the household never had.
    const { db, store } = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: -500 },
    });
    mocks.dbFn.mockReturnValue(db);

    const res = await drawAccountCredit(db, { invoiceId: 'inv1', actorUid: 'admin1' });

    expect(res.skipped).toBe('no_credit');
    expect(res.appliedCents).toBe(0);
    expect(creditRows(store, 'inv1')).toHaveLength(0);
    expect(balanceOf(store, 'fam1')).toBe(-500);
    expect(store['invoices/inv1']).toEqual({ kinfolkId: 'fam1', status: 'open', total: 127.5 });
  });
});

describe('onInvoiceAutoApply: a redelivered trigger event draws once', () => {
  const event = (before: Doc | undefined, after: Doc | undefined) =>
    ({
      params: { invoiceId: 'inv1' },
      data: { before: { data: () => before }, after: { data: () => after } },
    }) as any;

  const DRAFT = { kinfolkId: 'fam1', status: 'draft', amountDue: 127.5 };
  const OPEN = { kinfolkId: 'fam1', status: 'open', amountDue: 127.5 };

  function seedTrigger(balanceCents: number) {
    const ctx = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: balanceCents },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    return ctx;
  }

  it('two deliveries AT ONCE spend the credit once (Eventarc is at-least-once)', async () => {
    const { store } = seedTrigger(8000);

    await Promise.all([
      onInvoiceAutoApplyHandler(event(DRAFT, OPEN)),
      onInvoiceAutoApplyHandler(event(DRAFT, OPEN)),
    ]);

    expect(creditRows(store, 'inv1')).toHaveLength(1);
    expect(balanceOf(store, 'fam1')).toBe(0);
    expect(store['invoices/inv1']?.paidCents).toBe(8000);
  });

  it('a delivery REPLAYED after the first has committed draws nothing more', async () => {
    const { store } = seedTrigger(8000);

    await onInvoiceAutoApplyHandler(event(DRAFT, OPEN));
    await onInvoiceAutoApplyHandler(event(DRAFT, OPEN));

    expect(creditRows(store, 'inv1')).toHaveLength(1);
    expect(balanceOf(store, 'fam1')).toBe(0);
    expect(store['invoices/inv1']?.paidCents).toBe(8000);
  });

  it('a replay after a SETTLING draw leaves the remaining credit alone', async () => {
    // $120 held against a $127.50 bill settles nothing, so this case needs the
    // other side: a bill the credit covers, replayed. The leftover must stay on
    // account rather than being poured onto an invoice that owes nothing.
    const ctx = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 50 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onInvoiceAutoApplyHandler(event(DRAFT, { ...OPEN, amountDue: 50 }));
    await onInvoiceAutoApplyHandler(event(DRAFT, { ...OPEN, amountDue: 50 }));

    expect(creditRows(ctx.store, 'inv1')).toHaveLength(1);
    expect(balanceOf(ctx.store, 'fam1')).toBe(7000);
    expect(ctx.store['invoices/inv1']?.status).toBe('paid');
    expect(ctx.store['invoices/inv1']?.overpaidCents).toBe(0);
  });
});
