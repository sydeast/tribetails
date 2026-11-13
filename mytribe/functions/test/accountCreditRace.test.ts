import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), delivered: new Set<string>() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: async () => 'kin-uid-1' }));
// #1005: this suite's hand-rolled db has no members subcollection, so the billing
// recipient resolver is pointed at the resolveKinfolkUid mock above. The resolver's
// own rules are pinned in resolveBillingRecipientUid.test.ts.
vi.mock('../src/lib/resolveBillingRecipientUid', async () => ({
  resolveBillingRecipientUid: (await import('../src/lib/resolveKinfolkUid')).resolveKinfolkUid,
}));
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
      delete: () => ({ __delete: true }),
    },
  };
});

import { balanceAfterDraw, drawAccountCredit } from '../src/lib/accountCredit';
import { onInvoiceAutoApplyHandler } from '../src/triggers/onInvoiceAutoApply';

beforeEach(() => mocks.dbFn.mockReset());

/**
 * TWO CREDIT DRAWS IN FLIGHT AT ONCE (#830, re-read for #1872).
 *
 * #830 closed two passes reading the same held credit and both spending it.
 * Since #1872 a draw is an amount the admin entered, so the arithmetic that
 * once made a repeat harmless ("the smaller of owed and held") is gone, and two
 * things carry the guarantee instead: the idempotency key for one submission
 * sent twice, and the transaction for two different submissions over one
 * balance. The trigger that used to be the second caller draws nothing at all.
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
    const next: Doc = merge ? { ...(store[path] ?? {}), ...resolved } : resolved;
    // FieldValue.delete() removes the field, as it does in Firestore.
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === 'object' && '__delete' in (v as Doc)) delete next[k];
    }
    store[path] = next;
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

const KEY_A = 'acr_1790000000000_aaaaaa';
const KEY_B = 'acr_1790000000000_bbbbbb';

function draw(db: any, invoiceId: string, amountCents: number, paymentId: string, actorUid = 'admin1') {
  return drawAccountCredit(db, { invoiceId, actorUid, amountCents, paymentId });
}

describe('drawAccountCredit: ONE submission sent twice at the same moment', () => {
  it('draws once: the double tap cannot take the amount twice', async () => {
    // $50 of $120 onto a $127.50 bill. Without the key, both would fit.
    const { db, store } = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);
    const [a, b] = await Promise.all([draw(db, 'inv1', 5000, KEY_A), draw(db, 'inv1', 5000, KEY_A)]);
    expect(creditRows(store, 'inv1')).toHaveLength(1);
    expect(balanceOf(store, 'fam1')).toBe(7000);
    expect(store['invoices/inv1']?.paidCents).toBe(5000);
    expect(store['invoices/inv1']?.amountDueCents).toBe(7750);
    expect(store['invoices/inv1']?.status).toBe('open');
    // Both callers are told the same true thing; exactly one of them did it.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    for (const r of [a, b]) {
      expect(r).toMatchObject({ refused: null, appliedCents: 5000, accountBalanceCents: 7000, amountDueCents: 7750 });
    }

    // One credit history entry and one Activity Log line, not two.
    expect(Object.keys(store).filter((p) => p.startsWith('families/fam1/creditLedger/'))).toHaveLength(1);
    expect(Object.keys(store).filter((p) => p.startsWith('activity_log/'))).toHaveLength(1);
  });
  it('draws once when the amount pays the bill off, and the replay still reports the success', async () => {
    const { db, store } = buildRacingDb({
      'invoices/inv2': { kinfolkId: 'fam1', status: 'open', total: 50 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);
    const [a, b] = await Promise.all([draw(db, 'inv2', 5000, KEY_A), draw(db, 'inv2', 5000, KEY_A)]);
    expect(creditRows(store, 'inv2')).toHaveLength(1);
    // $70 stays on account: it was never asked for.
    expect(balanceOf(store, 'fam1')).toBe(7000);
    expect(store['invoices/inv2']?.status).toBe('paid');
    expect(store['invoices/inv2']?.overpaidCents).toBe(0);
    expect(a.refused).toBeNull();
    expect(b.refused).toBeNull();
  });
});
describe('drawAccountCredit: a pay-off sent twice tells the household once (#884)', () => {
  it('the first call sends the notice, and its replay adds no second copy', async () => {
    mocks.delivered.clear();
    const { db, store } = buildRacingDb({
      'invoices/inv2': { kinfolkId: 'fam1', status: 'open', total: 50 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);
    await Promise.all([draw(db, 'inv2', 5000, KEY_A), draw(db, 'inv2', 5000, KEY_A)]);
    expect(creditRows(store, 'inv2')).toHaveLength(1);
    expect(mocks.delivered.size).toBe(1);
    expect(store['invoices/inv2']?.paymentAppliedNoticePending).toBe('');
  });
});
describe('drawAccountCredit: two DIFFERENT submissions racing', () => {
  it('over one invoice: the second is refused once the first has paid it', async () => {
    const { db, store } = buildRacingDb({
      'invoices/inv2': { kinfolkId: 'fam1', status: 'open', total: 50 },
      'families/fam1': { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(db);
    const [a, b] = await Promise.all([
      draw(db, 'inv2', 5000, KEY_A, 'admin1'),
      draw(db, 'inv2', 5000, KEY_B, 'admin2'),
    ]);
    expect(a.appliedCents + b.appliedCents).toBe(5000);
    expect(creditRows(store, 'inv2')).toHaveLength(1);
    expect(balanceOf(store, 'fam1')).toBe(7000);
    const loser = a.appliedCents === 0 ? a : b;
    expect(loser.refused).toBe('invoice_paid');
  });

  /**
   * The case a same-invoice test cannot reach. Both draws are legitimate on
   * their own; together they ask for more than the household holds. The
   * serialisation point is `families/{id}`, and this is the test that proves it
   * is one, because the invoice documents are different.
   */
  for (const order of ['a-then-b', 'b-then-a'] as const) {
    it(`over one balance: the second is refused, never trimmed (${order})`, async () => {
      const { db, store } = buildRacingDb({
        'invoices/invA': { kinfolkId: 'fam1', status: 'open', total: 80 },
        'invoices/invB': { kinfolkId: 'fam1', status: 'open', total: 80 },
        'families/fam1': { accountBalanceCents: 12000 },
      });
      mocks.dbFn.mockReturnValue(db);
      const drawA = () => draw(db, 'invA', 8000, KEY_A, 'admin1');
      const drawB = () => draw(db, 'invB', 8000, KEY_B, 'admin2');
      const [first, second] =
        order === 'a-then-b' ? await Promise.all([drawA(), drawB()]) : await Promise.all([drawB(), drawA()]);

      // $120 held, $80 + $80 asked: one lands, the other hears there is $40.
      expect(first.appliedCents + second.appliedCents).toBe(8000);
      const loser = first.appliedCents === 0 ? first : second;
      expect(loser.refused).toBe('over_credit');
      expect(loser.accountBalanceCents).toBe(4000);
      expect(balanceOf(store, 'fam1')).toBe(4000);
      expect(creditRows(store, 'invA').length + creditRows(store, 'invB').length).toBe(1);
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
    await draw(db, 'inv1', 12000, KEY_A);
    // THE WRITE ITSELF, as asked for. An `increment(-draw)` applies whatever it
    // lands on, so the only figure that can be refused for being negative is an
    // absolute one — asserting on the resolved store would not tell them apart.
    const famWrite = writes.find((w) => w.path === 'families/fam1');
    expect(typeof famWrite?.data.accountBalanceCents).toBe('number');
    expect(famWrite?.data.accountBalanceCents).toBe(0);
    expect(balanceOf(store, 'fam1')).toBe(0);
  });
  it('survives a burst of five overlapping draws on one household without going negative', async () => {
    // Five invoices of $50, $50 asked on each, $120 held. Two fit; the other
    // three are refused. Nothing may push the balance below zero.
    const seedDocs: Record<string, Doc> = { 'families/fam1': { accountBalanceCents: 12000 } };
    for (let i = 1; i <= 5; i += 1) {
      seedDocs[`invoices/inv${i}`] = { kinfolkId: 'fam1', status: 'open', total: 50 };
    }
    const { db, store } = buildRacingDb(seedDocs);
    mocks.dbFn.mockReturnValue(db);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => draw(db, `inv${i}`, 5000, `acr_179000000000${i}_burst`)),
    );
    const drawn = results.reduce((sum, r) => sum + r.appliedCents, 0);
    expect(drawn).toBe(10000);
    expect(results.filter((r) => r.refused === 'over_credit')).toHaveLength(3);
    expect(balanceOf(store, 'fam1')).toBe(2000);

    // Every invoice was credited with exactly what its draw reported, so the
    // money on the bills equals the money that left the account.
    const onBills = [1, 2, 3, 4, 5].reduce(
      (sum, i) => sum + Number(store[`invoices/inv${i}`]?.paidCents ?? 0),
      0,
    );
    expect(onBills).toBe(10000);
  });
  it('treats an ALREADY negative stored balance as no credit, and writes nothing', async () => {
    // Defensive: whatever put a debt there, a draw must not go against it and
    // must not "fix" it by writing money the household never had.
    const { db, store } = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: -500 },
    });
    mocks.dbFn.mockReturnValue(db);
    const res = await draw(db, 'inv1', 1000, KEY_A);
    expect(res.refused).toBe('over_credit');
    expect(res.appliedCents).toBe(0);
    expect(creditRows(store, 'inv1')).toHaveLength(0);
    expect(balanceOf(store, 'fam1')).toBe(-500);
    expect(store['invoices/inv1']).toEqual({ kinfolkId: 'fam1', status: 'open', total: 127.5 });
  });
});
describe('onInvoiceAutoApply: a trigger delivery spends nothing, once or twice (#1872)', () => {
  const event = (before: Doc | undefined, after: Doc | undefined) =>
    ({
      params: { invoiceId: 'inv1' },
      data: { before: { data: () => before }, after: { data: () => after } },
    }) as any;
  const DRAFT = { kinfolkId: 'fam1', status: 'draft', amountDue: 127.5 };
  const OPEN = { kinfolkId: 'fam1', status: 'open', amountDue: 127.5 };
  it('a send, delivered twice at once and then again, leaves the credit and the bill alone', async () => {
    const { db, store, writes } = buildRacingDb({
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 127.5 },
      'families/fam1': { accountBalanceCents: 8000 },
    });
    mocks.dbFn.mockReturnValue(db);
    await Promise.all([
      onInvoiceAutoApplyHandler(event(DRAFT, OPEN)),
      onInvoiceAutoApplyHandler(event(DRAFT, OPEN)),
    ]);
    await onInvoiceAutoApplyHandler(event(DRAFT, OPEN));
    expect(writes).toHaveLength(0);
    expect(creditRows(store, 'inv1')).toHaveLength(0);
    expect(balanceOf(store, 'fam1')).toBe(8000);
    expect(store['invoices/inv1']).toEqual({ kinfolkId: 'fam1', status: 'open', total: 127.5 });
  });
});
