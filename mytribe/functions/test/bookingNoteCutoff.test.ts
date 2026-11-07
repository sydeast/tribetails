import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import {
  NOTE_CUTOFF_MS,
  NOTE_CUTOFF_CODE,
  NOTE_CUTOFF_MESSAGE,
  visitStartMs,
  noteWindowClosed,
  assertNoteWindowOpen,
} from '../src/lib/bookingNoteCutoff';
import { addInternalBookingNoteHandler } from '../src/admin/addInternalBookingNote';
import { addBookingNoteHandler } from '../src/portal/addBookingNote';

const VISIT_PATH = 'families/f1/bookings/batch1/kinCares/v1';

function adminReq(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * The cutoff rule, shared by BOTH note callables.
 *
 * It used to live only in `addBookingNote`, so the internal thread was guarded
 * by the UI alone. A guard that lives only in the UI is not a guard: another
 * client, a stale bundle, or a direct callable invocation walks straight past
 * it. The two android surfaces had already drifted apart on this exact rule.
 */
describe('bookingNoteCutoff: the shared rule', () => {
  it('is three hours', () => {
    expect(NOTE_CUTOFF_MS).toBe(3 * 60 * 60 * 1000);
  });

  it('exposes ONE error surface for both callables to throw', () => {
    expect(NOTE_CUTOFF_CODE).toBe('booking_note_cutoff');
    expect(NOTE_CUTOFF_MESSAGE).toMatch(/3 hours/);
  });

  describe('visitStartMs reads whatever shape the visit doc actually carries', () => {
    const iso = '2026-07-16T19:00:00.000Z';
    const ms = Date.parse(iso);

    it('reads a Firestore Timestamp', () => {
      expect(visitStartMs({ startTime: Timestamp.fromMillis(ms) })).toBe(ms);
    });

    it('reads a Date', () => {
      expect(visitStartMs({ startTime: new Date(ms) })).toBe(ms);
    });

    it('reads epoch millis', () => {
      expect(visitStartMs({ startTime: ms })).toBe(ms);
    });

    it('reads an ISO string (the shape AuntieOS writes)', () => {
      expect(visitStartMs({ startTime: iso })).toBe(ms);
    });

    it('returns null for absent or unparseable, never a fabricated instant', () => {
      expect(visitStartMs({})).toBeNull();
      expect(visitStartMs({ startTime: 'whenever' })).toBeNull();
      expect(visitStartMs({ startTime: null })).toBeNull();
    });
  });

  /**
   * THE BOUNDARY, asserted rather than left to chance. Three points around the
   * cutoff instant, to the millisecond, so an off-by-one in the comparison
   * (`>` vs `>=`) fails here.
   */
  describe('noteWindowClosed at the exact boundary', () => {
    const startMs = Date.parse('2026-07-16T19:00:00.000Z');
    const visit = { startTime: new Date(startMs) };
    const cutoffInstant = startMs - NOTE_CUTOFF_MS;

    it('is OPEN one millisecond before the cutoff instant', () => {
      expect(noteWindowClosed(visit, cutoffInstant - 1)).toBe(false);
    });

    it('is CLOSED exactly at the cutoff instant', () => {
      expect(noteWindowClosed(visit, cutoffInstant)).toBe(true);
    });

    it('is CLOSED one millisecond after the cutoff instant', () => {
      expect(noteWindowClosed(visit, cutoffInstant + 1)).toBe(true);
    });

    it('stays closed once the visit has started', () => {
      expect(noteWindowClosed(visit, startMs + 60_000)).toBe(true);
    });

    it('is OPEN when the visit has no readable start (nothing to be inside of)', () => {
      expect(noteWindowClosed({}, Date.now())).toBe(false);
    });
  });

  describe('assertNoteWindowOpen', () => {
    const startMs = Date.parse('2026-07-16T19:00:00.000Z');
    const visit = { startTime: new Date(startMs) };

    it('is silent while the window is open', () => {
      expect(() => assertNoteWindowOpen(visit, startMs - NOTE_CUTOFF_MS - 1)).not.toThrow();
    });

    it('throws the typed, renderable error once closed', () => {
      try {
        assertNoteWindowOpen(visit, startMs - NOTE_CUTOFF_MS);
        expect.unreachable('expected the cutoff to reject');
      } catch (err) {
        expect(err).toMatchObject({
          code: 'failed-precondition',
          message: NOTE_CUTOFF_MESSAGE,
          details: { code: NOTE_CUTOFF_CODE },
        });
      }
    });
  });
});

/**
 * #1580: the internal thread no longer freezes. It is now the visit's one
 * internal-notes store, which Auntie Time writes during and after a visit;
 * the cutoff's reason (what the Auntie read at the door is what the household
 * asked for) is about the household's thread, which keeps it, above.
 */
describe('addInternalBookingNote takes staff notes inside the window (#1580)', () => {
  afterEach(() => vi.restoreAllMocks());
  const startMs = Date.parse('2026-07-16T19:00:00.000Z');
  it('accepts a note one hour out and one after the start, where the household thread refuses', async () => {
    for (const nowMs of [startMs - 60 * 60 * 1000, startMs + 60_000]) {
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      const ctxA = buildDbMock({ docs: { [VISIT_PATH]: { startTime: new Date(startMs) } } });
      mocks.dbFn.mockReturnValue(ctxA.db);
      await expect(
        addBookingNoteHandler(adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'late' })),
      ).rejects.toMatchObject({ details: { code: NOTE_CUTOFF_CODE } });
      const ctxB = buildDbMock({ docs: { [VISIT_PATH]: { startTime: new Date(startMs) } } });
      mocks.dbFn.mockReturnValue(ctxB.db);
      await expect(
        addInternalBookingNoteHandler(adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'late' })),
      ).resolves.toMatchObject({ storedOn: 'thread' });
      expect(ctxB.adds.find((a) => a.collection.endsWith('/internalNotes'))).toBeDefined();
      vi.restoreAllMocks();
    }
  });
});
