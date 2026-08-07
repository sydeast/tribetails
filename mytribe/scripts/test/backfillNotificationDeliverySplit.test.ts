import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  parseArgs,
  planForNotification,
  run,
} from '../backfillNotificationDeliverySplit';

/**
 * The R5 relocation script's decision half.
 *
 * The migration DECISION (relocate the legacy delivery state to the work-order
 * collection; do NOT replay it as activity_log entries, because writeAuditEntry
 * timestamps at write time and the hash chain is append-only, so a replay would
 * bury the real audit trail under tens of thousands of entries claiming to have
 * happened today) is argued in the script's own docstring. What is testable here
 * is the per-document plan and the safety contract, so that is what this covers.
 */

describe('backfillNotificationDeliverySplit: per-document plan', () => {
  it('moves every workflow field off a legacy notification', () => {
    const plan = planForNotification(
      'n1',
      {
        key: 'kincare.booking.confirm',
        recipientUid: 'u1',
        title: 'Booking confirmed',
        status: 'dispatched',
        mode: 'trigger',
        channels: ['email', 'sms'],
        dispatchedAt: 'ts',
      },
      ['email', 'sms'],
    );

    expect(plan).not.toBeNull();
    expect(Object.keys(plan!.moved).sort()).toEqual([
      'channels',
      'dispatchedAt',
      'mode',
      'status',
    ]);
    expect(plan!.channelDocs).toEqual(['email', 'sms']);
  });

  it('moves the sweeps’ origin stamps too, because provenance is dispatch state', () => {
    const plan = planForNotification(
      'n1',
      { status: 'dispatched', originScheduledId: 's1', scheduledFireAtMs: 123 },
      [],
    );

    expect(Object.keys(plan!.moved).sort()).toEqual([
      'originScheduledId',
      'scheduledFireAtMs',
      'status',
    ]);
  });

  /**
   * IDEMPOTENCE, which is what makes a re-run safe. A doc already in the new
   * shape yields no plan at all, so the second pass reports zero writes rather
   * than restamping every notification in the collection.
   */
  it('returns no plan for a notification already in the split shape', () => {
    expect(
      planForNotification(
        'n1',
        { key: 'k', recipientUid: 'u1', title: 'T', detail: { kinName: 'Rex' } },
        [],
      ),
    ).toBeNull();
  });

  it('still plans a move for a doc whose fields are gone but whose channel subdocs remain', () => {
    // A half-migrated doc (fields stripped, subdocs not yet copied) must not be
    // mistaken for a finished one, or those subdocs are stranded forever.
    const plan = planForNotification('n1', { key: 'k' }, ['email']);
    expect(plan).not.toBeNull();
    expect(plan!.moved).toEqual({});
    expect(plan!.channelDocs).toEqual(['email']);
  });

  it('never treats content fields as workflow', () => {
    expect(
      planForNotification(
        'n1',
        {
          key: 'k',
          category: 'visit',
          recipientUid: 'u1',
          title: 'T',
          description: 'D',
          actorName: 'Dana',
          data: { bookingId: 'b1' },
          targetType: 'booking',
          targetId: 'b1',
          readAt: 'ts',
          archivedAt: null,
        },
        [],
      ),
    ).toBeNull();
  });
});

describe('backfillNotificationDeliverySplit: argument contract', () => {
  it('defaults to a dry run, like every other backfill in this tree', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', allowProd: false });
  });

  it('only writes when --allow-prod is passed explicitly', () => {
    expect(parseArgs(['--allow-prod'])).toMatchObject({ mode: 'apply', allowProd: true });
  });

  it('accepts a project and a page size', () => {
    expect(parseArgs(['--project', 'p1', '--page-size', '50'])).toMatchObject({
      projectId: 'p1',
      pageSize: 50,
    });
  });

  it('refuses a nonsense page size instead of silently keeping the default', () => {
    // WAS: a bad --page-size fell through and left 300 in place. That is the
    // same silent-ignore failure as everything else in this parser — the
    // operator asked for something, got something else, and nothing said so.
    expect(() => parseArgs(['--page-size', 'banana'])).toThrow(/--page-size must be 1\.\.1000/);
    expect(() => parseArgs(['--page-size', '0'])).toThrow(/--page-size must be 1\.\.1000/);
    expect(() => parseArgs(['--page-size'])).toThrow(/--page-size must be 1\.\.1000/);
  });

  it('HONOURS --dry-run, which it used to drop on the floor', () => {
    // The defect that made this the worst parser of the set: there was no
    // `--dry-run` branch at all. An operator who typed it got a run that read
    // as compliance and was, in the `--allow-prod --dry-run` case, a real
    // production run that deletes channel subdocuments and FieldValue.delete()s
    // fields off live notifications.
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');

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
    // Repetition does not weaken the one intended write path either.
    expect(parseArgs(['--allow-prod', '--allow-prod']).mode).toBe('apply');
  });

  it('REFUSES an unknown argument instead of silently dropping it', () => {
    // The class the --dry-run branch alone would not have fixed. This parser
    // had no `else` at all, so `--dry-runn` — or `-n`, or `--dryrun` — vanished
    // without a word and left --allow-prod standing. The throw is what turns
    // every mistyped safety flag into a refusal rather than a write.
    expect(() => parseArgs(['--dry-runn'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--allow-prod', '--dryrun'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['-n'])).toThrow(/unknown arg/);
  });

  it('a valueless --project cannot swallow the --dry-run that follows it', () => {
    // `--project` used to require only that SOMETHING followed it, so
    // `--allow-prod --project --dry-run` set projectId to the literal string
    // '--dry-run' and consumed the safety flag.
    expect(() => parseArgs(['--allow-prod', '--project', '--dry-run'])).toThrow(
      /--project requires a value/,
    );
    expect(() => parseArgs(['--project'])).toThrow(/--project requires a value/);
    // A real project id still passes through untouched, --dry-run intact.
    const ok = parseArgs(['--allow-prod', '--project', 'p1', '--dry-run']);
    expect(ok.projectId).toBe('p1');
    expect(ok.mode).toBe('dry-run');
  });
});

/**
 * ── THE DRY-RUN TRIPWIRE ────────────────────────────────────────────────────
 *
 * `run()` is the I/O loop, and "a dry run writes nothing" held by inspection
 * only: the single `continue` at `mode !== 'apply'`, ahead of a batch that
 * relocates the dispatch doc, COPIES then DELETES every channel subdocument,
 * and FieldValue.delete()s the workflow fields off the notification.
 *
 * This fake is a TRIPWIRE, not a mock. Every path that reaches Firestore for a
 * WRITE throws — `db.batch()` itself, and `ref.set/update/delete` and
 * `collection().add/doc()` so a write that goes around the batch is caught too.
 * Reads are served normally. `run()` already took an injectable `Firestore` as
 * its first parameter, so this needs no emulator.
 */
type FakeRow = { id: string; data: Record<string, unknown>; channels: string[] };

function fakeNotificationsDb(rows: FakeRow[]) {
  const illegal = (what: string) => () => {
    throw new Error(`ILLEGAL WRITE in dry-run: ${what}`);
  };
  const channelsCollection = (id: string, channels: string[]) => ({
    get: async () => ({
      docs: channels.map((c) => ({
        id: c,
        data: () => ({ channel: c }),
        ref: docRef(`notifications/${id}/channels/${c}`),
      })),
    }),
    doc: illegal('channels.doc()'),
    add: illegal('channels.add()'),
  });
  const docRef = (path: string) => ({
    path,
    set: illegal(`${path}.set()`),
    update: illegal(`${path}.update()`),
    delete: illegal(`${path}.delete()`),
    collection: (name: string) => {
      const id = path.split('/')[1] ?? '';
      const row = rows.find((r) => r.id === id);
      if (name === 'channels' && row) return channelsCollection(id, row.channels);
      throw new Error(`ILLEGAL WRITE in dry-run: ${path}/${name}`);
    },
  });
  const makeQuery = (after: string | null, limit: number) => ({
    limit: (n: number) => makeQuery(after, n),
    startAfter: (cursor: { id: string }) => makeQuery(cursor.id, limit),
    get: async () => {
      const start = after === null ? 0 : rows.findIndex((r) => r.id === after) + 1;
      const page = rows.slice(start, start + limit);
      return {
        empty: page.length === 0,
        size: page.length,
        docs: page.map((r) => ({
          id: r.id,
          data: () => r.data,
          ref: docRef(`notifications/${r.id}`),
        })),
      };
    },
  });
  const db = {
    collection: (name: string) => {
      if (name === 'notifications') {
        return {
          orderBy: (field: string) => {
            if (field !== '__name__') throw new Error(`unexpected orderBy: ${field}`);
            return makeQuery(null, rows.length);
          },
          doc: illegal('notifications.doc()'),
          add: illegal('notifications.add()'),
        };
      }
      // notificationDispatch and activity_log are write destinations only.
      return { doc: illegal(`${name}.doc()`), add: illegal(`${name}.add()`) };
    },
    batch: () => {
      throw new Error('ILLEGAL WRITE in dry-run: db.batch()');
    },
  };
  return db as unknown as Firestore;
}

/** Three legacy rows carrying workflow state, one already split. */
const TRIPWIRE_ROWS: FakeRow[] = [
  {
    id: 'n1',
    data: { key: 'k', recipientUid: 'u1', status: 'dispatched', mode: 'trigger' },
    channels: ['email'],
  },
  {
    id: 'n2',
    data: { key: 'k', recipientUid: 'u2', status: 'sent', channels: ['sms'] },
    channels: ['sms'],
  },
  { id: 'n3', data: { key: 'k', recipientUid: 'u3', title: 'T' }, channels: [] },
];

describe('backfillNotificationDeliverySplit run(): a DRY RUN WRITES NOTHING', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scans, plans, and writes NOTHING — against a db where any write throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // pageSize 2 over 3 rows, so the cursor/startAfter paging runs twice.
    const result = await run(fakeNotificationsDb(TRIPWIRE_ROWS), 'dry-run', 2);
    expect(result.scanned).toBe(3);
    // Load-bearing: a fixture that planned nothing would pass this test with
    // the mode gate deleted. Two planned splits mean the gate is what stopped
    // the writes, not an empty plan.
    expect(result.split).toBe(2);
    expect(result.channelDocsMoved).toBe(2);
    expect(result.skipped).toEqual({ already_split: 1 });
  });

  it('the same fake DOES catch a write, so the tripwire is armed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Apply mode through the identical fake must reach db.batch() and blow up.
    // If it did not, the test above would prove nothing: it would be green
    // because the fake is inert, not because dry-run is safe.
    await expect(run(fakeNotificationsDb(TRIPWIRE_ROWS), 'apply', 2)).rejects.toThrow(
      /ILLEGAL WRITE in dry-run: db\.batch\(\)/,
    );
  });
});
