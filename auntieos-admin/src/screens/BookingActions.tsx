import { useCallback, useState } from 'react';
import { type BookingEntry } from '../api/bookings';
import {
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
} from '../api/bookingsWrite';
import { bookingState, bookingStateInfo, bookingWhen, type BookingState } from '../lib/bookingFormat';
import { Dialog } from '../components/Dialog';
import { Banner } from '../components/Banner';
import { DenPanel, EmptyHint } from '../components/DenScreenKit';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import './BookingActions.css';

/**
 * WHO STILL USES WHAT IN THIS FILE (read before editing):
 *
 *   `BookingStatusActions` (bottom of the file) is the LIVE surface. It is the
 *   same Approve / Reject / Cancel / Mark Completed decision, rendered as an
 *   in-sheet PANEL rather than its own dialog, and it is what Bookings.tsx
 *   composes into `BookingDetailModal` now that a row opens the full detail
 *   sheet instead of the thin dialog below.
 *
 *   `BookingActions` (the dialog) has NO app caller since that rewiring. It is
 *   kept, not deleted: deleting a working write surface is a separate decision
 *   from moving where it is reached from, and its own suite still pins the
 *   transition semantics both surfaces share. Do not wire it back into
 *   Bookings.tsx without deciding what happens to the sheet.
 *
 * Both read the state through the same POSITIVE, enumerated `bookingState`
 * (never a negation) and offer actions from the same `actionsFor` map, so what
 * is offered can never drift from the chip the operator is looking at, and the
 * two surfaces can never drift from each other.
 */

/**
 * The Bookings write surface: Approve / Reject / Cancel / Mark Completed /
 * Reschedule on ONE `kin_care_sessions` row.
 *
 * `entry` is the row straight out of a live BOOKINGS_QUERY listener, not a
 * second fetch: the moment a write here round-trips through Firestore, the SAME
 * listener updates `entry` and this dialog reflects the new status without any
 * extra plumbing. `entry === null` means the id no longer resolves to a row
 * (deleted, or a stale id), which gets its own honest "unavailable" dialog
 * rather than rendering a blank or fabricated detail.
 */
export interface BookingActionsProps {
  entry: BookingEntry | null;
  onClose: () => void;
}

/** The four transitions, by name, so a card can ask the sheet to pose one. */
export type BookingActionKind = 'approve' | 'reject' | 'cancel' | 'complete';

interface ActionDef {
  kind: BookingActionKind;
  label: string;
  tone: 'primary' | 'ghost';
  confirmTitle: string;
  confirmBody: (displayName: string) => string;
  confirmLabel: string;
  run: (bookingId: string) => Promise<void>;
}

/**
 * CONFIRM COPY IS WRITTEN IN THE FUTURE TENSE, AND THE CONFIRM BUTTON NEVER
 * REPEATS THE TRIGGER'S LABEL. Both rules exist because of the same walk.
 *
 * The panel below used to render only `confirmBody`, and that copy was in the
 * present tense. Pressing "Mark Completed" replaced the buttons with the
 * sentence "Sandy Demo's visit is marked Completed." beside a second button
 * also labelled "Mark Completed". The operator read the sentence as a report
 * that the write had happened and the button as the CTA coming back, pressed
 * Back, and moved on. Marks 6 through 9 of the 2026-08-17 admin walk are that
 * one misreading: 20 minutes on /bookings, 74 network requests, and not one
 * call to `transitionBookingStatus`. Then "why does it still say Scheduled".
 *
 * So a confirm body says what WILL happen, and a confirm label is never a
 * string the operator has already pressed once.
 */

const APPROVE: ActionDef = {
  kind: 'approve',
  label: 'Approve',
  tone: 'primary',
  confirmTitle: 'Approve this booking?',
  confirmBody: (name) => `${name}'s request will move to Scheduled and appear on the calendar.`,
  confirmLabel: 'Yes, approve it',
  run: approveBooking,
};

const REJECT: ActionDef = {
  kind: 'reject',
  label: 'Reject',
  tone: 'ghost',
  confirmTitle: 'Reject this booking?',
  confirmBody: (name) => `${name}'s request will be cancelled. This cannot be undone.`,
  confirmLabel: 'Yes, reject it',
  run: rejectBooking,
};

const CANCEL: ActionDef = {
  kind: 'cancel',
  label: 'Cancel',
  tone: 'ghost',
  confirmTitle: 'Cancel this scheduled visit?',
  confirmBody: (name) => `${name}'s visit will be cancelled. This cannot be undone.`,
  confirmLabel: 'Yes, cancel the visit',
  run: cancelBooking,
};

const COMPLETE: ActionDef = {
  kind: 'complete',
  label: 'Mark Completed',
  tone: 'primary',
  confirmTitle: 'Mark this visit completed?',
  confirmBody: (name) => `${name}'s visit will be marked Completed and leave the scheduled list.`,
  confirmLabel: 'Yes, mark it completed',
  run: (id) => markBookingCompleted(id, new Date().toISOString()),
};

/**
 * Which actions apply to a state, a positive per-state map (never derived by
 * elimination, the same discipline lib/bookingFormat.ts's `bookingState`
 * itself follows). `draft`/`pending` are the two pre-visit outcomes
 * BookingCreateScreen writes (see bookingFormat.ts); `scheduled` is the one
 * live, actionable post-approval state. `completed` / `cancelled` / `unknown`
 * all resolve to no actions, matching KebabMenu's own `terminal` guard in
 * KinCareSessionsScreen.kt (`if (terminal) return`, no menu at all), extended
 * here to `unknown` too, since offering an action against a status this app
 * does not recognize would be a guess, not a read.
 */
function actionsFor(state: BookingState): ActionDef[] {
  switch (state) {
    case 'draft':
    case 'pending':
      return [APPROVE, REJECT];
    case 'scheduled':
      return [COMPLETE, CANCEL];
    case 'completed':
    case 'cancelled':
    case 'unknown':
      return [];
  }
}

type Mode = { kind: 'detail' } | { kind: 'confirm'; action: ActionDef } | { kind: 'reschedule' };

/** `startTime`/`endTime` are opaque strings on this doc (see BookingEntry's own
 * doc); this only prefills the reschedule form when the existing value happens
 * to parse, and leaves it blank rather than guessing at an unparseable one. */
function toDatetimeLocal(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BookingActions({ entry, onClose }: BookingActionsProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'detail' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  if (!entry) {
    return (
      <Dialog title="Booking unavailable" onClose={onClose} footer={<GhostButton label="Done" onClick={onClose} />}>
        <p className="booking-actions__hint">
          This booking is no longer available. It may have been cancelled or removed.
        </p>
      </Dialog>
    );
  }

  // Re-bound to a variable TS can prove is never null inside the nested
  // functions below: control-flow narrowing from the `if (!entry)` guard above
  // does not cross a function boundary (TS's own rule, `const` or not), so the
  // closures reference this alias rather than the narrowed-only `entry`.
  const booking = entry;
  // Every field defaulted AT THE READ. BookingEntry's fields are optional
  // because the documents really are missing them (`serviceType` is absent on
  // 76 of the 99 live sessions); tsc enforces this now rather than letting it
  // become a white screen.
  const state = bookingState({ status: booking.status ?? '' });
  const info = bookingStateInfo(state);
  const kinfolkName = booking.kinfolkName ?? '';
  const displayName = kinfolkName.trim() !== '' ? kinfolkName : 'Unnamed Kinfolk';
  const when = bookingWhen(booking);
  const kinfolkNotes = booking.kinfolkNotes ?? '';
  const noteText = kinfolkNotes.trim() !== '' ? kinfolkNotes : (booking.notes ?? '');
  const actions = actionsFor(state);
  const canReschedule = state === 'scheduled';

  const closeIfIdle = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  function backToDetail() {
    if (busy) return;
    setError(null);
    setMode({ kind: 'detail' });
  }

  function openConfirm(action: ActionDef) {
    setError(null);
    setMode({ kind: 'confirm', action });
  }

  function openReschedule() {
    setError(null);
    setStartTime(toDatetimeLocal(booking.startTime ?? ''));
    setEndTime('');
    setMode({ kind: 'reschedule' });
  }

  async function runAction(action: ActionDef) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action.run(booking._id);
      setBusy(false);
      onClose();
    } catch (err) {
      setBusy(false);
      setError(`${action.kind} failed: ${err instanceof Error ? err.message : 'Write failed'}`);
    }
  }

  async function submitReschedule() {
    if (busy) return;
    if (startTime.trim() === '' || endTime.trim() === '') {
      setError('Pick both a start and end time.');
      return;
    }
    if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
      setError('End time must be after the start time.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rescheduleBooking(booking._id, startTime, endTime);
      setBusy(false);
      onClose();
    } catch (err) {
      setBusy(false);
      setError(`rescheduleBooking failed: ${err instanceof Error ? err.message : 'Write failed'}`);
    }
  }

  if (mode.kind === 'confirm') {
    const { action } = mode;
    return (
      <Dialog
        title={action.confirmTitle}
        onClose={closeIfIdle}
        footer={
          <>
            <GhostButton label="Back" onClick={backToDetail} disabled={busy} />
            <PrimaryButton
              label={busy ? 'Working…' : action.confirmLabel}
              onClick={() => void runAction(action)}
              busy={busy}
              disabled={busy}
            />
          </>
        }
      >
        <p className="booking-actions__hint">{action.confirmBody(displayName)}</p>
        {error !== null && (
          <p className="booking-actions__error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    );
  }

  if (mode.kind === 'reschedule') {
    return (
      <Dialog
        title="Reschedule this visit"
        onClose={closeIfIdle}
        footer={
          <>
            <GhostButton label="Back" onClick={backToDetail} disabled={busy} />
            <PrimaryButton
              label={busy ? 'Saving…' : 'Save new time'}
              onClick={() => void submitReschedule()}
              busy={busy}
              disabled={busy}
            />
          </>
        }
      >
        <label className="booking-actions__field">
          <span>Start</span>
          <input
            type="datetime-local"
            value={startTime}
            disabled={busy}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </label>
        <label className="booking-actions__field">
          <span>End</span>
          <input
            type="datetime-local"
            value={endTime}
            disabled={busy}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </label>
        {error !== null && (
          <p className="booking-actions__error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`${displayName} · booking`}
      onClose={onClose}
      footer={
        <>
          {/* "Done", never "Close": Dialog's own header X already carries the
              accessible name "Close" (Dialog.tsx's aria-label), so a second
              button with the same name would be ambiguous to anyone (or any
              test) querying by accessible name. */}
          <GhostButton label="Done" onClick={onClose} />
          {canReschedule && <GhostButton label="Reschedule" onClick={openReschedule} />}
          {actions.map((action) =>
            action.tone === 'primary' ? (
              <PrimaryButton key={action.kind} label={action.label} onClick={() => openConfirm(action)} />
            ) : (
              <GhostButton key={action.kind} label={action.label} onClick={() => openConfirm(action)} />
            ),
          )}
        </>
      }
    >
      <p className={`booking-actions__chip booking-actions__chip--${info.cssClass}`}>{info.chipLabel}</p>
      <dl className="booking-actions__meta">
        <div>
          <dt>Service</dt>
          <dd>{(booking.serviceType ?? '').trim() !== '' ? booking.serviceType : 'Visit'}</dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{when}</dd>
        </div>
        {noteText.trim() !== '' && (
          <div>
            <dt>Notes</dt>
            <dd>{noteText}</dd>
          </div>
        )}
      </dl>
      {actions.length === 0 && (
        <p className="booking-actions__hint">
          {state === 'unknown'
            ? `This booking's status ("${booking.status}") isn't recognized, so no actions are offered.`
            : 'This booking has reached a final state. No further actions apply.'}
        </p>
      )}
    </Dialog>
  );
}

// ── the same decision, as a panel ────────────────────────────────────────────

export interface BookingStatusActionsProps {
  /** The row, by value, from the caller's own live `kin_care_sessions` listener. */
  entry: BookingEntry;
  /**
   * Called once a transition has LANDED. The caller closes its sheet from here,
   * matching what the dialog above does on success and what the sheet's own
   * `ReschedulePanel` already does: the write is confirmed, and the list
   * listener carries the new status back on its own.
   */
  onDone: () => void;
  /**
   * A transition to pose the confirm question for ON MOUNT, from a Bookings
   * card's own Approve / Reject / Cancel button (#755: the mock draws those on
   * the card, and the filename directive says a card opens the fuller record,
   * so the button opens the sheet here with the question already up). Only
   * honoured when `actionsFor` offers that kind for the row's CURRENT state: a
   * card pressed a moment before the listener moved the row on opens the sheet
   * with no question rather than posing one the state no longer allows.
   */
  initialAction?: BookingActionKind | null | undefined;
}

/**
 * Approve / Reject / Cancel / Mark Completed on one `kin_care_sessions` row,
 * rendered as a `DenPanel` so it can be composed INTO `BookingDetailModal`
 * (which is a Dialog) instead of being a second, competing dialog. Same
 * `actionsFor` map, same `api/bookingsWrite` calls, same confirm copy as the
 * dialog above; only the container and the confirm STEP differ, which swaps
 * into this panel in place rather than pushing a nested modal.
 *
 * Reschedule is deliberately NOT here: the sheet this panel lives in already
 * owns a full reschedule panel (date + time, end recomputed from the service
 * duration), which is strictly more than the dialog's two datetime fields. Two
 * reschedule controls in one sheet would be the only way to "lose" nothing by
 * duplicating something.
 */
export function BookingStatusActions({ entry, onDone, initialAction }: BookingStatusActionsProps) {
  const state = bookingState({ status: entry.status ?? '' });
  const actions = actionsFor(state);
  const [confirming, setConfirming] = useState<ActionDef | null>(
    () => actions.find((a) => a.kind === initialAction) ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kinfolkName = entry.kinfolkName ?? '';
  const displayName = kinfolkName.trim() !== '' ? kinfolkName : 'Unnamed Kinfolk';

  async function run(action: ActionDef) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action.run(entry._id);
      setBusy(false);
      onDone();
    } catch (err) {
      // Fail loud, and stay on the confirm step: the operator sees which
      // transition failed next to the reason, rather than a bare list of
      // buttons that gives no clue which one they just pressed.
      setBusy(false);
      setError(`${action.kind} failed: ${err instanceof Error ? err.message : 'Write failed'}`);
    }
  }

  return (
    <DenPanel title="Actions" subtitle="What this booking can move to from here." headingLevel={3}>
      {actions.length === 0 ? (
        <EmptyHint>
          {state === 'unknown'
            ? `This booking's status ("${entry.status ?? ''}") isn't recognized, so no actions are offered.`
            : 'This booking has reached a final state. No further actions apply.'}
        </EmptyHint>
      ) : confirming === null ? (
        <div className="booking-actions__row">
          {actions.map((action) =>
            action.tone === 'primary' ? (
              <PrimaryButton
                key={action.kind}
                label={action.label}
                onClick={() => {
                  setError(null);
                  setConfirming(action);
                }}
              />
            ) : (
              <GhostButton
                key={action.kind}
                label={action.label}
                onClick={() => {
                  setError(null);
                  setConfirming(action);
                }}
              />
            ),
          )}
        </div>
      ) : (
        <>
          {/* The question, rendered. The dialog above has always shown
              `confirmTitle` (it is the Dialog's own title); this panel showed
              only the body, which is how a confirm step came to look exactly
              like the state before it. */}
          <p className="booking-actions__confirmTitle" role="heading" aria-level={3}>
            {confirming.confirmTitle}
          </p>
          <p className="booking-actions__confirm">{confirming.confirmBody(displayName)}</p>
          <div className="booking-actions__row">
            <GhostButton
              label="Back"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setError(null);
                setConfirming(null);
              }}
            />
            <PrimaryButton
              label={busy ? 'Working…' : confirming.confirmLabel}
              onClick={() => void run(confirming)}
              busy={busy}
              disabled={busy}
            />
          </div>
        </>
      )}

      {error !== null && (
        <Banner tone="error" title="That change did not go through">
          {error}
        </Banner>
      )}
    </DenPanel>
  );
}
