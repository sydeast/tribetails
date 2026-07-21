import { useMemo } from 'react';
import { type SessionEntry } from '../api/sessions';
import {
  sessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionClock,
  sessionDayKey,
  sessionDayLabel,
  localDateIso,
} from '../lib/sessionFormat';
import { str, arr } from '../lib/coerce';
import { DenScreenHeading, DenPanel, ServicePill, EmptyHint } from '../components/DenScreenKit';
import { GhostButton } from '../components/Buttons';
import './SessionDetail.css';

interface SessionDetailProps {
  /**
   * The row straight out of Sessions.tsx's own live SESSIONS_QUERY listener, by
   * value, NOT a second fetch (exactly as Bookings.tsx hands BookingActions its
   * `entry`). The list already streams the full session row, so there is nothing
   * left to getDoc here. `null` means the id no longer resolves to a row (the
   * stream is not ready yet, or a stale/removed id): that gets its own honest
   * "unavailable" state below, never a blank or a fabricated detail.
   */
  entry: SessionEntry | null;
  onBack: () => void;
}

/** One label/value line; renders nothing when the value is blank (never "undefined"), the KinfolkProfile `Fact` convention. */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (value.trim() === '') return null;
  return (
    <div className="sdetail__fact">
      <dt className="sdetail__fact-label">{label}</dt>
      <dd className={mono ? 'sdetail__fact-value sdetail__fact-value--mono' : 'sdetail__fact-value'}>{value}</dd>
    </div>
  );
}

/** True when a section has at least one non-blank field (so an all-blank section hides). */
function any(...vals: string[]): boolean {
  return vals.some((v) => v.trim() !== '');
}

/**
 * A single session ISO field as a LOCAL "Today · 20:00" moment, composed ONLY
 * from the existing AO-18 helpers (`sessionDayKey`/`sessionDayLabel`/`sessionClock`
 * in lib/sessionFormat.ts), never new date logic or `toLocaleString`. Blank when
 * the field is empty or does not parse, so a `Fact` hides it rather than showing
 * a fabricated "(no time)" clock or an "Undated" day.
 */
function localMoment(iso: string, todayIso: string): string {
  if ((iso ?? '').trim() === '') return '';
  const clock = sessionClock(iso);
  if (clock === '(no time)') return '';
  const key = sessionDayKey(iso);
  const day = key === 'Undated' ? '' : sessionDayLabel(key, todayIso);
  return day === '' ? clock : `${day} · ${clock}`;
}

/**
 * Read-only Kin Care session detail view: the screen Sessions' `onSelect`
 * placeholder opens (Sessions shipped list-only). It takes the FULL `SessionEntry`
 * BY VALUE, resolved from Sessions.tsx's already-loaded SESSIONS_QUERY stream (the
 * Bookings.tsx `detailEntry` pattern), so opening it costs no second read.
 *
 * Organized into fielded sections (Kin Care head, Timing, Kin, Notes), the
 * KinfolkProfile layout, so it is not one undifferentiated scroll; an all-blank
 * section (no timing on file, no kin, no notes) is omitted rather than shown
 * empty. Every timestamp goes through lib/sessionFormat.ts's LOCAL (AO-18)
 * helpers, the same ones the list uses, never a raw ISO slice or `toLocaleString`.
 * Status is classified by POSITIVE enumeration (`sessionState`, never a negation),
 * so an unrecognized code reads as UNKNOWN rather than being guessed into a bucket
 * (the AO-12 discipline).
 */
export function SessionDetail({ entry, onBack }: SessionDetailProps) {
  // "Today" doesn't change mid-view; computed once (the Sessions.tsx todayIso
  // rationale). Called unconditionally, above the null branch, per Rules of Hooks.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Auntie Time"
        title={entry !== null ? sessionHousehold(str(entry.kinfolkName)) : 'Kin Care session'}
        subtitle="Kin Care session detail."
        trailing={<GhostButton label="Back to Auntie Time" onClick={onBack} />}
      />

      {entry === null ? (
        <DenPanel title="Session unavailable">
          <EmptyHint>
            This Kin Care session is no longer available. It may have been removed, or the list is still
            loading.
          </EmptyHint>
        </DenPanel>
      ) : (
        (() => {
          // Every field is read through `str()`/`arr()`: `SessionEntry` is a cast
          // over raw Firestore data, not a validation of it (see api/sessions.ts),
          // so a doc can genuinely lack any of these. An absent field reads as
          // blank, which the sections below already hide (`Fact`/`any`) and the
          // helpers already classify honestly ('unknown', 'Undated'), rather than
          // throwing and blanking the view.
          const status = str(entry.status);
          const state = sessionState(status);
          const info = sessionStateInfo(state);
          const serviceType = str(entry.serviceType);
          const notes = str(entry.notes).trim();
          const kinCount = arr<string>(entry.kinIds).length;

          const startKey = sessionDayKey(str(entry.startTime));
          const dayLabel = startKey === 'Undated' ? '' : sessionDayLabel(startKey, todayIso);
          const scheduled = sessionWindow(str(entry.startTime), str(entry.endTime));
          const scheduledValue = scheduled === 'Time TBD' ? '' : scheduled;
          const clockedIn = localMoment(str(entry.arrivedAt), todayIso);
          const clockedOut = localMoment(str(entry.completedAt), todayIso);

          return (
            <>
              {/* The household names the page in the heading above; this panel
                  is the status/service line, so it isn't repeated here. */}
              <DenPanel title="Status">
                <div className="sdetail__head">
                  <div className="sdetail__head-tags">
                    <span className={`sdetail__chip sdetail__chip--${info.cssClass}`}>{info.chipLabel}</span>
                    <ServicePill serviceType={serviceType} />
                  </div>
                  {state === 'unknown' && (
                    <p className="sdetail__hint">
                      This session&rsquo;s status (&ldquo;{status}&rdquo;) isn&rsquo;t recognized, so
                      it is shown as UNKNOWN rather than guessed into a state.
                    </p>
                  )}
                </div>
              </DenPanel>

              {any(dayLabel, scheduledValue, clockedIn, clockedOut) && (
                <DenPanel title="Timing">
                  <dl className="sdetail__facts">
                    <Fact label="Day" value={dayLabel} />
                    <Fact label="Scheduled" value={scheduledValue} mono />
                    <Fact label="Clocked in" value={clockedIn} mono />
                    <Fact label="Clocked out" value={clockedOut} mono />
                  </dl>
                </DenPanel>
              )}

              {kinCount > 0 && (
                <DenPanel title="Kin" subtitle="Pets this visit covers.">
                  <dl className="sdetail__facts">
                    <Fact label="Kin covered" value={String(kinCount)} />
                  </dl>
                </DenPanel>
              )}

              {notes !== '' && (
                <DenPanel title="Notes">
                  <p className="sdetail__notes">{notes}</p>
                </DenPanel>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}
