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
import { PrimaryButton, GhostButton } from '../components/Buttons';
import './BookingActions.css';

/**
 * The Bookings write surface: Approve / Reject / Cancel / Mark Completed /
 * Reschedule on ONE `kin_care_sessions` row, opened from Bookings.tsx's
 * onSelectBooking hook (see that file's wiring). Every transition here is the
 * same POSITIVE, enumerated `BookingState` read the list uses (never a
 * negation), so the actions offered can never drift from the chip the operator
 * is looking at.
 *
 * `entry` is the row straight out of Bookings.tsx's own live BOOKINGS_QUERY
 * listener, not a second fetch: the moment a write here round-trips through
 * Firestore, the SAME listener updates `entry` and this dialog reflects the new
 * status without any extra plumbing. `entry === null` means the id no longer
 * resolves to a row (deleted, or a stale id), which gets its own honest
 * "unavailable" dialog rather than rendering a blank or fabricated detail.
 */
export interface BookingActionsProps {
  entry: BookingEntry | null;
  onClose: () => void;
}

interface ActionDef {
  kind: 'approve' | 'reject' | 'cancel' | 'complete';
  label: string;
  tone: 'primary' | 'ghost';
  confirmTitle: string;
  confirmBody: (displayName: string) => string;
  confirmLabel: string;
  run: (bookingId: string) => Promise<void>;
}

const APPROVE: ActionDef = {
  kind: 'approve',
  label: 'Approve',
  tone: 'primary',
  confirmTitle: 'Approve this booking?',
  confirmBody: (name) => `${name}'s request moves to Scheduled and appears on the calendar.`,
  confirmLabel: 'Approve booking',
  run: approveBooking,
};

const REJECT: ActionDef = {
  kind: 'reject',
  label: 'Reject',
  tone: 'ghost',
  confirmTitle: 'Reject this booking?',
  confirmBody: (name) => `${name}'s request is cancelled. This cannot be undone.`,
  confirmLabel: 'Reject booking',
  run: rejectBooking,
};

const CANCEL: ActionDef = {
  kind: 'cancel',
  label: 'Cancel',
  tone: 'ghost',
  confirmTitle: 'Cancel this scheduled visit?',
  confirmBody: (name) => `${name}'s visit is cancelled. This cannot be undone.`,
  confirmLabel: 'Cancel visit',
  run: cancelBooking,
};

const COMPLETE: ActionDef = {
  kind: 'complete',
  label: 'Mark Completed',
  tone: 'primary',
  confirmTitle: 'Mark this visit completed?',
  confirmBody: (name) => `${name}'s visit is marked Completed.`,
  confirmLabel: 'Mark Completed',
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
