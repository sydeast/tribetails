import { describe, it, expect } from 'vitest';
import {
  appendOfficeNote,
  readableVisitNotes,
  savedVisitFieldsMessage,
  cardLifecycleActionsFor,
  lifecycleActionsFor,
  lifecycleNowIso,
} from './sessionLifecycle';

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

/**
 * #703: the Auntie Time CARD's own clock row, transcribed from
 * `ui-ideas/auntieos-auntie-time-2026-05-27.html` card by card.
 */
describe('the card labels and the card action map', () => {
  function cardActionsOf(state: Parameters<typeof cardLifecycleActionsFor>[0]): string[] {
    return cardLifecycleActionsFor(state).map((a) => a.cardLabel);
  }

  it('spells the clock in the run-sheet words the mock uses, not the detail sheet’s', () => {
    expect(cardActionsOf('scheduled')).toEqual(['OMW', 'Arrived']);
    expect(cardActionsOf('onMyWay')).toEqual(['Arrived']);
    expect(cardActionsOf('arrived')).toEqual(['Departed', 'Undo arrived']);
  });

  it('leaves the detail sheet’s own office wording alone', () => {
    expect(lifecycleActionsFor('scheduled').map((a) => a.label)).toEqual(['On the way', 'Clock in']);
    expect(lifecycleActionsFor('arrived').map((a) => a.label)).toEqual([
      'Clock out',
      'Undo arrival',
    ]);
  });

  // The mock's departed card carries "Complete KinTale" alone. Undoing an
  // arrival at that point is a correction, not a step, and corrections live on
  // the detail sheet, which still offers it.
  it('offers no clock action on a DEPARTED card, unlike the detail sheet', () => {
    expect(cardActionsOf('departed')).toEqual([]);
    expect(lifecycleActionsFor('departed').map((a) => a.action)).toEqual(['UNDO_ARRIVAL']);
  });

  it('offers nothing on a terminal or unrecognized card', () => {
    expect(cardActionsOf('completed')).toEqual([]);
    expect(cardActionsOf('cancelled')).toEqual([]);
    expect(cardActionsOf('unknown')).toEqual([]);
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

  // #1794: the clock confirms no longer promise the household anything on
  // their own. Whether a notice can be sent depends on the household-notices
  // switch and the household's portal account, so that line is
  // `lib/visitNotice.ts#visitNoticeConfirmLine`'s and the dialog adds it.
  it('the clock confirms describe the visit only, and never promise a notice', () => {
    for (const a of [...lifecycleActionsFor('scheduled'), ...lifecycleActionsFor('onMyWay'), ...lifecycleActionsFor('arrived')]) {
      expect(a.confirmBody('The Whitfields')).not.toMatch(/will be told|is told/i);
    }
  });

  // Undoing is the operator correcting their own record. Nothing is sent, and
  // the copy has to say so, or the operator will not use it when they should.
  // #2123: departure IS completion (operator ruling 2026-11-12), so the
  // clock-out confirm says so and never ties it to the KinTale.
  it('the clock-out confirm says the visit is marked Completed, with no KinTale condition', () => {
    const out = lifecycleActionsFor('arrived').find((a) => a.action === 'DEPARTED')!;
    expect(out.confirmBody('The Whitfields')).toBe(
      'The departure time is stamped now and the visit is marked Completed.',
    );
    expect(out.confirmBody('The Whitfields')).not.toMatch(/kintale/i);
  });

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

describe("#1592: visit notes and saves read in the operator's words", () => {
  const NOW = new Date('2026-11-06T18:00:00Z');

  it('shows a stored stamp as a business-zone time, and leaves the stored text alone', () => {
    const stored = '[2026-11-05T21:32:52Z] (office) Gate code changed';
    expect(readableVisitNotes(stored, 'America/Chicago', NOW)).toBe('[Nov 5, 3:32 PM] (office) Gate code changed');
    expect(stored).toContain('2026-11-05T21:32:52Z');
  });

  it('adds the year to a stamp from another year, and reads every stamp in the notes', () => {
    const stored = '[2026-11-05T21:32:52Z] (office) b\n[2025-03-01T15:00:00Z] (field) a';
    expect(readableVisitNotes(stored, 'America/Chicago', NOW)).toBe(
      '[Nov 5, 3:32 PM] (office) b\n[Mar 1, 2025, 9:00 AM] (field) a',
    );
  });

  it('names saved fields the way the form does, never by their keys', () => {
    expect(savedVisitFieldsMessage(['serviceDurationMinutes'])).toBe('Saved: visit length.');
    expect(savedVisitFieldsMessage(['serviceType', 'kinIds'])).toBe('Saved: service, kin on this visit.');
    expect(savedVisitFieldsMessage(['somethingNew'])).toBe('Saved.');
  });
});
