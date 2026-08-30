import { useState } from 'react';
import { rescheduleBooking } from '../api/bookingsWrite';
import { overridableScheduleRefusal, overrideHint } from '../api/scheduleWrite';
import { bookingWhenLabel, durationLabel } from '../lib/bookingDetailFormat';
import {
  bulkRescheduleSummary,
  mergeRescheduleResults,
  planRescheduleWrites,
  rescheduleOverrideLabel,
  type BulkRescheduleOutcome,
  type RescheduleDraft,
  type RescheduleFailure,
  type RescheduleOverride,
  type RescheduleTarget,
  type RescheduleWrite,
} from '../lib/bookingReschedule';
import { type BulkSkip } from '../lib/bookingBulk';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './BulkRescheduleDialog.css';

interface BulkRescheduleDialogProps {
  /** The selected visits that can actually be moved, prefilled by `planBulkReschedule`. */
  targets: readonly RescheduleTarget[];
  /** Selected rows that were never offered a field, with the reason. */
  skipped: readonly BulkSkip[];
  /**
   * Closing hands back what happened, or null when the operator backed out
   * before confirming. The list screen uses it to keep the visits that did not
   * land picked, so a retry is one press and not a re-hunt through the list.
   */
  onClose: (outcome: BulkRescheduleOutcome | null) => void;
}

/**
 * Bulk Reschedule (#397 M16): the per-visit review sheet the mock's fourth bulk
 * button opens.
 *
 * ONE NEW TIME PER VISIT, WHICH IS THE ENTIRE POINT. A bulk bar of one-press
 * verbs cannot express a reschedule, because five selected visits do not share
 * a new window and one delta applied across all of them would move a Tuesday
 * morning and a Friday evening by the same two hours. So the press opens this
 * sheet instead: every selected visit gets its own date and time, prefilled
 * with the window it holds now, the operator adjusts the ones that need
 * adjusting, and confirms once. `rescheduleBooking` is then called once per
 * visit with that visit's own window, which is exactly the shape the callable
 * has always had.
 *
 * A MOVE IS NOT A RESIZE, so each row keeps its own length: the operator picks
 * the new START and `buildRescheduleTimes` derives the end from
 * `visitDurationMinutes`. Same rule as the detail sheet's Reschedule panel and
 * the Schedule grid's drag, so a visit moved from here comes out the same
 * length as one moved from either of those.
 *
 * NOTHING IS SILENTLY SKIPPED. A visit the server refuses is named in the
 * result with the server's own sentence; a visit left at its prefilled time is
 * named as unchanged rather than counted as moved; a selected row that was
 * never eligible is named too. A refusal the operator is allowed to go past
 * gets a per-row override button, offered ONCE: the retry carries
 * `alreadyOverridden`, so a second refusal offers nothing. A company closure
 * has no override on the server and therefore never grows one here.
 */
export function BulkRescheduleDialog({ targets, skipped, onClose }: BulkRescheduleDialogProps) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, RescheduleDraft>>(
    () => new Map(targets.map((t) => [t.id, { date: t.date, time: t.time }])),
  );
  const [running, setRunning] = useState(false);
  /** Set once the sheet has been confirmed: the review turns into the result. */
  const [writes, setWrites] = useState<RescheduleWrite[] | null>(null);
  const [failures, setFailures] = useState<
    ReadonlyMap<string, { reason: string; override: RescheduleOverride | null }>
  >(new Map());
  const [draftSkips, setDraftSkips] = useState<readonly BulkSkip[]>([]);

  const outcome: BulkRescheduleOutcome | null =
    writes === null
      ? null
      : mergeRescheduleResults(writes, failures, [...skipped, ...draftSkips]);

  function setDraft(id: string, patch: Partial<RescheduleDraft>) {
    setDrafts((prev) => {
      const next = new Map(prev);
      const current = next.get(id) ?? { date: '', time: '' };
      next.set(id, { ...current, ...patch });
      return next;
    });
  }

  /**
   * Move every visit whose row actually changed.
   *
   * SEQUENTIAL, not `Promise.all`: each call is a write plus a household
   * notification, and firing forty at once at one operator's press is how a
   * bulk surface turns into a load test. The per-visit result is collected as
   * it comes, so a refusal in the middle stops nothing after it.
   */
  async function run() {
    if (running) return;
    const planned = planRescheduleWrites(targets, drafts);
    setRunning(true);

    const collected = new Map<string, { reason: string; override: RescheduleOverride | null }>();
    for (const write of planned.writes) {
      try {
        await rescheduleBooking(write.target.id, write.times.startTime, write.times.endTime);
      } catch (err) {
        collected.set(write.target.id, {
          reason: err instanceof Error ? err.message : 'The move failed.',
          override: overridableScheduleRefusal(err, false),
        });
      }
    }

    setFailures(collected);
    setDraftSkips(planned.skipped);
    setWrites(planned.writes);
    setRunning(false);
  }

  /**
   * Re-send ONE refused visit with the override that refusal offered.
   *
   * The retry passes `alreadyOverridden: true` into `overridableScheduleRefusal`
   * whatever comes back, so the same losing move is never offered a second
   * time. That is the convention `Schedule.tsx`'s drop retry and Android's
   * `retryScheduleWriteWithOverride` already follow.
   */
  async function retryWithOverride(failure: RescheduleFailure, kind: RescheduleOverride) {
    if (running || writes === null) return;
    const write = writes.find((w) => w.target.id === failure.id);
    if (write === undefined) return;

    setRunning(true);
    try {
      await rescheduleBooking(
        write.target.id,
        write.times.startTime,
        write.times.endTime,
        kind === 'visit' ? { visit: true } : { busy: true },
      );
      setFailures((prev) => {
        const next = new Map(prev);
        next.delete(write.target.id);
        return next;
      });
    } catch (err) {
      setFailures((prev) => {
        const next = new Map(prev);
        next.set(write.target.id, {
          reason: err instanceof Error ? err.message : 'The move failed.',
          override: overridableScheduleRefusal(err, true),
        });
        return next;
      });
    }
    setRunning(false);
  }

  const count = targets.length;

  /**
   * Escape and a backdrop click reach `Dialog`'s own dismiss, which the footer
   * buttons' `disabled` cannot gate. A dismiss mid-run would unmount the sheet
   * while the remaining visits are still being written, and the refusals those
   * writes come back with would have nowhere to render: the operator would be
   * told nothing about writes that really happened. Same guard, and the same
   * reason, as `closeIfIdle` in BookingActions.tsx.
   */
  function closeIfIdle(result: BulkRescheduleOutcome | null) {
    if (running) return;
    onClose(result);
  }

  if (outcome !== null) {
    return (
      <Dialog
        title="Reschedule results"
        onClose={() => closeIfIdle(outcome)}
        footer={<PrimaryButton label="Done" onClick={() => onClose(outcome)} disabled={running} />}
      >
        <Banner
          tone={
            outcome.failures.length > 0
              ? 'error'
              : outcome.skipped.length > 0
                ? 'warning'
                : 'success'
          }
          title={bulkRescheduleSummary(outcome)}
        >
          <p className="bulk-reschedule__hint">
            Each visit was moved on its own. Any that did not land is still at the time it had.
          </p>
        </Banner>

        {outcome.applied.length > 0 && (
          <>
            <p className="bulk-reschedule__result-head">Moved:</p>
            <ul className="bulk-reschedule__result">
              {outcome.applied.map((a) => (
                <li key={a.id}>
                  <strong>{a.name}</strong>: now {bookingWhenLabel(a.startTime)}
                </li>
              ))}
            </ul>
          </>
        )}

        {outcome.failures.length > 0 && (
          <>
            <p className="bulk-reschedule__result-head">Not moved:</p>
            <ul className="bulk-reschedule__result">
              {outcome.failures.map((f) => {
                // Bound to a local const so the narrowing survives into the
                // click handler: TypeScript discards a narrowing on a property
                // inside a callback, and `f.override` is a property.
                const override = f.override;
                return (
                  <li key={f.id}>
                    <strong>{f.name}</strong>: {f.reason}
                    {override !== null && (
                      <span className="bulk-reschedule__override">
                        <span className="bulk-reschedule__hint">{overrideHint(override)}</span>
                        <GhostButton
                          label={rescheduleOverrideLabel(override)}
                          disabled={running}
                          onClick={() => void retryWithOverride(f, override)}
                        />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {outcome.skipped.length > 0 && (
          <>
            <p className="bulk-reschedule__result-head">Left where they are:</p>
            <ul className="bulk-reschedule__result">
              {outcome.skipped.map((s) => (
                <li key={s.id}>
                  <strong>{s.name}</strong>: {s.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Reschedule selected visits"
      onClose={() => closeIfIdle(null)}
      size="wide"
      footer={
        <>
          <GhostButton label="Back" onClick={() => onClose(null)} disabled={running} />
          <PrimaryButton
            label={running ? 'Moving…' : `Reschedule ${count} ${count === 1 ? 'visit' : 'visits'}`}
            onClick={() => void run()}
            disabled={running || count === 0}
            busy={running}
          />
        </>
      }
    >
      <p className="bulk-reschedule__hint">
        Every visit keeps its own time. Adjust the ones that are moving and leave the rest, then
        confirm once. A visit left at the time it already has is not written.
      </p>

      {count === 0 ? (
        <p className="bulk-reschedule__hint">
          None of the selected bookings has a visit on the books to move.
        </p>
      ) : (
        <ul className="bulk-reschedule__rows">
          {targets.map((target) => {
            const draft = drafts.get(target.id) ?? { date: target.date, time: target.time };
            return (
              <li className="bulk-reschedule__row" key={target.id}>
                <div className="bulk-reschedule__row-head">
                  <strong>{target.name}</strong>
                  <span className="bulk-reschedule__hint">
                    Now {bookingWhenLabel(target.currentStart)} · keeps its length:{' '}
                    {durationLabel(target.durationMinutes)}
                  </span>
                </div>
                <div className="bulk-reschedule__row-fields">
                  <label className="bulk-reschedule__field">
                    <span className="bulk-reschedule__label">New date</span>
                    <input
                      className="bulk-reschedule__input"
                      type="date"
                      value={draft.date}
                      disabled={running}
                      aria-label={`New date for ${target.name}`}
                      onChange={(e) => setDraft(target.id, { date: e.target.value })}
                    />
                  </label>
                  <label className="bulk-reschedule__field">
                    <span className="bulk-reschedule__label">New time</span>
                    <input
                      className="bulk-reschedule__input"
                      type="time"
                      value={draft.time}
                      disabled={running}
                      aria-label={`New time for ${target.name}`}
                      onChange={(e) => setDraft(target.id, { time: e.target.value })}
                    />
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {skipped.length > 0 && (
        <>
          <p className="bulk-reschedule__result-head">Not offered a new time:</p>
          <ul className="bulk-reschedule__result">
            {skipped.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
