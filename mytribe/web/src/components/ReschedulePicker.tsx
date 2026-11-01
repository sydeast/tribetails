import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBookingPolicy, getBusinessClosures } from '../api/bookingApi';
import type { BookingMode, GetBookingPolicyResult } from '../api/bookingApi';
import { BookingMonthPicker } from './BookingMonthPicker';
import { LoadingLine } from './Loading';
import {
  BOOKING_HORIZON_DAYS,
  bookingHorizonEnd,
  dateKey,
  timeBlockLabel,
} from '../lib/bookingWizardLogic';
import {
  blockChoices,
  closedDaysFor,
  FALLBACK_TIME_ZONE,
  rescheduleModes,
  resolveProposal,
  type RescheduleProposal,
} from '../lib/rescheduleTime';
import '../styles/booking.css';
/**
 * What the business lets a household choose while `getBookingPolicy` is in
 * flight or has failed: clock times, no windows. The same fallback the booking
 * wizard runs on, and the server refuses whatever it will not take regardless.
 */
const CLOCK_ONLY_POLICY: GetBookingPolicyResult = {
  allowTimeBlockBooking: false,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  timeBlocks: [],
};
const NO_CLOSURES: ReadonlyMap<string, string> = new Map();
const DEFAULT_CLOCK_TIME = '09:00';
/**
 * #1284: the reschedule form's "when", the booking wizard's own controls.
 *
 * It had been a native `datetime-local` input, which took 2:00 AM and any
 * closed day. This is the wizard's month grid (closed company days and closed
 * weekdays greyed out, nothing past the booking horizon), then either the
 * business's time blocks or a clock time bounded by that weekday's hours,
 * whichever the business's policy offers for this visit. The same two reads
 * the wizard makes, under the same query keys, so a household that just came
 * from booking has them cached.
 *
 * A secondary read that fails degrades the way the wizard does (every day
 * pickable, clock times) rather than blocking the form: the server is the
 * authority and its refusal is shown as written.
 *
 * Reports the finished choice upward as a proposal, or null while there is
 * none; the parent owns sending it.
 */
export function ReschedulePicker(props: {
  /** The visit's catalog service id, which decides whether it books by clock regardless of mode (#1092). */
  serviceId: string | null;
  disabled?: boolean;
  onChange: (proposal: RescheduleProposal | null) => void;
  /** Pins "now" in tests. */
  now?: () => number;
}) {
  const { serviceId, onChange } = props;
  const nowFn = props.now ?? Date.now;
  const policyQuery = useQuery({ queryKey: ['bookingPolicy'], queryFn: () => getBookingPolicy() });
  const closuresQuery = useQuery({
    queryKey: ['businessClosures'],
    queryFn: () => {
      const today = new Date();
      return getBusinessClosures({
        fromDate: dateKey(today),
        toDate: dateKey(bookingHorizonEnd(today, BOOKING_HORIZON_DAYS)),
      });
    },
  });
  const policy = policyQuery.data ?? CLOCK_ONLY_POLICY;
  const timeZone = closuresQuery.data?.timeZone || FALLBACK_TIME_ZONE;
  const weekly = closuresQuery.data?.weeklyHours;
  const { modes, initial } = useMemo(() => rescheduleModes(policy, serviceId), [policy, serviceId]);
  const startTimeService = serviceId !== null && (policy.startTimeServiceIds ?? []).includes(serviceId);
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [modeChoice, setModeChoice] = useState<BookingMode | null>(null);
  const [time, setTime] = useState(DEFAULT_CLOCK_TIME);
  const [blockId, setBlockId] = useState<string | null>(null);
  const mode: BookingMode = modeChoice !== null && modes.includes(modeChoice) ? modeChoice : initial;
  const closedDates = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of closuresQuery.data?.closures ?? []) m.set(c.date, c.name);
    return closedDaysFor(m.size > 0 ? m : NO_CLOSURES, weekly, new Date(), BOOKING_HORIZON_DAYS);
  }, [closuresQuery.data, weekly]);
  const blocks = mode === 'TIME_BLOCK' ? policy.timeBlocks : [];
  const open = useMemo(
    () => (dayKey ? blockChoices(dayKey, blocks, nowFn(), timeZone) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayKey, blocks, timeZone],
  );
  // A block picked for one day may be gone on another (it has passed today).
  const effectiveBlockId = blockId !== null && open.some((c) => c.block.id === blockId) ? blockId : null;
  const { proposal, problem } = useMemo(
    () =>
      resolveProposal({
        dayKey,
        mode,
        time,
        blockId: effectiveBlockId,
        blocks,
        weekly,
        timeZone,
        nowMs: nowFn(),
        startTimeService,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayKey, mode, time, effectiveBlockId, blocks, weekly, timeZone, startTimeService],
  );
  const key = proposal ? `${proposal.startMs}|${proposal.timeBlockId ?? ''}` : '';
  useEffect(() => {
    onChange(proposal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if ((policyQuery.isPending && policyQuery.fetchStatus === 'fetching') || (closuresQuery.isPending && closuresQuery.fetchStatus === 'fetching')) {
    return (
      <LoadingLine what="the days and times you can pick" retry={() => { void policyQuery.refetch(); void closuresQuery.refetch(); }}>
        Loading the days and times you can pick…
      </LoadingLine>
    );
  }
  return (
    <div className="reschedule-picker" data-testid="reschedule-picker">
      <p className="sub" style={{ margin: '0 0 6px' }}>Pick a day</p>
      <BookingMonthPicker
        selectedDates={new Set(dayKey ? [dayKey] : [])}
        onToggle={(k) => setDayKey((cur) => (cur === k ? null : k))}
        closedDates={closedDates}
      />
      {modes.length > 1 && (
        <div className="pattern-toggle" role="radiogroup" aria-label="Time selection" style={{ marginTop: 14 }}>
          <button
            type="button"
            className={`pattern-btn ${mode === 'TIME_BLOCK' ? 'is-on' : ''}`}
            role="radio"
            aria-checked={mode === 'TIME_BLOCK'}
            onClick={() => setModeChoice('TIME_BLOCK')}
            disabled={props.disabled}
          >
            Time Blocks
          </button>
          <button
            type="button"
            className={`pattern-btn ${mode === 'SPECIFIC_TIME' ? 'is-on' : ''}`}
            role="radio"
            aria-checked={mode === 'SPECIFIC_TIME'}
            onClick={() => setModeChoice('SPECIFIC_TIME')}
            disabled={props.disabled}
          >
            A Specific Time
          </button>
        </div>
      )}
      {dayKey === null ? (
        <p className="sub" style={{ marginTop: 12 }}>Pick a day to see the times.</p>
      ) : mode === 'TIME_BLOCK' ? (
        <div className="field" style={{ marginTop: 12, maxWidth: 280 }}>
          <label htmlFor="reschedule-block">Time block</label>
          <select
            id="reschedule-block"
            className="inp"
            value={effectiveBlockId ?? ''}
            onChange={(e) => setBlockId(e.target.value || null)}
            disabled={props.disabled || open.length === 0}
          >
            <option value="">{open.length === 0 ? 'No blocks left this day' : 'Choose a time block'}</option>
            {open.map((c) => (
              <option key={c.block.id} value={c.block.id}>
                {timeBlockLabel(c.block)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="field" style={{ marginTop: 12, maxWidth: 280 }}>
          <label htmlFor="reschedule-time">Time</label>
          <input
            id="reschedule-time"
            type="time"
            className="inp"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={props.disabled}
          />
        </div>
      )}
      {problem && <p className="wiz-warn">{problem}</p>}
    </div>
  );
}
