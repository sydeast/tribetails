import { useCallback, useEffect, useMemo, useState } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import {
  DEFAULT_COVERAGE_RULES,
  alignPinnedToDurations,
  buildDayPatterns,
  dateLabel,
  daysBetween,
  durationsFromServiceRates,
  effectiveVisits,
  gapWarnings,
  minutesToInput,
  minutesToTime,
  normalizePackage,
  packagesFromPatterns,
  pricePackage,
  quoteText,
  timeToMinutes,
  todayIso,
  uid,
  visitsFromPattern,
  visitsFromPinned,
  type CoverageRules,
  type DayPattern,
  type Duration,
  type Package,
  type PricedDayRow,
  type Visit,
} from '../lib/coveragePackage';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import './CoveragePackageBuilder.css';

/**
 * Coverage Package Builder (full port of the canonical PackageBuilder_7 sketch).
 *
 * An operator prices a multi-day stay by BUILDING one or more named packages —
 * each a template of visits (any mix of lengths/times), with per-night overnights,
 * per-day overrides, and an optional discount. Suggestions seed a package from a
 * rule; every seeded visit is then editable. There is NO requirement for a pinned
 * visit or an auto-filled gap — the operator can simply pick services for a client.
 *
 * WHERE THE MENU COMES FROM (issue #693). Visit lengths and prices are the
 * operator's KinCare types, read from `business_settings.serviceRates` plus
 * `serviceDurations` and edited in Settings. This screen no longer keeps a rate
 * card of its own: the "Visit menu" panel that edited a second durations list in
 * `coverage_package_config/config` is gone, so a package can only quote a price
 * Settings actually holds.
 *
 * The in-progress QUOTE (client, dates, per-client rules, packages, overnight
 * selection) is the only state this screen owns. It persists to localStorage so a
 * hand-built quote survives a reload; "Start new quote" clears it.
 */
export function CoveragePackageBuilder() {
  const [settings, setSettings] = useState<Async<BusinessSettings>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setSettings({ status: 'loading' });
    getBusinessSettings()
      .then((data) => live && setSettings({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setSettings({
            status: 'error',
            message: `Couldn't read your KinCare rates: ${err instanceof Error ? err.message : 'Load failed'}`,
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
        subtitle="Name the client and the dates, set that client's rules, then build packages: mix any visit lengths, pick which nights get an overnight, and compare totals side by side. Visits an overnight covers drop off automatically, and every overnight adds a free visit the next day. Lengths and prices come from your KinCare types in Settings."
      />

      <AsyncRegion
        state={settings}
        what="KinCare rates"
        isEmpty={() => false}
        loading={<p className="cpb__hint">Loading your KinCare rates…</p>}
        empty={<p className="cpb__hint">No settings found.</p>}
      >
        {(data) => <Builder settings={data} />}
      </AsyncRegion>
    </div>
  );
}

// ── the editor ────────────────────────────────────────────────────────────────

interface BuilderProps {
  settings: Pick<BusinessSettings, 'serviceRates' | 'serviceDurations'>;
}

interface NewPinned {
  label: string;
  time: string;
  durationId: string;
}

const QUOTE_KEY = 'tt-coverage-quote-v1';

interface StoredQuote {
  clientName: string;
  startDate: string;
  endDate: string;
  overnightDurationId: string;
  /** Per-client rules travel with the quote — never in the saved global config. */
  rules: CoverageRules;
  packages: Package[];
  /**
   * Whether this quote has already had its Lean / Balance / Premium tiers built
   * (issue #694). It is a separate flag rather than "the list is empty" because
   * deleting all three is a decision, and a quote must not grow them back on the
   * next reload. A quote saved before this flag existed has none, and gets its
   * tiers once.
   */
  tiersSeeded: boolean;
}

function loadQuote(): Partial<StoredQuote> {
  try {
    const raw = window.localStorage.getItem(QUOTE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<StoredQuote>;
    return {
      ...parsed,
      packages: Array.isArray(parsed.packages) ? parsed.packages.map(normalizePackage) : [],
    };
  } catch {
    return {};
  }
}

/** The three tiers for one menu and one set of client rules. */
function patternsFor(durations: readonly Duration[], rules: CoverageRules): DayPattern[] {
  return buildDayPatterns(durations, rules.pinnedTimes, rules.maxGapHours, rules.wakeStart, rules.wakeEnd);
}

function Builder({ settings }: BuilderProps) {
  // The menu is the operator's KinCare types, read-only here and edited in Settings.
  const durations = useMemo<readonly Duration[]>(
    () => durationsFromServiceRates(settings.serviceRates, settings.serviceDurations),
    [settings],
  );

  // In-progress QUOTE (localStorage) — includes the PER-CLIENT rules.
  const stored = useMemo(loadQuote, []);
  const [clientName, setClientName] = useState(stored.clientName ?? '');
  // A fresh quote opens on today rather than blank: the operator's next stay
  // starts on or after today, and a blank date prices nothing (issue #693).
  const [startDate, setStartDate] = useState(stored.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(stored.endDate ?? '');
  // Rules pin visits by duration id, and #728 made the service NAME the id, so a
  // rule saved under the old ids must be repointed before anything reads it.
  const initialRules = alignPinnedToDurations(stored.rules ?? DEFAULT_COVERAGE_RULES, durations);
  const [rules, setRules] = useState<CoverageRules>(initialRules);
  // Every quote opens with the three tiers already built, beside whatever the
  // operator has hand-built (issue #694). Seeded once per quote, so deleting one
  // sticks.
  const [packages, setPackages] = useState<Package[]>(() => {
    const existing = stored.packages ?? [];
    if (stored.tiersSeeded === true) return existing;
    return [...existing, ...packagesFromPatterns(patternsFor(durations, initialRules))];
  });
  const [overnightDurationId, setOvernightDurationId] = useState(
    stored.overnightDurationId ?? durations.find((d) => d.kind === 'overnight')?.id ?? '',
  );
  const [detailId, setDetailId] = useState<string | null>(null);

  // Draft rows + feedback.
  const [newPinned, setNewPinned] = useState<NewPinned>({ label: '', time: '', durationId: '' });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const days = daysBetween(startDate, endDate);
  const nights = Math.max(0, days - 1); // last day is a return day — client home that night

  // Persist the quote on every change (survives a reload; "Start new quote" clears it).
  // The per-client rules travel here, NOT in the saved global config.
  useEffect(() => {
    const quote: StoredQuote = { clientName, startDate, endDate, overnightDurationId, rules, packages, tiersSeeded: true };
    try {
      window.localStorage.setItem(QUOTE_KEY, JSON.stringify(quote));
    } catch {
      // Storage full / disabled — the quote just won't survive a reload. Non-fatal.
    }
  }, [clientName, startDate, endDate, overnightDurationId, rules, packages]);

  // Keep the overnight selection pointing at a real overnight-kind duration.
  useEffect(() => {
    const overnights = durations.filter((d) => d.kind === 'overnight');
    if (overnights.length > 0 && !overnights.some((d) => d.id === overnightDurationId)) {
      setOvernightDurationId(overnights[0]!.id);
    }
  }, [durations, overnightDurationId]);

  // Date range shrank: drop overnight toggles / day overrides for days that no longer exist.
  useEffect(() => {
    setPackages((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        const keptNights = Object.entries(p.overnightNights).filter(([i]) => Number(i) < nights);
        const keptDays = Object.entries(p.dayOverrides).filter(([i]) => Number(i) < days);
        const nightsChanged = keptNights.length !== Object.keys(p.overnightNights).length;
        const daysChanged = keptDays.length !== Object.keys(p.dayOverrides).length;
        if (!nightsChanged && !daysChanged) return p;
        changed = true;
        return {
          ...p,
          overnightNights: nightsChanged ? Object.fromEntries(keptNights.map(([i, v]) => [Number(i), v])) : p.overnightNights,
          dayOverrides: daysChanged ? Object.fromEntries(keptDays.map(([i, v]) => [Number(i), v])) : p.dayOverrides,
        };
      });
      return changed ? next : prev;
    });
  }, [nights, days]);

  const overnightDuration = durations.find((d) => d.id === overnightDurationId);
  const visitDurations = durations.filter((d) => d.kind === 'visit');

  // ── per-client rules ────────────────────────────────────────────────────────

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
  const removePinned = (id: string) => patchRules({ pinnedTimes: rules.pinnedTimes.filter((p) => p.id !== id) });

  // ── packages ────────────────────────────────────────────────────────────────

  const suggestions = useMemo(() => patternsFor(durations, rules), [durations, rules]);

  const newPackage = (name: string, visits: Visit[], note = '') => {
    const pkg = normalizePackage({ id: uid(), name, visits, note });
    setPackages((prev) => [...prev, pkg]);
    setDetailId(pkg.id);
    setError('');
  };
  const addFromSuggestion = (pattern: DayPattern) => newPackage(pattern.strategyLabel, visitsFromPattern(pattern), pattern.note);
  const addBlankPackage = () => newPackage(`Package ${packages.length + 1}`, visitsFromPinned(rules.pinnedTimes));
  const duplicatePackage = (id: string) => {
    const src = packages.find((p) => p.id === id);
    if (!src) return;
    const copy: Package = {
      ...src,
      id: uid(),
      name: `${src.name} copy`,
      visits: src.visits.map((v) => ({ ...v, id: uid() })),
      overnightNights: { ...src.overnightNights },
      dayOverrides: {},
    };
    setPackages((prev) => [...prev, copy]);
    setDetailId(copy.id);
  };
  const removePackage = (id: string) => {
    setPackages((prev) => prev.filter((p) => p.id !== id));
    setDetailId((prev) => (prev === id ? null : prev));
  };
  const patchPackage = (id: string, patch: Partial<Package>) =>
    setPackages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const patchVisit = (pkgId: string, visitId: string, patch: Partial<Visit>) =>
    setPackages((prev) =>
      prev.map((p) => (p.id !== pkgId ? p : { ...p, visits: p.visits.map((v) => (v.id === visitId ? { ...v, ...patch } : v)) })),
    );
  const addVisit = (pkgId: string) =>
    setPackages((prev) =>
      prev.map((p) =>
        p.id !== pkgId
          ? p
          : {
              ...p,
              visits: [
                ...p.visits,
                { id: uid(), time: timeToMinutes(rules.wakeStart) ?? 720, durationId: visitDurations[0]?.id ?? '', label: 'Check-in' },
              ],
            },
      ),
    );
  const removeVisit = (pkgId: string, visitId: string) =>
    setPackages((prev) => prev.map((p) => (p.id !== pkgId ? p : { ...p, visits: p.visits.filter((v) => v.id !== visitId) })));
  const toggleOvernight = (pkgId: string, nightIndex: number) =>
    setPackages((prev) =>
      prev.map((p) => (p.id !== pkgId ? p : { ...p, overnightNights: { ...p.overnightNights, [nightIndex]: !p.overnightNights[nightIndex] } })),
    );

  // Per-day customization: forks the template into that day's own editable list.
  const customizeDay = (pkgId: string, dayIndex: number) =>
    setPackages((prev) =>
      prev.map((p) => {
        if (p.id !== pkgId || p.dayOverrides[dayIndex]) return p;
        return { ...p, dayOverrides: { ...p.dayOverrides, [dayIndex]: p.visits.map((v) => ({ ...v, id: uid() })) } };
      }),
    );
  const resetDay = (pkgId: string, dayIndex: number) =>
    setPackages((prev) =>
      prev.map((p) => {
        if (p.id !== pkgId || !p.dayOverrides[dayIndex]) return p;
        const next = { ...p.dayOverrides };
        delete next[dayIndex];
        return { ...p, dayOverrides: next };
      }),
    );
  const patchDayVisit = (pkgId: string, dayIndex: number, visitId: string, patch: Partial<Visit>) =>
    setPackages((prev) =>
      prev.map((p) =>
        p.id !== pkgId || !p.dayOverrides[dayIndex]
          ? p
          : { ...p, dayOverrides: { ...p.dayOverrides, [dayIndex]: p.dayOverrides[dayIndex]!.map((v) => (v.id === visitId ? { ...v, ...patch } : v)) } },
      ),
    );
  const addDayVisit = (pkgId: string, dayIndex: number) =>
    setPackages((prev) =>
      prev.map((p) =>
        p.id !== pkgId || !p.dayOverrides[dayIndex]
          ? p
          : {
              ...p,
              dayOverrides: {
                ...p.dayOverrides,
                [dayIndex]: [...p.dayOverrides[dayIndex]!, { id: uid(), time: timeToMinutes(rules.wakeStart) ?? 720, durationId: visitDurations[0]?.id ?? '', label: 'Check-in' }],
              },
            },
      ),
    );
  const removeDayVisit = (pkgId: string, dayIndex: number, visitId: string) =>
    setPackages((prev) =>
      prev.map((p) =>
        p.id !== pkgId || !p.dayOverrides[dayIndex]
          ? p
          : { ...p, dayOverrides: { ...p.dayOverrides, [dayIndex]: p.dayOverrides[dayIndex]!.filter((v) => v.id !== visitId) } },
      ),
    );

  const startNewQuote = () => {
    // Rules are per-client, so reset them for the next one, repointed at the menu
    // (#728 made the service NAME the duration id, so the shipped pin needs realigning).
    const freshRules = alignPinnedToDurations(DEFAULT_COVERAGE_RULES, durations);
    // The next quote opens the way this one did: the three tiers already built.
    setPackages(packagesFromPatterns(patternsFor(durations, freshRules)));
    setDetailId(null);
    setClientName('');
    setStartDate(todayIso()); // same default a fresh load opens on
    setEndDate('');
    setRules(freshRules);
  };

  // ── pricing ─────────────────────────────────────────────────────────────────

  const priced = useMemo(
    () =>
      packages.map((p) => ({
        pkg: p,
        ...pricePackage(p, { days, nights, durations, overnightDuration }),
        // Warn against a day with no overnight — the one that has to stand on its own.
        warnings: gapWarnings(p.visits, rules.wakeStart, rules.wakeEnd, rules.maxGapHours, { eveningFrom: null, morningUntil: null, bonusFreeVisit: false }),
      })),
    [packages, days, nights, durations, overnightDuration, rules],
  );
  const detail = priced.find((p) => p.pkg.id === detailId) ?? null;

  const buildDetailQuote = (): string =>
    detail ? quoteText({ clientName, startDate, days, priced: { ...detail, pkg: detail.pkg } }) : '';

  const copyQuote = async (): Promise<void> => {
    const text = buildDetailQuote();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this quote:', text);
    }
  };
  const shareQuote = async (): Promise<void> => {
    const text = buildDetailQuote();
    if (!text) return;
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: 'TribeTails Coverage Package', text });
        return;
      } catch {
        // dismissed / unsupported → fall through to copy
      }
    }
    setShareNote('Sharing not available here — copied the quote instead.');
    window.setTimeout(() => setShareNote(null), 3000);
    await copyQuote();
  };
  const printQuote = (): void => window.print();

  const overnightEndLabel = (pkg: Package): string => {
    const s = timeToMinutes(pkg.overnightStart);
    if (s === null || !overnightDuration) return '';
    return minutesToTime(s + (Number(overnightDuration.minutes) || 0));
  };

  // Start date now defaults to today, so it no longer signals "there is a quote
  // here"; anything the operator actually typed does.
  const hasQuote = packages.length > 0 || clientName !== '' || endDate !== '' || startDate !== todayIso();

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="cpb">
      {durations.length === 0 ? (
        <Banner tone="warning" title="No KinCare types yet" className="cpb__banner cpb__noprint">
          Add your service lengths and prices under Settings, KinCare types. Packages price from that list.
        </Banner>
      ) : null}

      {/* Coverage window (dates) */}
      <DenPanel
        title="Coverage window"
        subtitle="The stay's dates. Packages price across this range."
        trailing={hasQuote ? <GhostButton label="Start new quote" onClick={startNewQuote} /> : undefined}
        className="cpb__noprint"
      >
        <div className="cpb__ruleRow">
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Client (optional)</span>
            <input className="cpb__input" placeholder="Kinfolk name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Start</span>
            <input className="cpb__input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">End</span>
            <input className="cpb__input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>
        {days > 0 ? (
          <p className="cpb__dayCount">
            <CalendarGlyph />
            {days} day{days !== 1 ? 's' : ''} of coverage · {nights} night{nights !== 1 ? 's' : ''} available
          </p>
        ) : null}
      </DenPanel>

      {/* Coverage rules */}
      <DenPanel title="Coverage rules for this client" subtitle="Per-client: they travel with this quote, not with your KinCare types. Seed the suggestions and gap warnings; not a hard gate." className="cpb__noprint">
        <div className="cpb__ruleRow">
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Day starts</span>
            <input className="cpb__input" type="time" value={rules.wakeStart} onChange={(e) => patchRules({ wakeStart: e.target.value })} />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Day ends</span>
            <input className="cpb__input" type="time" value={rules.wakeEnd} onChange={(e) => patchRules({ wakeEnd: e.target.value })} />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Max gap between visits (hrs)</span>
            <input className="cpb__input" type="number" min="1" step="0.5" value={rules.maxGapHours} onChange={(e) => patchRules({ maxGapHours: parseFloat(e.target.value) || 1 })} />
          </label>
          <label className="cpb__field">
            <span className="cpb__fieldLabel">Overnight duration</span>
            <select className="cpb__input" value={overnightDurationId} onChange={(e) => setOvernightDurationId(e.target.value)}>
              {durations.filter((d) => d.kind === 'overnight').map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} — ${d.price}
                </option>
              ))}
              {durations.every((d) => d.kind !== 'overnight') ? <option value="">no overnight in your KinCare types</option> : null}
            </select>
          </label>
        </div>
        <p className="cpb__hint">
          Lengths and prices come from your KinCare types in Settings. A type whose name contains "overnight" prices as a
          window: a 12hr overnight from 9:00 PM runs to 9:00 AM, so anything before then is already covered.
        </p>

        <div className="cpb__pinned">
          <p className="cpb__pinnedHeading">Pinned visits — this client's non-negotiables. New blank packages start with these.</p>
          {rules.pinnedTimes.map((p) => (
            <div key={p.id} className="cpb__pinnedRow">
              <span className="cpb__pinnedLabel">{p.label}</span>
              <span className="cpb__pinnedTime">{p.time ? minutesToTime(timeToMinutes(p.time) ?? 0) : ''}</span>
              <span className="cpb__pinnedDuration">{durations.find((d) => d.id === p.durationId)?.label ?? ''}</span>
              <IconButton icon={<TrashGlyph />} label={`Remove ${p.label}`} destructive size={30} onClick={() => removePinned(p.id)} />
            </div>
          ))}
          <div className="cpb__addRow">
            <input className="cpb__input cpb__input--grow" placeholder="e.g. Medication" value={newPinned.label} onChange={(e) => setNewPinned({ ...newPinned, label: e.target.value })} />
            <input className="cpb__input" type="time" aria-label="Pinned time" value={newPinned.time} onChange={(e) => setNewPinned({ ...newPinned, time: e.target.value })} />
            <select className="cpb__input cpb__select" aria-label="Pinned visit length" value={newPinned.durationId} onChange={(e) => setNewPinned({ ...newPinned, durationId: e.target.value })}>
              <option value="">visit length…</option>
              {durations.map((d) => (
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

      {/* Packages */}
      <DenPanel
        title="Packages"
        subtitle="Lean, Balance and Premium are built from this client's rules the moment a quote opens; build your own beside them. Mix any visit lengths, a 15-min lunch check-in with a 60-min evening, however you like."
        trailing={
          <span className="cpb__seedRow">
            {suggestions.map((s) => (
              <GhostButton key={s.id} label={`Add ${s.strategyLabel} ($${s.dayTotal.toFixed(0)}/day)`} leading={<SparklesGlyph />} onClick={() => addFromSuggestion(s)} />
            ))}
            <PrimaryButton label="New package" leading={<PlusGlyph />} onClick={addBlankPackage} />
          </span>
        }
        className="cpb__noprint"
      >
        {packages.length === 0 ? (
          <p className="cpb__hint">
            Every tier here was deleted. Add one back above, or start an empty package and change any visit's time and length.
          </p>
        ) : (
          <div className="cpb__pkgGrid">
            {priced.map(({ pkg, subtotal, discount, discountPct, total, warnings }) => (
              <div key={pkg.id} className={detailId === pkg.id ? 'cpb__pkg cpb__pkg--active' : 'cpb__pkg'}>
                <div className="cpb__pkgHead">
                  <input className="cpb__input cpb__pkgName" aria-label="Package name" value={pkg.name} onChange={(e) => patchPackage(pkg.id, { name: e.target.value })} />
                  <IconButton icon={<CopyGlyph />} label="Duplicate package" size={30} onClick={() => duplicatePackage(pkg.id)} />
                  <IconButton icon={<TrashGlyph />} label="Delete package" destructive size={30} onClick={() => removePackage(pkg.id)} />
                </div>

                {pkg.note ? <p className="cpb__pkgNote">{pkg.note}</p> : null}

                <p className="cpb__pkgSectionLabel">Every day of the stay</p>
                <div className="cpb__visitList">
                  {[...pkg.visits].sort((a, b) => a.time - b.time).map((v) => (
                    <VisitRow key={v.id} visit={v} durations={durations} onPatch={(patch) => patchVisit(pkg.id, v.id, patch)} onRemove={() => removeVisit(pkg.id, v.id)} />
                  ))}
                  {pkg.visits.length === 0 ? <p className="cpb__miniEmpty">No visits yet.</p> : null}
                </div>
                <button type="button" className="cpb__addVisitBtn" onClick={() => addVisit(pkg.id)}>
                  <PlusGlyph /> Add visit
                </button>

                {warnings.length > 0 ? (
                  <div className="cpb__warn">
                    <AlertGlyph />
                    <div>
                      {warnings.map((w, i) => (
                        <div key={i}>
                          {w} — over your {rules.maxGapHours}h max gap on a night with no overnight
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <p className="cpb__pkgSectionLabel">Overnights</p>
                <div className="cpb__cfgRow">
                  <label className="cpb__field">
                    <span className="cpb__fieldLabel">Starts</span>
                    <input className="cpb__input" type="time" value={pkg.overnightStart} onChange={(e) => patchPackage(pkg.id, { overnightStart: e.target.value })} />
                  </label>
                  <label className="cpb__field">
                    <span className="cpb__fieldLabel">Buffer (hrs)</span>
                    <input className="cpb__input" type="number" min="0" step="0.5" value={pkg.overnightBufferHours} onChange={(e) => patchPackage(pkg.id, { overnightBufferHours: parseFloat(e.target.value) || 0 })} />
                  </label>
                </div>
                {overnightDuration ? (
                  <p className="cpb__cfgNote">
                    <MoonGlyph /> {overnightDuration.label} → covers until {overnightEndLabel(pkg)}, plus one free visit the next day
                  </p>
                ) : null}

                {nights === 0 ? (
                  <p className="cpb__miniEmpty">{days > 0 ? 'Single day — no nights.' : 'Set a date range above.'}</p>
                ) : !overnightDuration ? (
                  <p className="cpb__miniEmpty">No overnight in your KinCare types (add one in Settings).</p>
                ) : (
                  <div className="cpb__nightChips">
                    {Array.from({ length: nights }).map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        className={pkg.overnightNights[i] ? 'cpb__nightChip cpb__nightChip--on' : 'cpb__nightChip'}
                        onClick={() => toggleOvernight(pkg.id, i)}
                        title={`Night of ${dateLabel(startDate, i) || `day ${i + 1}`}`}
                      >
                        {dateLabel(startDate, i, { month: 'short', day: 'numeric' }) || `N${i + 1}`}
                      </button>
                    ))}
                  </div>
                )}

                <p className="cpb__pkgSectionLabel">Discount</p>
                <div className="cpb__discountRow">
                  <input className="cpb__input cpb__input--grow" placeholder="e.g. Military" value={pkg.discountLabel} onChange={(e) => patchPackage(pkg.id, { discountLabel: e.target.value })} />
                  <span className="cpb__unitField cpb__pctField">
                    <input className="cpb__input cpb__input--num" type="number" min="0" max="100" step="1" placeholder="0" aria-label="Discount percent" value={pkg.discountPct || ''} onChange={(e) => patchPackage(pkg.id, { discountPct: parseFloat(e.target.value) || 0 })} />
                    <span className="cpb__unit">%</span>
                  </span>
                </div>

                <div className="cpb__pkgTotals">
                  {days === 0 ? (
                    <p className="cpb__miniEmpty">Set a date range to price this.</p>
                  ) : (
                    <>
                      <div className="cpb__totalLine">
                        <span>Subtotal</span>
                        <span>${subtotal.toFixed(2)}</span>
                      </div>
                      {discountPct > 0 ? (
                        <div className="cpb__totalLine cpb__totalLine--discount">
                          <span>{pkg.discountLabel || 'Discount'} ({discountPct}%)</span>
                          <span>−${discount.toFixed(2)}</span>
                        </div>
                      ) : null}
                      <div className="cpb__totalLine cpb__totalLine--final">
                        <span>Total</span>
                        <span>${total.toFixed(2)}</span>
                      </div>
                      <GhostButton
                        label={detailId === pkg.id ? 'Hide day-by-day' : 'View day-by-day'}
                        onClick={() => setDetailId(detailId === pkg.id ? null : pkg.id)}
                      />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </DenPanel>

      {/* Day-by-day detail + quote (also the print surface) */}
      {detail && days > 0 ? (
        <DenPanel className="cpb__printSurface" title={`${clientName ? `${clientName} — ` : ''}${detail.pkg.name}`} subtitle={`${days} day${days !== 1 ? 's' : ''}${startDate ? ` · ${dateLabel(startDate, 0)} – ${dateLabel(startDate, days - 1)}` : ''}`}>
          <div className="cpb__detailActions cpb__noprint">
            <GhostButton label={copied ? 'Copied' : 'Copy quote'} leading={copied ? <CheckGlyph /> : <CopyGlyph />} onClick={() => void copyQuote()} />
            <GhostButton label="Share" leading={<ShareGlyph />} onClick={() => void shareQuote()} />
            <PrimaryButton label="Print / Save PDF" leading={<PrinterGlyph />} onClick={printQuote} />
          </div>
          {shareNote ? <p className="cpb__hint cpb__noprint">{shareNote}</p> : null}

          <div className="cpb__nightList">
            {detail.rows.map((row) => (
              <DayDetailRow
                key={row.dayIndex}
                row={row}
                pkg={detail.pkg}
                durations={durations}
                startDate={startDate}
                onCustomize={() => customizeDay(detail.pkg.id, row.dayIndex)}
                onReset={() => resetDay(detail.pkg.id, row.dayIndex)}
                onPatchVisit={(vid, patch) => patchDayVisit(detail.pkg.id, row.dayIndex, vid, patch)}
                onAddVisit={() => addDayVisit(detail.pkg.id, row.dayIndex)}
                onRemoveVisit={(vid) => removeDayVisit(detail.pkg.id, row.dayIndex, vid)}
              />
            ))}
          </div>

          <div className="cpb__finalPrice">
            <div>
              <div className="cpb__finalPriceLabel">{clientName ? `${clientName}'s package` : 'Package total'}</div>
              <div className="cpb__finalPriceSub">
                {detail.pkg.name} · {days} day{days !== 1 ? 's' : ''}
                {detail.discountPct > 0 ? ` · ${detail.pkg.discountLabel || 'Discount'} ${detail.discountPct}% off $${detail.subtotal.toFixed(2)}` : ''}
              </div>
            </div>
            <div className="cpb__finalPriceValue">${detail.total.toFixed(2)}</div>
          </div>
        </DenPanel>
      ) : null}
    </div>
  );
}

// ── sub-components ──────────────────────────────────────────────────────────────

function VisitRow({
  visit,
  durations,
  onPatch,
  onRemove,
}: {
  visit: Visit;
  durations: readonly Duration[];
  onPatch: (patch: Partial<Visit>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="cpb__visitRow">
      <input
        className="cpb__input cpb__visitTime"
        type="time"
        aria-label="Visit time"
        value={minutesToInput(visit.time)}
        onChange={(e) => {
          const m = timeToMinutes(e.target.value);
          if (m !== null) onPatch({ time: m });
        }}
      />
      <select className="cpb__input cpb__visitDuration" aria-label="Visit length" value={visit.durationId} onChange={(e) => onPatch({ durationId: e.target.value })}>
        <option value="">length…</option>
        {durations.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label} — ${d.price}
          </option>
        ))}
      </select>
      <input className="cpb__input cpb__visitLabel" placeholder="Label" value={visit.label} onChange={(e) => onPatch({ label: e.target.value })} />
      <IconButton icon={<TrashGlyph />} label="Remove visit" destructive size={30} onClick={onRemove} />
    </div>
  );
}

function DayItemsReadonly({ row }: { row: PricedDayRow }) {
  return (
    <ul className="cpb__dayItemList">
      {row.items.map((it) => (
        <li key={it.key} className={it.free ? 'cpb__dayItem cpb__dayItem--covered' : 'cpb__dayItem'}>
          <span className="cpb__dayItemTime">{minutesToTime(it.time)}</span>
          <span className="cpb__dayItemLabel">
            {it.label} ({it.durationLabel})
            {it.freeReason ? <span className="cpb__coverTag"> — {it.freeReason}</span> : null}
          </span>
          <span className={it.free ? 'cpb__dayItemFree' : 'cpb__dayItemPrice'}>{it.free ? '—' : `$${it.price.toFixed(2)}`}</span>
        </li>
      ))}
      {row.items.length === 0 ? (
        <li className="cpb__dayItem">
          <span className="cpb__dayItemLabel">No visits this day</span>
        </li>
      ) : null}
      {row.isOvernight && row.overnightStartMin !== null ? (
        <li className="cpb__dayItem">
          <span className="cpb__dayItemTime">{minutesToTime(row.overnightStartMin)}</span>
          <span className="cpb__dayItemLabel">{row.overnightLabel}</span>
          <span className="cpb__dayItemPrice">${row.overnightCost.toFixed(2)}</span>
        </li>
      ) : null}
    </ul>
  );
}

function DayDetailRow({
  row,
  pkg,
  durations,
  startDate,
  onCustomize,
  onReset,
  onPatchVisit,
  onAddVisit,
  onRemoveVisit,
}: {
  row: PricedDayRow;
  pkg: Package;
  durations: readonly Duration[];
  startDate: string;
  onCustomize: () => void;
  onReset: () => void;
  onPatchVisit: (visitId: string, patch: Partial<Visit>) => void;
  onAddVisit: () => void;
  onRemoveVisit: (visitId: string) => void;
}) {
  const dayVisits = [...effectiveVisits(pkg, row.dayIndex)].sort((a, b) => a.time - b.time);
  return (
    <div className="cpb__nightRow">
      <div className="cpb__nightRowTop">
        <span className="cpb__nightRowLabel">
          Day {row.dayIndex + 1}
          {startDate ? <span className="cpb__nightRowDate">{dateLabel(startDate, row.dayIndex)}</span> : null}
        </span>
        <span className="cpb__nightToggleNote">
          {row.isOvernight && row.overnightStartMin !== null
            ? `Overnight — ${row.overnightLabel} from ${minutesToTime(row.overnightStartMin)}`
            : row.canOvernight
              ? 'No overnight'
              : 'Client returns — no overnight'}
        </span>
        <span className="cpb__nightRowPrice">${row.dayCost.toFixed(2)}</span>
      </div>

      {row.customized ? (
        <>
          <div className="cpb__dayEditor cpb__noprint">
            {dayVisits.map((v) => {
              const it = row.items.find((i) => i.key === v.id);
              return (
                <div key={v.id} className="cpb__dayEditRow">
                  <input
                    className="cpb__input cpb__visitTime"
                    type="time"
                    aria-label="Visit time"
                    value={minutesToInput(v.time)}
                    onChange={(e) => {
                      const m = timeToMinutes(e.target.value);
                      if (m !== null) onPatchVisit(v.id, { time: m });
                    }}
                  />
                  <select className="cpb__input cpb__visitDuration" aria-label="Visit length" value={v.durationId} onChange={(e) => onPatchVisit(v.id, { durationId: e.target.value })}>
                    <option value="">length…</option>
                    {durations.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label} — ${d.price}
                      </option>
                    ))}
                  </select>
                  <input className="cpb__input cpb__visitLabel" placeholder="Label" value={v.label} onChange={(e) => onPatchVisit(v.id, { label: e.target.value })} />
                  <span className={it && it.free ? 'cpb__dayEditTag cpb__dayEditTag--free' : 'cpb__dayEditTag'}>
                    {it ? (it.free ? it.freeReason || 'free' : `$${it.price.toFixed(2)}`) : ''}
                  </span>
                  <IconButton icon={<TrashGlyph />} label="Remove visit" destructive size={28} onClick={() => onRemoveVisit(v.id)} />
                </div>
              );
            })}
            {dayVisits.length === 0 ? <p className="cpb__miniEmpty">No visits this day.</p> : null}
            <button type="button" className="cpb__addVisitBtn" onClick={onAddVisit}>
              <PlusGlyph /> Add visit to this day
            </button>
            {row.isOvernight && row.overnightStartMin !== null ? (
              <p className="cpb__dayEditOvernight">
                + {row.overnightLabel} from {minutesToTime(row.overnightStartMin)} — ${row.overnightCost.toFixed(2)}
              </p>
            ) : null}
          </div>
          {/* print mirror */}
          <div className="cpb__printonly">
            <DayItemsReadonly row={row} />
          </div>
        </>
      ) : (
        <DayItemsReadonly row={row} />
      )}

      <div className="cpb__dayCustomizeRow cpb__noprint">
        {row.customized ? (
          <>
            <span className="cpb__customBadge">Customized</span>
            <button type="button" className="cpb__linkBtn" onClick={onReset}>
              Reset to template
            </button>
          </>
        ) : (
          <button type="button" className="cpb__linkBtn" onClick={onCustomize}>
            Customize this day
          </button>
        )}
      </div>
    </div>
  );
}

// ── inline glyphs (the repo installs no icon set; one SVG per glyph) ────────────

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
function CalendarGlyph() {
  return (
    <svg {...glyphProps()} className="cpb__glyphInline">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}
function CopyGlyph() {
  return (
    <svg {...glyphProps()}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function ShareGlyph() {
  return (
    <svg {...glyphProps()}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5" />
    </svg>
  );
}
function PrinterGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </svg>
  );
}
function MoonGlyph() {
  return (
    <svg {...glyphProps()} className="cpb__glyphInline">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function SparklesGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  );
}
function AlertGlyph() {
  return (
    <svg {...glyphProps()} className="cpb__glyphWarn">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
