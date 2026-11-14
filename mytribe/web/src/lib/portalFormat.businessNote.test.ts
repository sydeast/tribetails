import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { businessNoteHeading, businessNoteWrittenAt } from './portalFormat';

/**
 * #2030: the time on a note from the office is on the business's clock
 * (America/Chicago), not the device's. The device is put in Tokyo here, so a
 * formatter that read the device clock would print a different day and hour.
 */
describe('businessNoteWrittenAt / businessNoteHeading on a device away from the business', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it('prints the business clock in 12-hour form', () => {
    // 21:05 UTC on Nov 2 is 3:05 PM in Chicago (CST) and 6:05 AM Nov 3 in Tokyo.
    expect(businessNoteWrittenAt(Date.UTC(2026, 10, 2, 21, 5))).toBe('Nov 2, 3:05 PM');
    // Midnight and noon edges.
    expect(businessNoteWrittenAt(Date.UTC(2026, 10, 2, 6, 0))).toBe('Nov 2, 12:00 AM');
    expect(businessNoteWrittenAt(Date.UTC(2026, 10, 2, 18, 0))).toBe('Nov 2, 12:00 PM');
    // Summer time: 20:05 UTC on Jul 4 is 3:05 PM in Chicago (CDT).
    expect(businessNoteWrittenAt(Date.UTC(2026, 6, 4, 20, 5))).toBe('Jul 4, 3:05 PM');
  });

  it('heads the note with what it is, who wrote it and the business time', () => {
    const ms = Date.UTC(2026, 10, 2, 21, 5);
    expect(businessNoteHeading({ kind: 'requestAccepted', createdAtMs: ms, authorName: 'Syd' }, 'Test Business')).toBe(
      'Booked · Syd · Nov 2, 3:05 PM',
    );
    expect(businessNoteHeading({ kind: 'requestDeclined', createdAtMs: null, authorName: '  ' }, 'Test Business')).toBe(
      'Not booked · Test Business',
    );
  });
});
