import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planRow,
  summarize,
  createdAtIso,
  BROADCAST_KEY,
  CATALOG_CATEGORY,
  DEAD_CATEGORY,
  FIELD,
  type PlannedRow,
  type RowInput,
} from '../backfillBroadcastNotificationCategory';
import { NOTIFICATION_CATALOG } from '../../functions/src/notifications/catalog';

/**
 * The backfill's pure rules (issue #443).
 *
 * The operator runs this against production themselves and decides from the dry
 * run alone whether to apply it or to close #443 with "old enough to leave", so
 * the counts have to be right before the script ever sees real data — a wrong
 * count would make that decision on bad information, which is the failure mode
 * the issue is actually about.
 *
 * Every test here is pure. No Firestore, no emulator.
 */

/** A broadcast notification as `broadcastMessage` wrote one before PR #424. */
function legacyBroadcast(overrides: Partial<RowInput> = {}): RowInput {
  return {
    path: 'notifications/b1',
    key: BROADCAST_KEY,
    data: {
      key: BROADCAST_KEY,
      category: DEAD_CATEGORY,
      recipientUid: 'client_1',
      title: 'Closed Monday for the storm',
      description: 'We are closed Monday. Visits resume Tuesday.',
      body: 'We are closed Monday. Visits resume Tuesday.',
      broadcast: true,
      targetType: 'kinfolk',
      targetId: 'kf_1',
      createdAt: '2026-08-04T17:00:00.000Z',
    },
    ...overrides,
  };
}

describe('the script targets the category the catalog actually carries', () => {
  it('agrees with the broadcast.message catalog row', () => {
    // The constant is hard-coded so the migration records what it was written
    // for rather than silently retargeting itself. This is the guard that makes
    // hard-coding safe: re-categorise the row and this test fails, in the same
    // suite as the change.
    const def = NOTIFICATION_CATALOG[BROADCAST_KEY];
    expect(def).toBeDefined();
    expect(def?.category).toBe(CATALOG_CATEGORY);
    // And the value #424 replaced is in no catalog, which is the whole bug.
    const categories = Object.values(NOTIFICATION_CATALOG).map((d) => d.category);
    expect(categories).not.toContain(DEAD_CATEGORY);
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null, samples: 10 });
  });

  it('--allow-prod is the only thing that switches to apply', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    const allowThenDry = parseArgs(['--allow-prod', '--dry-run']);
    expect(allowThenDry.mode).toBe('dry-run');
    expect(allowThenDry.allowProd).toBe(true);
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('takes a project override and a sample count', () => {
    expect(parseArgs(['--project', 'mytribe-prod']).projectId).toBe('mytribe-prod');
    expect(parseArgs(['--samples', '40']).samples).toBe(40);
  });

  it('refuses a valueless flag rather than swallowing the next one', () => {
    expect(() => parseArgs(['--allow-prod', '--project', '--dry-run'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--samples', 'many'])).toThrow(/whole number/);
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
  });
});

describe('planRow', () => {
  it('moves the dead category onto the catalog one', () => {
    expect(planRow(legacyBroadcast())).toEqual({ update: true, state: 'dead', current: DEAD_CATEGORY });
  });

  it('treats an absent category the same way, because it is the same blindness', () => {
    // `dispatcher.ts` stamps the field on everything it writes, so an absent
    // one is not a shape any writer intends — and to a catalog-driven surface
    // it is indistinguishable from the invented bucket.
    const noCategory = legacyBroadcast({ data: { key: BROADCAST_KEY, body: 'hi' } });
    expect(planRow(noCategory)).toEqual({ update: true, state: 'missing', current: null });
    const blank = legacyBroadcast({ data: { key: BROADCAST_KEY, category: '   ' } });
    expect(planRow(blank).state).toBe('missing');
  });

  it('leaves a row that already carries the catalog category alone', () => {
    // A broadcast written after #424. This is also the post-run state, so this
    // case is what makes a second run a no-op.
    const fixed = legacyBroadcast({ data: { key: BROADCAST_KEY, category: CATALOG_CATEGORY } });
    expect(planRow(fixed)).toEqual({ update: false, state: 'catalog', current: CATALOG_CATEGORY });
  });

  it('refuses to overwrite a value somebody chose', () => {
    // 'marketing' is a real catalog category, so a broadcast filed under it was
    // somebody's decision, not #424's placeholder. It is reported, not fixed.
    const foreign = legacyBroadcast({ data: { key: BROADCAST_KEY, category: 'marketing' } });
    expect(planRow(foreign)).toEqual({ update: false, state: 'foreign', current: 'marketing' });
  });

  it('never touches a document that is not a broadcast', () => {
    // No version of this migration guesses a category for another key, however
    // wrong that key's own category might look.
    const other = legacyBroadcast({ key: 'kincare.changed', data: { key: 'kincare.changed', category: DEAD_CATEGORY } });
    expect(planRow(other).update).toBe(false);
  });

  it('writes exactly one field', () => {
    expect(FIELD).toBe('category');
  });
});

describe('createdAtIso', () => {
  it('reads a Firestore Timestamp, an ISO string and millis alike', () => {
    // The scan sees whatever the writer stored: `serverTimestamp()` comes back
    // as a Timestamp, and older rows migrated from the previous system carry
    // their original creation date as a string.
    const stamp = { toDate: () => new Date('2026-08-04T17:00:00.000Z') };
    expect(createdAtIso(stamp)).toBe('2026-08-04T17:00:00.000Z');
    expect(createdAtIso('2026-08-04T17:00:00.000Z')).toBe('2026-08-04T17:00:00.000Z');
    expect(createdAtIso(1_754_326_800_000)).toBe(new Date(1_754_326_800_000).toISOString());
    expect(createdAtIso(undefined)).toBeNull();
    expect(createdAtIso('not a date')).toBeNull();
  });
});

describe('the dry run reports what the #443 decision needs', () => {
  const planned = (rows: RowInput[]): PlannedRow[] => rows.map((row) => ({ row, plan: planRow(row) }));

  it('counts the affected rows and dates them, so "old enough to leave" is answerable', () => {
    const summary = summarize(
      412,
      planned([
        legacyBroadcast({ path: 'notifications/b1' }),
        legacyBroadcast({
          path: 'notifications/b2',
          data: { key: BROADCAST_KEY, category: DEAD_CATEGORY, createdAt: '2026-07-19T09:30:00.000Z' },
        }),
        legacyBroadcast({
          path: 'notifications/b3',
          data: { key: BROADCAST_KEY, createdAt: '2026-08-12T12:00:00.000Z' },
        }),
        // Written after #424: already correct, and not part of the age range.
        legacyBroadcast({
          path: 'notifications/b4',
          data: { key: BROADCAST_KEY, category: CATALOG_CATEGORY, createdAt: '2026-08-18T08:00:00.000Z' },
        }),
      ]),
    );

    expect(summary).toMatchObject({
      scanned: 412,
      broadcasts: 4,
      dead: 2,
      missing: 1,
      catalog: 1,
      foreign: 0,
      toUpdate: 3,
      // The range covers the rows an apply run would touch, not the collection.
      oldest: '2026-07-19T09:30:00.000Z',
      newest: '2026-08-12T12:00:00.000Z',
    });
  });

  it('names every value it refuses to overwrite, with counts', () => {
    const summary = summarize(
      10,
      planned([
        legacyBroadcast({ path: 'notifications/f1', data: { key: BROADCAST_KEY, category: 'marketing' } }),
        legacyBroadcast({ path: 'notifications/f2', data: { key: BROADCAST_KEY, category: 'marketing' } }),
        legacyBroadcast({ path: 'notifications/f3', data: { key: BROADCAST_KEY, category: 'announcements' } }),
        legacyBroadcast({ path: 'notifications/f4' }),
      ]),
    );
    expect(summary.foreign).toBe(3);
    expect(summary.toUpdate).toBe(1);
    expect(summary.foreignValues).toEqual([
      { value: 'marketing', count: 2 },
      { value: 'announcements', count: 1 },
    ]);
  });

  it('reports zero once the backfill has run, which is the operator’s done check', () => {
    const summary = summarize(
      412,
      planned([legacyBroadcast({ data: { key: BROADCAST_KEY, category: CATALOG_CATEGORY } })]),
    );
    expect(summary).toMatchObject({ broadcasts: 1, toUpdate: 0, dead: 0, missing: 0 });
    expect(summary.oldest).toBeNull();
    expect(summary.newest).toBeNull();
  });
});
