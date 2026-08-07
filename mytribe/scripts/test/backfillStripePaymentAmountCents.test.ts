import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  parseArgs,
  planAmountCentsStamp,
  run,
  PAYMENTS_COLLECTION,
} from '../backfillStripePaymentAmountCents';

describe('backfillStripePaymentAmountCents parseArgs', () => {
  it('defaults to dry-run', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
    expect(a.pageSize).toBe(300);
  });

  it('--allow-prod implies an apply run', () => {
    const a = parseArgs(['--allow-prod']);
    expect(a.mode).toBe('apply');
    expect(a.allowProd).toBe(true);
  });

  it('captures --project and --page-size', () => {
    const a = parseArgs(['--project', 'mytribe-test', '--page-size', '50']);
    expect(a.projectId).toBe('mytribe-test');
    expect(a.pageSize).toBe(50);
  });

  it('refuses a nonsense page size', () => {
    expect(() => parseArgs(['--page-size', '0'])).toThrow();
    expect(() => parseArgs(['--page-size', 'lots'])).toThrow();
  });

  it('throws on unknown args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    // The one flag whose entire purpose is proving a run is safe before it
    // touches money. `--allow-prod --dry-run` must stay a dry run just as
    // surely as `--dry-run --allow-prod` does — a bug here inverts the
    // safety default on the exact script this task exists to make safe.
    const allowThenDry = parseArgs(['--allow-prod', '--dry-run']);
    expect(allowThenDry.mode).toBe('dry-run');
    // allowProd still reports the flag was seen, even though it lost.
    expect(allowThenDry.allowProd).toBe(true);

    const dryThenAllow = parseArgs(['--dry-run', '--allow-prod']);
    expect(dryThenAllow.mode).toBe('dry-run');
    expect(dryThenAllow.allowProd).toBe(true);
  });

  it('one --dry-run beats any number of repeated --allow-prod', () => {
    expect(parseArgs(['--allow-prod', '--dry-run', '--allow-prod']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--dry-run']).mode).toBe('dry-run');
    // Repetition does not weaken the one intended write path either.
    expect(parseArgs(['--allow-prod', '--allow-prod']).mode).toBe('apply');
  });

  it('--dry-run alone is a no-op on the already-default mode', () => {
    const a = parseArgs(['--dry-run']);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
  });

  it('a valueless --project cannot swallow the --dry-run that follows it', () => {
    // The escape hatch out of the guarantee directly above: `--project` used to
    // take any next token as its value, so one forgotten project id turned
    // `--allow-prod --project --dry-run` back into an apply run with the safety
    // flag eaten. Refuse a flag as a value instead.
    expect(() => parseArgs(['--allow-prod', '--project', '--dry-run'])).toThrow(
      /--project requires a value/,
    );
    expect(() => parseArgs(['--project'])).toThrow(/--project requires a value/);
    // A real project id still passes through untouched, --dry-run intact.
    const ok = parseArgs(['--allow-prod', '--project', 'mytribe-test', '--dry-run']);
    expect(ok.projectId).toBe('mytribe-test');
    expect(ok.mode).toBe('dry-run');
  });
});

describe('backfillStripePaymentAmountCents planAmountCentsStamp: the 100x defect', () => {
  it('stamps invoice #1029 correctly: amount 13750 is ALREADY CENTS on a stripe-event row', () => {
    const d = planAmountCentsStamp({ amount: 13750, amountSource: 'stripe-event' });
    expect(d).toEqual({ action: 'stamp', amountCents: 13750, before: null });
  });

  it('stamps a local-invoice row as DOLLARS, the other branch stripeWebhook can take', () => {
    const d = planAmountCentsStamp({ amount: 30, amountSource: 'local-invoice' });
    expect(d).toEqual({ action: 'stamp', amountCents: 3000, before: null });
  });

  it('stamps a row with no amountSource at all as dollars — every recordPayment.ts row predating this field', () => {
    const d = planAmountCentsStamp({ amount: 45.5 });
    expect(d).toEqual({ action: 'stamp', amountCents: 4550, before: null });
  });

  it('reports the prior value in `before` when amountCents is present but invalid', () => {
    const d = planAmountCentsStamp({ amount: 30, amountSource: 'local-invoice', amountCents: -1 });
    expect(d).toEqual({ action: 'stamp', amountCents: 3000, before: -1 });
  });
});

describe('backfillStripePaymentAmountCents planAmountCentsStamp: IS IDEMPOTENT', () => {
  it('a stamped row plans already_correct on the second pass, and stamps nothing further', () => {
    const doc: Record<string, unknown> = { amount: 13750, amountSource: 'stripe-event' };
    const first = planAmountCentsStamp(doc);
    expect(first).toEqual({ action: 'stamp', amountCents: 13750, before: null });

    // Apply the planned write exactly as the script's batch.set would, then re-plan.
    const second = planAmountCentsStamp({ ...doc, amountCents: (first as { amountCents: number }).amountCents });
    expect(second).toEqual({ action: 'skip', reason: 'already_correct' });
  });

  it('running the plan twice does not re-scale an already-correct row (100x -> 10,000x guard)', () => {
    // If a non-idempotent version of this rule re-ran the stripe-event branch
    // on a row that ALREADY carries the correct amountCents, treating that
    // amountCents as though it were still the raw `amount` would multiply an
    // already-correct 13750 by 100 again. The `amountCents` guard at the top
    // of planAmountCentsStamp is what prevents that class of bug.
    const alreadyStamped = { amount: 13750, amountSource: 'stripe-event', amountCents: 13750 };
    expect(planAmountCentsStamp(alreadyStamped)).toEqual({ action: 'skip', reason: 'already_correct' });
    // A second and third plan agree: still skip, still 13750, never touched.
    expect(planAmountCentsStamp(alreadyStamped)).toEqual({ action: 'skip', reason: 'already_correct' });
  });

  it('skips a row PR29 already wrote amountCents onto directly (the modern-row case)', () => {
    expect(planAmountCentsStamp({ amount: 1, amountCents: 13750, amountSource: 'stripe-event' })).toEqual({
      action: 'skip',
      reason: 'already_correct',
    });
  });
});

describe('backfillStripePaymentAmountCents planAmountCentsStamp: fail loud, never guessed', () => {
  it('reports unresolved for an amountSource: "unresolved" row, and stamps nothing', () => {
    expect(planAmountCentsStamp({ amount: null, amountSource: 'unresolved' })).toEqual({
      action: 'skip',
      reason: 'unresolved',
    });
  });

  it('reports unresolved for a stripe-event row with no usable amount', () => {
    expect(planAmountCentsStamp({ amountSource: 'stripe-event' })).toEqual({
      action: 'skip',
      reason: 'unresolved',
    });
  });

  it('reports unresolved for a row with neither amountCents nor a numeric amount', () => {
    expect(planAmountCentsStamp({})).toEqual({ action: 'skip', reason: 'unresolved' });
  });

  it('never returns a "stamp" decision carrying a guessed amountCents for an unresolved row', () => {
    // A regression guard on the shape itself, not just the reason: an
    // unresolved row must come back as action:'skip', never as action:'stamp'
    // with a 0 tucked inside it.
    const d = planAmountCentsStamp({ amount: null, amountSource: 'unresolved' });
    expect(d.action).toBe('skip');
  });
});

/**
 * ── THE DRY-RUN TRIPWIRE ────────────────────────────────────────────────────
 *
 * `run()` is the I/O loop, and "a dry run writes nothing" was held by
 * inspection only: two write sites (`flush()`'s `batch.commit()` and the
 * `activity_log` add in `main()`), both gated on `mode === 'apply'`. Nothing
 * turned red if someone moved `batch.commit()` out of its mode check, or added
 * a stray `docSnap.ref.set()` in the loop that bypassed the batch entirely.
 *
 * This fake is a TRIPWIRE, not a mock. Every path that would reach Firestore
 * for a WRITE throws: `batch.commit()`, and also `ref.set/update/delete` and
 * `collection().add/doc()`, so a write that goes around the batch is caught
 * too. Reads are served normally. `run()` already accepts an injectable
 * `db?: Firestore`, so this needs no emulator.
 */
type FakeRow = { id: string; data: Record<string, unknown> };
type BufferedWrite = { path: string; data: Record<string, unknown>; merge: boolean };
function fakePaymentsDb(rows: FakeRow[], onCommit: (writes: BufferedWrite[]) => void) {
  const buffered: BufferedWrite[] = [];
  let pending: BufferedWrite[] = [];
  const docRef = (id: string) => ({
    id,
    path: `${PAYMENTS_COLLECTION}/${id}`,
    // A write that goes AROUND the batch is still a write. These exist so that
    // adding an unguarded `docSnap.ref.set(...)` inside the scan loop fails
    // this test rather than passing it.
    set: () => {
      throw new Error(`ILLEGAL WRITE in dry-run: ${PAYMENTS_COLLECTION}/${id}.set()`);
    },
    update: () => {
      throw new Error(`ILLEGAL WRITE in dry-run: ${PAYMENTS_COLLECTION}/${id}.update()`);
    },
    delete: () => {
      throw new Error(`ILLEGAL WRITE in dry-run: ${PAYMENTS_COLLECTION}/${id}.delete()`);
    },
  });
  const makeQuery = (after: string | null, limit: number) => ({
    limit: (n: number) => makeQuery(after, n),
    startAfter: (cursor: string) => makeQuery(cursor, limit),
    get: async () => {
      const start = after === null ? 0 : rows.findIndex((r) => r.id === after) + 1;
      const page = rows.slice(start, start + limit);
      return { docs: page.map((r) => ({ id: r.id, data: () => r.data, ref: docRef(r.id) })) };
    },
  });
  const db = {
    collection: (name: string) => {
      if (name !== PAYMENTS_COLLECTION) throw new Error(`unexpected collection read: ${name}`);
      return {
        orderBy: (field: string) => {
          if (field !== '__name__') throw new Error(`unexpected orderBy: ${field}`);
          return makeQuery(null, rows.length);
        },
        add: () => {
          throw new Error('ILLEGAL WRITE in dry-run: collection.add()');
        },
        doc: () => {
          throw new Error('ILLEGAL WRITE in dry-run: collection.doc()');
        },
      };
    },
    batch: () => ({
      // Buffering is NOT I/O: batch.set() is legitimate in both modes, and a
      // discarded batch writes nothing. Recorded so the test can prove the
      // batch was non-empty — `flush()` early-returns on an empty one, so a
      // fixture that stamps nothing would pass even with the gate deleted.
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
        const w = { path: ref.path, data, merge: options?.merge === true };
        buffered.push(w);
        pending.push(w);
      },
      commit: async () => {
        const writes = pending;
        pending = [];
        onCommit(writes);
      },
    }),
  };
  return { db: db as unknown as Firestore, buffered };
}
/** Five rows: three stampable, one already correct, one unresolved. */
const TRIPWIRE_ROWS: FakeRow[] = [
  { id: 'p1', data: { amount: 13750, amountSource: 'stripe-event' } },
  { id: 'p2', data: { amount: 30, amountSource: 'local-invoice' } },
  { id: 'p3', data: { amount: 13750, amountSource: 'stripe-event', amountCents: 13750 } },
  { id: 'p4', data: { amount: null, amountSource: 'unresolved' } },
  { id: 'p5', data: { amount: 45.5 } },
];
describe('backfillStripePaymentAmountCents run(): a DRY RUN WRITES NOTHING', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('scans, plans, and commits NOTHING — against a db where any write throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db, buffered } = fakePaymentsDb(TRIPWIRE_ROWS, () => {
      throw new Error('ILLEGAL WRITE in dry-run: batch.commit()');
    });
    // pageSize 2 over 5 rows, so the cursor/startAfter paging runs three times
    // and the end-of-run flush() is reached with a NON-EMPTY batch.
    const result = await run('dry-run', 2, db);
    expect(result.scanned).toBe(5);
    // Load-bearing: flush() returns early when batchSize === 0, so a run that
    // stamped nothing would pass this test with the mode gate deleted. Three
    // planned stamps mean the gate is what stopped the commit, not an empty
    // batch.
    expect(result.stamped).toBe(3);
    expect(buffered).toHaveLength(3);
    expect(result.skipped).toEqual({ already_correct: 1, unresolved: 1 });
    expect(result.unresolvedIds).toEqual(['p4']);
  });
  it('the same fake DOES catch a write, so the tripwire is armed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = fakePaymentsDb(TRIPWIRE_ROWS, () => {
      throw new Error('ILLEGAL WRITE in dry-run: batch.commit()');
    });
    // Apply mode through the identical fake must hit commit and blow up. If it
    // did not, the test above would prove nothing: it would be green because
    // the fake is inert, not because dry-run is safe.
    await expect(run('apply', 2, db)).rejects.toThrow(/ILLEGAL WRITE in dry-run: batch\.commit\(\)/);
  });
  it('apply mode commits exactly the amountCents merges, and nothing else', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const commits: BufferedWrite[][] = [];
    const { db } = fakePaymentsDb(TRIPWIRE_ROWS, (writes) => {
      commits.push(writes);
    });
    const result = await run('apply', 2, db);
    expect(result.stamped).toBe(3);
    // Three writes, well under WRITES_PER_BATCH, so one flush at the end.
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual([
      { path: 'payments/p1', data: { amountCents: 13750 }, merge: true },
      { path: 'payments/p2', data: { amountCents: 3000 }, merge: true },
      { path: 'payments/p5', data: { amountCents: 4550 }, merge: true },
    ]);
  });
});
