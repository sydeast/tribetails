import { useEffect, useState } from 'react';
import { call } from './fns';

/**
 * #2250, operator ruling 2026-11-14: "A short Undo departed. For a few minutes
 * after Departed, Undo departed puts the visit back to Arrived; the household
 * is not told."
 *
 * A departure completes the visit on the server (#2123), and the rules refuse
 * every client the move back, so the undo is the `setVisitLifecycle` callable's
 * `UNDO_DEPARTED` action for the owner and for an Auntie alike. It needs a
 * connection, and it pays that callable's cold start: the button says it is
 * waiting.
 *
 * NO NUMBER LIVES HERE. How long "a few minutes" is belongs to the server
 * (`functions/src/lib/visitLifecycle.ts#UNDO_DEPARTED_WINDOW_MS`). The
 * departure trigger stamps the moment the undo closes on the visit as
 * `undoDepartedUntil`, and this module only compares that moment with now.
 */

/** The two fields of a visit this reads. `SessionEntry` satisfies it. */
export interface UndoDepartedSession {
  status?: unknown;
  undoDepartedUntil?: unknown;
}

/** When this visit's undo closes, in ms, or null when the server opened none. */
export function undoDepartedUntilMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** PURE. Is "Undo departed" offered on this visit at `nowMs`? */
export function undoDepartedOpen(session: UndoDepartedSession, nowMs: number): boolean {
  const status = typeof session.status === 'string' ? session.status.trim().toUpperCase() : '';
  if (status !== 'DEPARTED' && status !== 'COMPLETED') return false;
  const until = undoDepartedUntilMs(session.undoDepartedUntil);
  return until !== null && nowMs <= until;
}

/**
 * The same answer, kept true while the screen stays open: one timer set for
 * the moment the undo closes, so the button goes without a reload.
 */
export function useUndoDepartedOpen(session: UndoDepartedSession): boolean {
  const status = session.status;
  const until = undoDepartedUntilMs(session.undoDepartedUntil);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (until === null) return undefined;
    const left = until - Date.now();
    if (left < 0) return undefined;
    // One ms past the moment, so the re-render reads it as closed.
    const timer = setTimeout(() => setTick((n) => n + 1), left + 1);
    return () => clearTimeout(timer);
  }, [until]);
  return undoDepartedOpen({ status, undoDepartedUntil: session.undoDepartedUntil }, Date.now());
}

/** What the callable answers. Mirrors `setVisitLifecycle`'s `Result`. */
export interface UndoDepartedResult {
  ok: true;
  sessionId: string;
  /** The status the visit holds now: `ARRIVED`. */
  status: string;
  /** False when the visit was already back at Arrived and nothing was written. */
  changed: boolean;
}

/**
 * Take one departure back. THROWS with the sentence to show already in
 * `err.message`: the server writes it for a refusal (the time has passed, no
 * arrival on record), and `call` writes it for a lost connection.
 */
export async function undoDeparted(sessionId: string): Promise<UndoDepartedResult> {
  return call<{ sessionId: string; action: 'UNDO_DEPARTED' }, UndoDepartedResult>('setVisitLifecycle', {
    sessionId,
    action: 'UNDO_DEPARTED',
  });
}
