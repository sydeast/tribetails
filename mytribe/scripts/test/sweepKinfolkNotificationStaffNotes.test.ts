import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planRow,
  redactNotes,
  summarize,
  deletedFieldPath,
  DETAIL_FIELD,
  NOTES_FIELD_PATH,
  SWEEP_ORDER,
  QUEUE_COLLECTION,
  INBOX_COLLECTION,
  type PlannedRow,
  type RowInput,
} from '../sweepKinfolkNotificationStaffNotes';

/**
 * The sweep's pure rules (issue #442).
 *
 * The operator runs this script against production from their own machine and
 * decides whether to apply it from the dry run's output alone, so three things
 * have to hold against fixtures before it ever sees real data: the right
 * documents are chosen, the ones deliberately left alone stay untouched, and
 * the report the decision rests on counts what it says it counts.
 *
 * Every test here is pure. No Firestore, no emulator: `planRow`, `summarize`,
 * `redactNotes` and `deletedFieldPath` between them hold every decision the
 * migration makes about a single document.
 */

/** A household copy of a visit card, notes and all — the leak, in one document. */
function kinfolkRow(overrides: Partial<RowInput> = {}): RowInput {
  return {
    path: 'notifications/n1',
    key: 'kincare.changed',
    recipientUid: 'client_1',
    data: {
      key: 'kincare.changed',
      recipientUid: 'client_1',
      title: 'Your KinCare visit was updated',
      detail: {
        kinfolkName: 'The Halbrooks',
        kinName: 'Bandit',
        serviceType: 'Dog Walk',
        bookingDate: 'Fri, Aug 8',
        notes: 'client disputes last invoice, do not discuss pricing',
      },
    },
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('defaults to a dry run, with samples on', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null, samples: 10 });
  });

  it('--allow-prod is the only thing that switches to apply', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    // The script issues FieldValue.delete() and nothing is salvaged anywhere,
    // so the dry run is the only chance to look at what goes.
    const allowThenDry = parseArgs(['--allow-prod', '--dry-run']);
    expect(allowThenDry.mode).toBe('dry-run');
    // The flag still reports it was seen, rather than silently vanishing.
    expect(allowThenDry.allowProd).toBe(true);
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('takes a project override and a sample count', () => {
    expect(parseArgs(['--project', 'mytribe-prod']).projectId).toBe('mytribe-prod');
    expect(parseArgs(['--samples', '40']).samples).toBe(40);
    expect(parseArgs(['--samples', '0']).samples).toBe(0);
  });

  it('refuses a valueless flag rather than swallowing the next one', () => {
    // `--allow-prod --project --dry-run` must not become a WRITING run with the
    // safety flag eaten as a project id.
    expect(() => parseArgs(['--allow-prod', '--project', '--dry-run'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--samples'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--samples', 'lots'])).toThrow(/whole number/);
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
  });
});

describe('redactNotes never prints the words', () => {
  it('keeps the shape and loses the content', () => {
    expect(redactNotes('Gate code 4321, dog bites.')).toBe('Xxxx xxxx ####, xxx xxxxx.');
  });

  it('leaks no letter or digit from the original, at any length', () => {
    const secret = 'Client owes $250 since June; escalate to Syd before the visit.';
    const masked = redactNotes(secret);
    // Nothing but the mask alphabet survives: `x`, `X`, `#`, punctuation, spaces.
    expect(masked).not.toMatch(/[A-WYZa-wyz0-9]/);
    // Punctuation and spacing survive, which is the whole point of a shape.
    expect(masked).toContain('$');
    expect(masked).toContain(';');
    expect(masked.length).toBe(secret.length);
  });

  it('truncates a long note and states the true length', () => {
    const masked = redactNotes('a'.repeat(200));
    expect(masked).toBe(`${'x'.repeat(72)}…(+128 chars)`);
  });
});

describe('planRow', () => {
  it('strips a household copy and keeps the rest of the detail map', () => {
    const plan = planRow(kinfolkRow(), true);
    expect(plan.strip).toBe(true);
    expect(plan.shape).toBe('text');
    expect(plan.removeDetail).toBe(false);
    expect(plan.skipReason).toBeNull();
    // The preview carries the shape and none of the words: only the mask
    // alphabet (`x`, `X`, `#`) and punctuation come out the other side.
    expect(plan.redacted).not.toMatch(/[A-WYZa-wyz0-9]/);
    expect(plan.length).toBe('client disputes last invoice, do not discuss pricing'.length);
  });

  it('leaves a staff copy of the same key alone', () => {
    // `kincare.changed` fans one event out to the office AND to the household.
    // The office copy is the field's legitimate home under ruling R5, and a
    // sweep that took it would be the #380 fix running backwards.
    const staff = kinfolkRow({ path: 'notifications/n2', recipientUid: 'staff_1' });
    const plan = planRow(staff, false);
    expect(plan.strip).toBe(false);
    expect(plan.skipReason).toBe('recipient-not-kinfolk');
    // Still measured, so the report can show what was deliberately left behind.
    expect(plan.shape).toBe('text');
  });

  it('removes the whole detail map when notes was the only field in it', () => {
    // `dispatcher.ts` omits `detail` entirely rather than writing a blank one,
    // so leaving `{}` behind would be a shape no writer here produces.
    const row = kinfolkRow({ data: { key: 'kincare.upcoming.reminder', detail: { notes: 'gate is stuck' } } });
    const plan = planRow(row, true);
    expect(plan.strip).toBe(true);
    expect(plan.removeDetail).toBe(true);
  });

  it('strips a stored-but-blank notes key, because presence is the shape', () => {
    // `notes: ''` is a stored field, not an absent one. Today's writer omits
    // blanks (`present()` in buildNotificationDetail), so a blank left behind
    // preserves exactly the shape #415 removed.
    const blank = planRow(kinfolkRow({ data: { detail: { kinfolkName: 'The Halbrooks', notes: '' } } }), true);
    expect(blank.strip).toBe(true);
    expect(blank.shape).toBe('blank');
    expect(blank.redacted).toBeNull();

    const nulled = planRow(kinfolkRow({ data: { detail: { kinfolkName: 'X', notes: null } } }), true);
    expect(nulled.strip).toBe(true);
    expect(nulled.shape).toBe('blank');
  });

  it('leaves a clean document alone in every already-swept shape', () => {
    const noNotes = planRow(
      kinfolkRow({ data: { detail: { kinfolkName: 'The Halbrooks', bookingDate: 'Fri, Aug 8' } } }),
      true,
    );
    expect(noNotes).toMatchObject({ strip: false, skipReason: 'no-notes', shape: 'absent' });

    // No detail map at all: the post-#415 kinfolk copy of a booking card.
    expect(planRow(kinfolkRow({ data: { key: 'kincare.changed' } }), true).strip).toBe(false);
    // And nothing map-shaped in the slot cannot be walked into a crash.
    expect(planRow(kinfolkRow({ data: { detail: null } }), true).strip).toBe(false);
    expect(planRow(kinfolkRow({ data: { detail: 'notes' } }), true).strip).toBe(false);
    expect(planRow(kinfolkRow({ data: { detail: [] } }), true).strip).toBe(false);
  });

  it('is idempotent: a second run over the swept document plans nothing', () => {
    const first = planRow(kinfolkRow(), true);
    expect(first.strip).toBe(true);
    // What the apply leaves behind: same document, same detail, no notes key.
    const swept = kinfolkRow({
      data: { detail: { kinfolkName: 'The Halbrooks', kinName: 'Bandit', serviceType: 'Dog Walk' } },
    });
    expect(planRow(swept, true).strip).toBe(false);
  });
});

describe('deletedFieldPath', () => {
  it('deletes only the nested field, unless the map is left empty', () => {
    expect(deletedFieldPath({ path: 'notifications/n1', key: 'k', removeDetail: false })).toBe(
      NOTES_FIELD_PATH,
    );
    expect(deletedFieldPath({ path: 'notifications/n1', key: 'k', removeDetail: true })).toBe(
      DETAIL_FIELD,
    );
    // The nested path is dotted, which is what makes `update()` reach inside
    // the map instead of replacing it.
    expect(NOTES_FIELD_PATH).toBe('detail.notes');
  });
});

describe('the dry run reports what the operator decides from', () => {
  const planned = (rows: Array<[RowInput, boolean]>): PlannedRow[] =>
    rows.map(([row, isKinfolk]) => ({ row, plan: planRow(row, isKinfolk) }));

  it('counts per collection and per key, and separates staff copies from household ones', () => {
    const summary = summarize(
      'notifications',
      120,
      planned([
        [kinfolkRow({ path: 'notifications/a' }), true],
        [kinfolkRow({ path: 'notifications/b' }), true],
        // Same key, office copy: counted as carrying, never as strip.
        [kinfolkRow({ path: 'notifications/c', recipientUid: 'staff_1' }), false],
        // A different key, household copy, notes alone in the map.
        [
          kinfolkRow({
            path: 'notifications/d',
            key: 'kincare.upcoming.reminder',
            data: { key: 'kincare.upcoming.reminder', detail: { notes: 'side gate' } },
          }),
          true,
        ],
        // Already clean: scanned, but invisible to every count below.
        [kinfolkRow({ path: 'notifications/e', data: { detail: { kinfolkName: 'X' } } }), true],
      ]),
    );

    expect(summary).toMatchObject({
      collection: 'notifications',
      scanned: 120,
      carrying: 4,
      strip: 3,
      leftStaff: 1,
      detailEmptied: 1,
    });
    expect(summary.byKey).toEqual([
      { key: 'kincare.changed', carrying: 3, strip: 2, leftStaff: 1, text: 2 },
      { key: 'kincare.upcoming.reminder', carrying: 1, strip: 1, leftStaff: 0, text: 1 },
    ]);
  });

  it('reports a key nobody predicted rather than hiding it', () => {
    // PR #415 derived eight `kincare.*` keys. The sweep filters on no key at
    // all, so if the derivation was wrong the report is where that shows up —
    // and an unpredicted key sorts by its strip count, not to the bottom.
    const summary = summarize(
      'notifications',
      10,
      planned([
        [
          kinfolkRow({
            path: 'notifications/x',
            key: 'invoice.new',
            data: { key: 'invoice.new', detail: { amount: '$40', notes: 'do not chase this one' } },
          }),
          true,
        ],
        [kinfolkRow({ path: 'notifications/y' }), true],
      ]),
    );
    expect(summary.byKey.map((k) => k.key).sort()).toEqual(['invoice.new', 'kincare.changed']);
    expect(summary.strip).toBe(2);
  });

  it('reports zero to strip once the sweep has run, which is the operator’s check', () => {
    const summary = summarize(
      'scheduledNotifications',
      40,
      planned([[kinfolkRow({ data: { detail: { kinfolkName: 'The Halbrooks' } } }), true]]),
    );
    expect(summary).toMatchObject({ scanned: 40, carrying: 0, strip: 0, leftStaff: 0 });
    expect(summary.byKey).toEqual([]);
  });
});

describe('sweep order', () => {
  it('cleans the queue before the inbox it refills', () => {
    // `promoteQueued` copies `detail` verbatim onto a new notifications doc and
    // the scheduled cron runs every 5 minutes, so cleaning the inbox first
    // leaves the source dirty and the next promotion undoes the sweep.
    expect(SWEEP_ORDER).toEqual([QUEUE_COLLECTION, INBOX_COLLECTION]);
    expect(SWEEP_ORDER[0]).toBe('scheduledNotifications');
    expect(SWEEP_ORDER[1]).toBe('notifications');
  });
});
