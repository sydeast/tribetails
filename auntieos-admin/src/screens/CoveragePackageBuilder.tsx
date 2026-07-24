import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getCoveragePackageConfig,
  type CoveragePackageConfig,
} from '../api/coveragePackage';
import { saveCoveragePackageConfig } from '../api/coveragePackageWrite';
import {
  DEFAULT_COVERAGE_RULES,
  DEFAULT_DURATIONS,
  OVERNIGHT_MINUTES,
  buildDayPatterns,
  daysBetween,
  minutesToTime,
  timeToMinutes,
  uid,
  type CoverageRules,
  type Duration,
  type PinnedTime,
} from '../lib/coveragePackage';
import { lastSavedLabel } from '../lib/settingsFormat';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import './CoveragePackageBuilder.css';

/**
 * Coverage Package Builder.
 *
 * An operator prices a multi-day pet-sitting stay by describing one covered day:
 * a wake window, a max gap between visits, and any pinned (fixed-time) visits.
 * `buildDayPatterns` (in `lib/coveragePackage.ts`, unit-tested there) turns those
 * rules into a few rule-valid daily schedules at Lean / Balanced / Generous price
 * points; the operator approves one and it is priced across the whole stay.
 *
 * TWO KINDS OF STATE, deliberately split:
 *  - CONFIG (the visit menu + coverage rules) persists to
 *    `coverage_package_config/config` via an explicit Save, the same
 *    load/Save/last-saved model as the Settings editors.
 *  - The per-stay inputs (client, dates, which schedule was approved) are session
 *    state and are never written — pricing a stay must not mutate saved config.
 *
 * Loads once through `AsyncRegion`, so a permission-denied or offline read shows
 * one honest error with Retry, never a fabricated blank menu.
 */
export function CoveragePackageBuilder() {
  const [config, setConfig] = useState<Async<CoveragePackageConfig>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setConfig({ status: 'loading' });
    getCoveragePackageConfig()
      .then((data) => live && setConfig({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setConfig({
            status: 'error',
            message: `Couldn't read package config: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="Care Ops · Pricing"
        title="Coverage"
        accentTail="package builder."
        subtitle="Set your visit menu and coverage rules, approve a rule-valid daily schedule, then price it across the full stay."
      />

      <AsyncRegion
        state={config}
        what="package config"
        isEmpty={() => false}
        loading={<p className="cpb__hint">Loading package config…</p>}
        empty={<p className="cpb__hint">No config found.</p>}
      >
        {(data) => (
          <Builder
            initial={data}
            onSaved={(saved) => setConfig({ status: 'ready', data: saved })}
          />
        )}
      </AsyncRegion>
    </div>
  );
}

// ── the editor ────────────────────────────────────────────────────────────────

interface BuilderProps {
  initial: CoveragePackageConfig;
  /** Called after a successful config save, to refresh the loaded baseline. */
  onSaved: (saved: CoveragePackageConfig) => void;
}

interface NewDuration {
  label: string;
  minutes: string;
  price: string;
}
interface NewPinned {
  label: string;
  time: string;
  durationId: string;
}

/** Structural equality for the saveable config (menu + rules), for dirty tracking. */
function sameConfig(a: { durations: readonly Duration[]; rules: CoverageRules }, b: typeof a): boolean {
  return (
    JSON.stringify({ durations: a.durations, rules: a.rules }) ===
    JSON.stringify({ durations: b.durations, rules: b.rules })
  );
}

function Builder({ initial, onSaved }: BuilderProps) {
  // Persisted config, seeded once from the loaded doc.
  const [durations, setDurations] = useState<readonly Duration[]>(initial.durations);
  const [rules, setRules] = useState<CoverageRules>(initial.rules);
  // The last-saved baseline, for dirty tracking. Advanced on every successful save.
  const [baseline, setBaseline] = useState({ durations: initial.durations, rules: initial.rules });
  const [savedAt, setSavedAt] = useState<{ updatedAt?: string; updatedBy?: string }>({
    ...(initial.updatedAt !== undefined ? { updatedAt: initial.updatedAt } : {}),
    ...(initial.updatedBy !== undefined ? { updatedBy: initial.updatedBy } : {}),
  });
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Ephemeral, per-stay session state — never persisted.
  const [useOvernight, setUseOvernight] = useState(false);
  const [overnightDurationId, setOvernightDurationId] = useState('d7');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [clientName, setClientName] = useState('');
  const [approvedPatternId, setApprovedPatternId] = useState<string | null>(null);
  const [regenSeed, setRegenSeed] = useState(0);

  // Draft rows.
  const [newDuration, setNewDuration] = useState<NewDuration>({ label: '', minutes: '', price: '' });
  const [newPinned, setNewPinned] = useState<NewPinned>({ label: '', time: '', durationId: '' });
  const [error, setError] = useState('');

  const dirty = !sameConfig({ durations, rules }, baseline);
  const days = daysBetween(startDate, endDate);

  // ── config edits ────────────────────────────────────────────────────────────

  const addDuration = () => {
    if (!newDuration.label.trim() || !newDuration.price || !newDuration.minutes) {
      setError('Enter a duration name, length in minutes, and price.');
      return;
    }
    setDurations([
      ...durations,
      {
        id: uid(),
        label: newDuration.label.trim(),
        minutes: parseFloat(newDuration.minutes) || 0,
        price: parseFloat(newDuration.price) || 0,
      },
    ]);
    setNewDuration({ label: '', minutes: '', price: '' });
    setError('');
  };

  const removeDuration = (id: string) => setDurations(durations.filter((d) => d.id !== id));

  const updateDuration = (id: string, field: keyof Duration, value: string) => {
    setDurations(
      durations.map((d) =>
        d.id === id ? { ...d, [field]: field === 'label' ? value : parseFloat(value) || 0 } : d,
      ),
    );
  };

  const patchRules = (patch: Partial<CoverageRules>) => setRules((r) => ({ ...r, ...patch }));

  const addPinned = () => {
    if (!newPinned.label.trim() || !newPinned.time || !newPinned.durationId) {
      setError('Enter a label, time, and visit length for the pinned visit.');
      return;
    }
    patchRules({ pinnedTimes: [...rules.pinnedTimes, { id: uid(), ...newPinned }] });
    setNewPinned({ label: '', time: '', durationId: '' });
    setError('');
  };

  const removePinned = (id: string) =>
    patchRules({ pinnedTimes: rules.pinnedTimes.filter((p) => p.id !== id) });

  const resetConfig = () => {
    setDurations(baseline.durations);
    setRules(baseline.rules);
    setError('');
    setSaveError(null);
  };

  const restoreDefaults = () => {
    setDurations(DEFAULT_DURATIONS);
    setRules(DEFAULT_COVERAGE_RULES);
    setError('');
  };

  const saveConfig = async () => {
    if (!dirty || saveBusy) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      const stamp = await saveCoveragePackageConfig({ durations, rules });
      setBaseline({ durations, rules });
      setSavedAt(stamp);
      // Surface the saved baseline (with the fresh stamp) up to the screen, so a
      // later remount reads back exactly what was written.
      onSaved({ durations, rules, updatedAt: stamp.updatedAt, updatedBy: stamp.updatedBy });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaveBusy(false);
    }
  };

  // ── schedules ─────────────────────────────────────────────────────────────

  const dayPatterns = useMemo(
    () => buildDayPatterns(durations, rules, useOvernight, overnightDurationId),
    // regenSeed re-rolls the (random) fill order without any config change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [durations, rules, useOvernight, overnightDurationId, regenSeed],
  );

  useEffect(() => {
    if (approvedPatternId && !dayPatterns.some((p) => p.id === approvedPatternId)) {
      setApprovedPatternId(null);
    }
  }, [dayPatterns, approvedPatternId]);

  // Keep the overnight selection pointing at a real menu item. If the operator
  // pruned the duration it referenced, snap to the first overnight-length visit
  // rather than let `buildDayPatterns` find nothing and silently price it $0.
  useEffect(() => {
    if (!useOvernight) return;
    const options = durations.filter((d) => d.minutes >= OVERNIGHT_MINUTES);
    if (options.length > 0 && !options.some((d) => d.id === overnightDurationId)) {
      setOvernightDurationId(options[0]!.id);
    }
  }, [useOvernight, durations, overnightDurationId]);

  const approvedPattern = dayPatterns.find((p) => p.id === approvedPatternId) ?? null;
  const packageTotal = approvedPattern && days > 0 ? approvedPattern.dayTotal * days : 0;

  const overnightDurations = durations.filter((d) => d.minutes >= OVERNIGHT_MINUTES);
  const dayVisitDurations = durations.filter((d) => d.minutes < OVERNIGHT_MINUTES);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="cpb">
      <div className="cpb__savebar">
        {savedAt.updatedAt !== undefined ? (
          <span className="cpb__saved">{lastSavedLabel(savedAt.updatedAt, savedAt.updatedBy ?? '')}</span>
        ) : (
          <span className="cpb__saved cpb__saved--muted">Config never saved yet</span>
        )}
        <span className="cpb__savebarActions">
          <GhostButton label="Revert" onClick={resetConfig} disabled={!dirty || saveBusy} />
          <PrimaryButton
            label={saveBusy ? 'Saving…' : dirty ? 'Save configuration' : 'Saved'}
            onClick={() => void saveConfig()}
            disabled={!dirty || saveBusy}
            busy={saveBusy}
          />
        </span>
      </div>
      {saveError ? (
        <Banner tone="error" title="Save failed" className="cpb__banner">
          {saveError}
        </Banner>
      ) : null}

      {/* Visit durations & prices */}
      <DenPanel
        title="Visit menu"
        subtitle="Your visit lengths and their prices. These feed every schedule below."
        trailing={<GhostButton label="Restore defaults" onClick={restoreDefaults} />}
      >
        <ul className="cpb__list">
          {durations.map((d) => (
            <li key={d.id} className="cpb__durationRow">
              <input
                className="cpb__input cpb__input--grow"
                aria-label="Visit name"
                value={d.label}
                onChange={(e) => updateDuration(d.id, 'label', e.target.value)}
              />
              <span className="cpb__unitField">
                <input
                  className="cpb__input cpb__input--num"
                  type="number"
                  min="1"
                  aria-label="Visit length in minutes"
                  value={d.minutes}
                  onChange={(e) => updateDuration(d.id, 'minutes', e.target.value)}
                />
                <span className="cpb__unit">min</span>
              </span>
              <span className="cpb__unitField">
                <span className="cpb__unit cpb__unit--lead">$</span>
                <input
                  className="cpb__input cpb__input--num cpb__input--price"
                  type="number"
                  min="0"
                  step="0.01"
                  aria-label="Visit price"
                  value={d.price}
                  onChange={(e) => updateDuration(d.id, 'price', e.target.value)}
                />
              </span>
              <IconButton icon={<TrashGlyph />} label={`Remove ${d.label}`} destructive onClick={() => removeDuration(d.id)} />
            </li>
          ))}
        </ul>

        <div className="cpb__addRow">
          <input
            className="cpb__input cpb__input--grow"
            placeholder="New visit name"
            value={newDuration.label}
            onChange={(e) => setNewDuration({ ...newDuration, label: e.target.value })}
          />
          <span className="cpb__unitField">
            <input
              className="cpb__input cpb__input--num"
              type="number"
              min="1"
              placeholder="min"
              aria-label="New visit length"
              value={newDuration.minutes}
              onChange={(e) => setNewDuration({ ...newDuration, minutes: e.target.value })}
            />
            <span className="cpb__unit">min</span>
          </span>
          <span className="cpb__unitField">
            <span className="cpb__unit cpb__unit--lead">$</span>
            <input
              className="cpb__input cpb__input--num cpb__input--price"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              aria-label="New visit price"
              value={newDuration.price}
              onChange={(e) => setNewDuration({ ...newDuration, price: e.target.value })}
            />
          </span>
          <PrimaryButton label="Add" leading={<PlusGlyph />} onClick={addDuration} />
        </div>
      </DenPanel>

      {/* Coverage rules */}
      <DenPanel
        title="Coverage rules"
        subtitle="The window the day covers, the longest allowed gap, and any fixed daily visits."
      >
        <div className="cpb__ruleRow">
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Day starts</span>
            <input
              className="cpb__input"
              type="time"
              value={rules.wakeStart}
              onChange={(e) => patchRules({ wakeStart: e.target.value })}
            />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Day ends</span>
            <input
              className="cpb__input"
              type="time"
              value={rules.wakeEnd}
              onChange={(e) => patchRules({ wakeEnd: e.target.value })}
            />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Max gap between visits (hrs)</span>
            <input
              className="cpb__input"
              type="number"
              min="1"
              step="0.5"
              value={rules.maxGapHours}
              onChange={(e) => patchRules({ maxGapHours: parseFloat(e.target.value) || 1 })}
            />
          </label>
        </div>

        <div className="cpb__overnight">
          <Toggle
            label="Include overnight coverage"
            checked={useOvernight}
            onChange={setUseOvernight}
          />
          <span className="cpb__overnightText">
            Include overnight coverage (covers the hours outside the day window above)
          </span>
        </div>
        {useOvernight ? (
          overnightDurations.length > 0 ? (
            <select
              className="cpb__input cpb__select"
              aria-label="Overnight visit length"
              value={overnightDurationId}
              onChange={(e) => setOvernightDurationId(e.target.value)}
            >
              {overnightDurations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} · ${d.price}
                </option>
              ))}
            </select>
          ) : (
            <p className="cpb__hint">
              Add a visit of {OVERNIGHT_MINUTES} minutes or more to the menu to use as overnight coverage.
            </p>
          )
        ) : null}

        <div className="cpb__pinned">
          <p className="cpb__pinnedHeading">Pinned visits (specific times that must happen every day)</p>
          {rules.pinnedTimes.map((p) => (
            <div key={p.id} className="cpb__pinnedRow">
              <span className="cpb__pinnedLabel">{p.label}</span>
              <span className="cpb__pinnedTime">{p.time ? pinnedTimeLabel(p) : ''}</span>
              <span className="cpb__pinnedDuration">
                {durations.find((d) => d.id === p.durationId)?.label ?? ''}
              </span>
              <IconButton
                icon={<TrashGlyph />}
                label={`Remove ${p.label}`}
                destructive
                size={30}
                onClick={() => removePinned(p.id)}
              />
            </div>
          ))}
          <div className="cpb__addRow">
            <input
              className="cpb__input cpb__input--grow"
              placeholder="e.g. Medication"
              value={newPinned.label}
              onChange={(e) => setNewPinned({ ...newPinned, label: e.target.value })}
            />
            <input
              className="cpb__input"
              type="time"
              aria-label="Pinned visit time"
              value={newPinned.time}
              onChange={(e) => setNewPinned({ ...newPinned, time: e.target.value })}
            />
            <select
              className="cpb__input cpb__select"
              aria-label="Pinned visit length"
              value={newPinned.durationId}
              onChange={(e) => setNewPinned({ ...newPinned, durationId: e.target.value })}
            >
              <option value="">visit length…</option>
              {dayVisitDurations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <PrimaryButton label="Add" leading={<PlusGlyph />} onClick={addPinned} />
          </div>
        </div>

        {error ? (
          <Banner tone="warning" title="Check your entry" className="cpb__banner">
            {error}
          </Banner>
        ) : null}
      </DenPanel>

      {/* Valid daily schedules */}
      <DenPanel
        title="Valid daily schedules"
        subtitle="Rule-valid options at different price points. Approve one to price the stay."
        trailing={
          <GhostButton
            label="Regenerate"
            leading={<RefreshGlyph />}
            onClick={() => setRegenSeed((n) => n + 1)}
          />
        }
      >
        {dayPatterns.length === 0 ? (
          <p className="cpb__hint">Set your day window and rules above to see valid schedule options.</p>
        ) : (
          <div className="cpb__patternGrid">
            {dayPatterns.map((pattern) => {
              const approved = approvedPatternId === pattern.id;
              return (
                <div key={pattern.id} className={approved ? 'cpb__pattern cpb__pattern--approved' : 'cpb__pattern'}>
                  <div className="cpb__patternHead">
                    <span className="cpb__patternStrategy">{pattern.strategyLabel}</span>
                    <span className="cpb__patternPrice">
                      ${pattern.dayTotal.toFixed(2)}
                      <span className="cpb__perDay">/day</span>
                    </span>
                  </div>
                  <ul className="cpb__patternList">
                    {pattern.touchpoints.map((tp, i) => (
                      <li key={i} className="cpb__patternItem">
                        <ClockGlyph />
                        <span className="cpb__patternTime">{minutesToTime(tp.time)}</span>
                        <span className="cpb__patternTpLabel">
                          {tp.label === 'Check-in'
                            ? `Check-in (${tp.durationLabel})`
                            : `${tp.label} (${tp.durationLabel})`}
                        </span>
                      </li>
                    ))}
                    {pattern.overnightLabel ? (
                      <li className="cpb__patternItem">
                        <ClockGlyph />
                        <span className="cpb__patternTpLabel">
                          {pattern.overnightLabel} · ${pattern.overnightCost.toFixed(2)}
                        </span>
                      </li>
                    ) : null}
                  </ul>
                  <PrimaryButton
                    label={approved ? 'Approved' : 'Approve this schedule'}
                    leading={approved ? <CheckGlyph /> : undefined}
                    onClick={() => setApprovedPatternId(pattern.id)}
                    className="cpb__approve"
                  />
                </div>
              );
            })}
          </div>
        )}
      </DenPanel>

      {/* Coverage window & price */}
      <DenPanel
        title="Coverage window & price"
        subtitle="The stay's dates. Priced from the approved schedule; not saved with the config."
      >
        <div className="cpb__ruleRow">
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Client (optional)</span>
            <input
              className="cpb__input"
              placeholder="Kinfolk name"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
            />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Start</span>
            <input
              className="cpb__input"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">End</span>
            <input
              className="cpb__input"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        </div>

        {days > 0 ? (
          <p className="cpb__dayCount">
            <CalendarGlyph />
            {days} day{days !== 1 ? 's' : ''} of coverage
          </p>
        ) : null}

        {!approvedPattern ? (
          <p className="cpb__hint">Approve a daily schedule above to price the full stay.</p>
        ) : null}

        {approvedPattern && days > 0 ? (
          <div className="cpb__finalPrice">
            <div>
              <div className="cpb__finalPriceLabel">
                {clientName ? `${clientName}'s package` : 'Package total'}
              </div>
              <div className="cpb__finalPriceSub">
                {approvedPattern.strategyLabel} schedule × {days} day{days !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="cpb__finalPriceValue">${packageTotal.toFixed(2)}</div>
          </div>
        ) : null}
      </DenPanel>
    </div>
  );
}

/** 12h label for a pinned visit's stored "HH:MM" time. */
function pinnedTimeLabel(p: PinnedTime): string {
  const mins = timeToMinutes(p.time);
  return mins === null ? '' : minutesToTime(mins);
}

// ── inline glyphs (the repo installs no icon set; one SVG per glyph, per the
//    DenScreenKit / Banner convention) ─────────────────────────────────────────

function glyphProps() {
  return {
    viewBox: '0 0 24 24',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

function TrashGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg {...glyphProps()} className="cpb__glyphClock">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CalendarGlyph() {
  return (
    <svg {...glyphProps()} className="cpb__glyphInline">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}
