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
 * The point of moving the rule server-side: a client that sends anyway is
 * rejected. Every case below sends a note the UI would have blocked.
 */
describe('addInternalBookingNote enforces the cutoff server-side', () => {
  afterEach(() => vi.restoreAllMocks());

  const startMs = Date.parse('2026-07-16T19:00:00.000Z');

  function seedVisit() {
    const ctx = buildDbMock({ docs: { [VISIT_PATH]: { startTime: new Date(startMs) } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    return ctx;
  }

  function pinClock(nowMs: number) {
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  }

  it('HAPPY: accepts a note outside the window', async () => {
    const ctx = seedVisit();
    pinClock(startMs - NOTE_CUTOFF_MS - 1);
    const res = await addInternalBookingNoteHandler(
      adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'gate code changed' }),
    );
    expect(res.noteId).toMatch(/^auto-/);
    expect(ctx.adds.find((a) => a.collection.endsWith('/internalNotes'))).toBeDefined();
  });

  it('SAD: rejects a note the client sent from INSIDE the window anyway', async () => {
    const ctx = seedVisit();
    pinClock(startMs - 60 * 60 * 1000); // one hour out, well inside
    await expect(
      addInternalBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'too late' }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: NOTE_CUTOFF_CODE } });
    // And nothing was written: the guard runs before the add, not after.
    expect(ctx.adds.find((a) => a.collection.endsWith('/internalNotes'))).toBeUndefined();
  });

  it('BOUNDARY: open at cutoff minus 1ms, closed exactly at the cutoff', async () => {
    seedVisit();
    pinClock(startMs - NOTE_CUTOFF_MS - 1);
    await expect(
      addInternalBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'just in time' }),
      ),
    ).resolves.toMatchObject({ noteId: expect.stringMatching(/^auto-/) });

    seedVisit();
    pinClock(startMs - NOTE_CUTOFF_MS);
    await expect(
      addInternalBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'one millisecond late' }),
      ),
    ).rejects.toMatchObject({ details: { code: NOTE_CUTOFF_CODE } });
  });

  it('SAD: rejects once the visit has already started', async () => {
    seedVisit();
    pinClock(startMs + 60_000);
    await expect(
      addInternalBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'mid-visit' }),
      ),
    ).rejects.toMatchObject({ details: { code: NOTE_CUTOFF_CODE } });
  });

  it('accepts when the visit has no readable start, same as the kinfolk-facing thread', async () => {
    const ctx = buildDbMock({ docs: { [VISIT_PATH]: { startTime: 'whenever' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addInternalBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'undated visit' }),
      ),
    ).resolves.toMatchObject({ noteId: expect.stringMatching(/^auto-/) });
  });
});

/**
 * Both threads must behave IDENTICALLY when locked, so a client can render one
 * message for either. This asserts they reject with the same code and text
 * rather than trusting that two call sites of one helper stay in step.
 */
describe('both note callables reject identically when locked', () => {
  afterEach(() => vi.restoreAllMocks());

  const startMs = Date.parse('2026-07-16T19:00:00.000Z');

  async function rejectionOf(run: () => Promise<unknown>) {
    try {
      await run();
      expect.unreachable('expected the cutoff to reject');
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: { code?: string } };
      return { code: e.code, message: e.message, detailCode: e.details?.code };
    }
  }

  it('same code, same message, same detail code', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(startMs - 60 * 60 * 1000);

    const ctxA = buildDbMock({ docs: { [VISIT_PATH]: { startTime: new Date(startMs) } } });
    mocks.dbFn.mockReturnValue(ctxA.db);
    const kinfolkFacing = await rejectionOf(() =>
      addBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'late' }),
      ),
    );

    const ctxB = buildDbMock({ docs: { [VISIT_PATH]: { startTime: new Date(startMs) } } });
    mocks.dbFn.mockReturnValue(ctxB.db);
    const internal = await rejectionOf(() =>
      addInternalBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'late' }),
      ),
    );

    expect(internal).toEqual(kinfolkFacing);
    expect(internal.detailCode).toBe(NOTE_CUTOFF_CODE);
  });
});
