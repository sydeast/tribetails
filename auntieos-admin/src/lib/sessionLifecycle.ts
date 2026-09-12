import { type SessionState } from './sessionFormat';
import { type VisitLifecycleAction } from '../api/sessionsWrite';

/**
 * WHAT THE AUNTIE TIME DETAIL OFFERS, and the one text transform it applies.
 *
 * Pure functions with their own tests, deliberately separate from the screen,
 * the same way `lib/sessionFormat.ts` owns the read-side classification the
 * screen renders. Two things live here:
 *
 *   `lifecycleActionsFor`  which clock buttons a given state shows
 *   `appendOfficeNote`     the timestamped note format
 *
 * THE BUTTON LIST IS A COURTESY, NOT THE ENFORCEMENT, and that distinction is
 * load-bearing enough to repeat wherever it applies. This map exists so the
 * operator is not shown a control that will fail -- exactly what Android's
 * `LifecycleButton` `enabled = ... && status == ...` gates are, and it is
 * transcribed from them rather than re-derived.
 *
 * WHERE THE REAL GUARD IS DEPENDS ON THE ACTION, and this used to be one
 * sentence pointing at `functions/src/lib/visitLifecycle.ts`. Since the field
 * tap stopped paying a Cloud Run cold start it is two:
 *
 *   the four in-visit actions   `mytribe/firestore.rules:487`. The web clock
 *                               writes them straight to the document now
 *                               (`api/sessionsWrite.ts#patchVisitLifecycle`),
 *                               so the rules are what refuse a client anything
 *                               terminal. `lib/visitLifecyclePatch.ts` runs the
 *                               state machine before the write, which catches a
 *                               stale row this browser can see but not one it
 *                               cannot -- that is the accepted cost, and it is
 *                               Android's cost too.
 *   COMPLETE / CANCEL           `transitionBookingStatus`, server-side and
 *                               audited inside the write, unchanged.
 *
 * `functions/src/lib/visitLifecycle.ts` is still the authority behind the
 * `setVisitLifecycle` callable, which is still deployed and still correct. It
 * is simply no longer what a button press goes through.
 */

export interface LifecycleActionDef {
  action: VisitLifecycleAction;
  /** The label on the SessionDetail sheet, where the framing is the office clock. */
  label: string;
  /**
   * The same action's label on an Auntie Time CARD. The board is the day-of run
   * sheet, and the mock spells the clock in the words the operator uses at the
   * door: OMW, Arrived, Departed, Undo arrived. Transcribed from
   * `ui-ideas/auntieos-auntie-time-2026-05-27.html`.
   *
   * A second field rather than a rename: "Clock in" / "Clock out" is what the
   * detail sheet has said since #397 L19, and it is the right phrasing beside a
   * lifecycle stepper of stamped clock times. One action, two surfaces, two
   * vocabularies, one definition.
   */
  cardLabel: string;
  tone: 'primary' | 'ghost';
  /** Future tense, per the BookingActions confirm-copy rule. */
  confirmBody: (household: string) => string;
  confirmLabel: string;
}

const ON_MY_WAY: LifecycleActionDef = {
  action: 'ON_MY_WAY',
  label: 'On the way',
  cardLabel: 'OMW',
  tone: 'primary',
  confirmBody: (name) =>
    `${name} will be told their Auntie is on the way, and the visit moves to On the way.`,
  confirmLabel: 'Yes, mark it on the way',
};

const ARRIVED: LifecycleActionDef = {
  action: 'ARRIVED',
  label: 'Clock in',
  cardLabel: 'Arrived',
  tone: 'primary',
  confirmBody: (name) =>
    `The arrival time is stamped now and ${name} is told their Auntie has arrived.`,
  confirmLabel: 'Yes, clock in',
};

const DEPARTED: LifecycleActionDef = {
  action: 'DEPARTED',
  label: 'Clock out',
  cardLabel: 'Departed',
  tone: 'primary',
  confirmBody: (name) =>
    `The departure time is stamped now and ${name} is told the visit has finished. The visit is not Completed until you mark it so.`,
  confirmLabel: 'Yes, clock out',
};

const UNDO_ARRIVAL: LifecycleActionDef = {
  action: 'UNDO_ARRIVAL',
  label: 'Undo arrival',
  cardLabel: 'Undo arrived',
  tone: 'ghost',
  confirmBody: () =>
    'The arrival and departure times are cleared and the visit goes back to where it was. Nobody is notified.',
  confirmLabel: 'Yes, undo the arrival',
};

/**
 * The clock actions offered from one state.
 *
 * TRANSCRIBED FROM `HomeScreen.kt#TodayVisitCardView` plus Auntie Time's
 * "Undo Arrival" (`ui/admin/KinCareSessionsScreen.kt#ActionRow`):
 *
 *   scheduled  On the way (Android: enabled at SCHEDULED)
 *              Clock in   (Android: enabled at SCHEDULED **or** ON_MY_WAY --
 *                          an Auntie already at the door has no on-my-way to
 *                          declare, and Android does not make her fake one)
 *   onMyWay    Clock in
 *   arrived    Clock out, Undo arrival
 *   departed   Undo arrival  (Android offers undo from DEPARTED too; it does
 *                          NOT offer a re-clock-in, which is why ARRIVED is
 *                          absent here -- undo first, then clock in again)
 *
 * NOTHING for completed / cancelled / unknown. A terminal visit's clock is
 * closed, and an unrecognized status is classified UNKNOWN rather than guessed
 * into a bucket (the AO-12 discipline), so it gets no controls at all rather
 * than the controls of whichever state it might have been.
 */
export function lifecycleActionsFor(state: SessionState): readonly LifecycleActionDef[] {
  switch (state) {
    case 'scheduled':
      return [ON_MY_WAY, ARRIVED];
    case 'onMyWay':
      return [ARRIVED];
    case 'arrived':
      return [DEPARTED, UNDO_ARRIVAL];
    case 'departed':
      return [UNDO_ARRIVAL];
    case 'completed':
    case 'cancelled':
    case 'unknown':
      return [];
  }
}

/**
 * The clock actions an Auntie Time CARD offers, which is the same map as
 * `lifecycleActionsFor` in every state but one.
 *
 * DEPARTED shows no clock action on the board. The mock's departed card carries
 * "Complete KinTale" alone, and that is the right reading of what the board is
 * for: a visit that is already clocked out is finished from the operator's
 * point of view, and the run sheet's next move on it is the write-up. Undoing
 * an arrival at that point is a correction, not a step, and corrections belong
 * on the detail sheet, which still offers it (a card is one click from there).
 *
 * `Complete`, `Complete KinTale` and `View KinTale` are NOT in this list and
 * never will be: they are not in-visit clock actions at all. Complete goes
 * through `transitionBookingStatus` (terminal and billable, the server owns
 * it) and the two KinTale buttons are navigation. `Sessions.tsx` owns those
 * three.
 */
export function cardLifecycleActionsFor(state: SessionState): readonly LifecycleActionDef[] {
  if (state === 'departed') return [];
  return lifecycleActionsFor(state);
}

/**
 * Appends a timestamped office note to a session's existing `notes`.
 *
 * PORTS `ui/admin/KinCareSessionsScreen.kt#appendOfficeNote`, format included:
 *
 *     [2026-05-19T14:23:00Z] (office) {body}
 *
 * Newest FIRST -- the new line is prepended -- because every notes preview in
 * both apps shows the head of the string, so appending would bury the note the
 * office needs to see behind however many came before it.
 *
 * `nowIso` is a parameter rather than a `new Date()` inside, so the format is
 * testable without freezing the clock, and it is stamped to whole seconds with
 * a `Z` suffix exactly as Android's `nowIso()` does
 * (`Instant.now().toString().substringBefore('.') + "Z"`) -- a millisecond
 * precision that differed between the two clients would make the same note look
 * like two different formats depending on which app wrote it.
 *
 * A blank addition is a no-op that returns the existing notes untouched. The
 * caller gates on non-blank already; this is the defensive half, matching
 * Android's `if (trimmedAdd.isBlank()) return existing`.
 */
export function appendOfficeNote(existing: string, addition: string, nowIso: string): string {
  const trimmed = addition.trim();
  if (trimmed === '') return existing;
  const stamped = `[${nowIso}] (office) ${trimmed}`;
  return existing.trim() === '' ? stamped : `${stamped}\n${existing}`;
}

/**
 * Android's `nowIso()`: a UTC instant truncated to whole seconds. Kept here
 * beside `appendOfficeNote`, which is the only thing whose STORED format
 * depends on it.
 */
export function lifecycleNowIso(now: Date = new Date()): string {
  return `${now.toISOString().split('.')[0]}Z`;
}
