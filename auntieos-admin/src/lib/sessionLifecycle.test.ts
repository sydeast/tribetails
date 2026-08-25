import { describe, it, expect } from 'vitest';
import { appendOfficeNote, lifecycleActionsFor, lifecycleNowIso } from './sessionLifecycle';

/**
 * The client half of the visit clock, tested as pure functions.
 *
 * Every expectation about WHICH buttons appear is transcribed from Android's
 * `LifecycleButton` enablement (`ui/home/HomeScreen.kt#TodayVisitCardView`)
 * plus Auntie Time's "Undo Arrival". A change to one of these assertions is a
 * change to platform parity and should be argued as one.
 */

function actionsOf(state: Parameters<typeof lifecycleActionsFor>[0]): string[] {
  return lifecycleActionsFor(state).map((a) => a.action);
}

describe('which clock actions each state offers', () => {
  it('SCHEDULED offers On the way and Clock in', () => {
    expect(actionsOf('scheduled')).toEqual(['ON_MY_WAY', 'ARRIVED']);
  });

  it('ON_MY_WAY offers only Clock in', () => {
    expect(actionsOf('onMyWay')).toEqual(['ARRIVED']);
  });

  it('ARRIVED offers Clock out and Undo arrival, and NOT a second clock-in', () => {
    expect(actionsOf('arrived')).toEqual(['DEPARTED', 'UNDO_ARRIVAL']);
  });

  // Android offers undo from a DEPARTED card and no re-arrival: the operator
  // undoes first, which is what stops a re-clock-in from silently overwriting
  // the departure.
  it('DEPARTED offers only Undo arrival', () => {
    expect(actionsOf('departed')).toEqual(['UNDO_ARRIVAL']);
  });

  it('a terminal visit offers nothing', () => {
    expect(actionsOf('completed')).toEqual([]);
    expect(actionsOf('cancelled')).toEqual([]);
  });

  // AO-12: an unrecognized status is classified UNKNOWN rather than guessed into
  // a bucket, so it gets no controls rather than another state's controls.
  it('an unknown status offers nothing rather than guessing', () => {
    expect(actionsOf('unknown')).toEqual([]);
  });
});

describe('the confirm copy', () => {
  it('is future tense and never repeats the button the operator already pressed', () => {
    for (const state of ['scheduled', 'onMyWay', 'arrived', 'departed'] as const) {
      for (const def of lifecycleActionsFor(state)) {
        expect(def.confirmLabel).not.toBe(def.label);
        expect(def.confirmBody('The Whitfields')).not.toBe('');
      }
    }
  });

  it('names the household in the copy that promises to notify them', () => {
    const arrived = lifecycleActionsFor('onMyWay')[0]!;
    expect(arrived.confirmBody('The Whitfields')).toContain('The Whitfields');
  });

  // Undoing is the operator correcting their own record. Nothing is sent, and
  // the copy has to say so, or the operator will not use it when they should.
  it('says plainly that an undo notifies nobody', () => {
    const undo = lifecycleActionsFor('arrived').find((a) => a.action === 'UNDO_ARRIVAL')!;
    expect(undo.confirmBody('The Whitfields')).toMatch(/nobody is notified/i);
  });
});

describe('appendOfficeNote', () => {
  const NOW = '2026-08-24T14:23:00Z';

  it('stamps the Android format exactly', () => {
    expect(appendOfficeNote('', 'Gate is stuck.', NOW)).toBe(
      '[2026-08-24T14:23:00Z] (office) Gate is stuck.',
    );
  });

  // Newest first: every notes preview in both apps shows the head of the string,
  // so appending would bury the note the office needs to see.
  it('prepends, keeping earlier notes verbatim below it', () => {
    expect(appendOfficeNote('Earlier note.\nOlder still.', 'New thing.', NOW)).toBe(
      '[2026-08-24T14:23:00Z] (office) New thing.\nEarlier note.\nOlder still.',
    );
  });

  it('trims the addition but never the notes it is prepended to', () => {
    expect(appendOfficeNote('Keep   this  spacing.', '  padded  ', NOW)).toBe(
      '[2026-08-24T14:23:00Z] (office) padded\nKeep   this  spacing.',
    );
  });

  it('is a no-op on a blank addition, matching Android’s defensive branch', () => {
    expect(appendOfficeNote('Existing.', '', NOW)).toBe('Existing.');
    expect(appendOfficeNote('Existing.', '   ', NOW)).toBe('Existing.');
  });

  it('treats whitespace-only existing notes as empty rather than stacking a blank line', () => {
    expect(appendOfficeNote('   \n  ', 'First real note.', NOW)).toBe(
      '[2026-08-24T14:23:00Z] (office) First real note.',
    );
  });
});

describe('lifecycleNowIso', () => {
  // Android's `nowIso()` is whole seconds with a Z. A millisecond precision here
  // would make the same note read as two different formats depending on which
  // app wrote it.
  it('is a whole-second UTC instant, like Android’s nowIso()', () => {
    expect(lifecycleNowIso(new Date('2026-08-24T14:23:45.678Z'))).toBe('2026-08-24T14:23:45Z');
  });

  it('defaults to now and still has no sub-second part', () => {
    expect(lifecycleNowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
