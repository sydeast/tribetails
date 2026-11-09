import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import {
  DEFAULT_COVERAGE_RULES,
  alignPinnedToDurations,
  buildDayPatterns,
  dateLabel,
  dateRangeRefusal,
  daysBetween,
  durationsFromServiceRates,
  effectiveVisits,
  gapWarnings,
  minutesToInput,
  parseMaxGapHours,
  minutesToTime,
  normalizePackage,
  packagesFromPatterns,
  parseBufferHours,
  parseDiscountPct,
  pricePackage,
  quoteText,
  uniqueCopyName,
  sanitizeStoredRules,
  storedMaxGapRefusal,
  storedPackageRefusals,
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
import { formatUsd } from '../lib/invoiceFormat';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel, InfoTip } from '../components/DenScreenKit';
import { LoadingRow } from '../components/LoadingRow';
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
        loading={<LoadingRow label="Loading your KinCare rates…" className="cpb__hint" />}
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

/** A package's Discount % or Buffer (hrs) field, as a key into the typed-text map. */
type PackageField = 'discount' | 'buffer';
const fieldKey = (pkgId: string, field: PackageField): string => `${pkgId}:${field}`;
interface LoadedQuote extends Partial<StoredQuote> {
  /** Stored discount / buffer values the fields would refuse, keyed by `fieldKey`, shown as stored (#1593). */
  refusedText: Record<string, string>;
}
function loadQuote(): LoadedQuote {
  try {
    const raw = window.localStorage.getItem(QUOTE_KEY);
    if (!raw) return { refusedText: {} };
    const parsed = JSON.parse(raw) as Partial<StoredQuote>;
    const refusedText: Record<string, string> = {};
    const packages = Array.isArray(parsed.packages)
      ? parsed.packages.map((stored) => {
          const pkg = normalizePackage(stored);
          const refused = storedPackageRefusals(stored);
          if (refused.discount !== null) refusedText[fieldKey(pkg.id, 'discount')] = refused.discount;
          if (refused.buffer !== null) refusedText[fieldKey(pkg.id, 'buffer')] = refused.buffer;
          return pkg;
        })
      : [];
    return { ...parsed, packages, refusedText };
  } catch {
    return { refusedText: {} };
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
  const initialRules = alignPinnedToDurations(sanitizeStoredRules(stored.rules ?? DEFAULT_COVERAGE_RULES), durations);
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
  // End before Start is refused beside End and prices nothing (#1593). Derived from
  // the dates, so a stored quote with a reversed range opens with the message.
  const dateError = dateRangeRefusal(startDate, endDate);

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
  // A refused (reversed) range is not a shrink: picking the wrong End must not wipe
  // the operator's overnight nights and day edits (#1593).
  useEffect(() => {
    if (dateError !== null) return;
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
  }, [nights, days, dateError]);

  const overnightDuration = durations.find((d) => d.id === overnightDurationId);
  const visitDurations = durations.filter((d) => d.kind === 'visit');

  // ── per-client rules ────────────────────────────────────────────────────────

  const patchRules = (patch: Partial<CoverageRules>) => setRules((r) => ({ ...r, ...patch }));
  // What is typed in Max gap, kept apart from the rule it feeds (#1582). A half-typed
  // or negative entry is refused here with a message; the rule, and every price
  // built from it, keeps the last good value until the text reads as a valid gap.
  // A stored gap the field would refuse (saved while it still coerced) is shown as
  // stored, with its message, and prices use the default until it is retyped.
  const storedRefusal = stored.rules ? storedMaxGapRefusal(stored.rules) : null;
  const [gapText, setGapText] = useState(
    storedRefusal !== null && stored.rules ? String(stored.rules.maxGapHours) : String(initialRules.maxGapHours),
  );
  const [gapError, setGapError] = useState(storedRefusal ?? '');
  // Rules that change from outside the field (Undo, a new quote) bring the text with
  // them. Only a CHANGE to the rule does this, never the first render, so a refused
  // stored gap keeps its message.
  const lastGap = useRef(rules.maxGapHours);
  useEffect(() => {
    if (lastGap.current === rules.maxGapHours) return;
    lastGap.current = rules.maxGapHours;
    const parsed = parseMaxGapHours(gapText);
    if (!(parsed.ok && parsed.value === rules.maxGapHours)) {
      setGapText(String(rules.maxGapHours));
      setGapError('');
    }
    // Only a change to the rule itself; typing never moves it away from the text.
  }, [rules.maxGapHours]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeGap = (text: string) => {
    setGapText(text);
    const parsed = parseMaxGapHours(text);
    if (parsed.ok) {
      setGapError('');
      patchRules({ maxGapHours: parsed.value });
    } else {
      setGapError(parsed.message);
    }
  };

  const addPinned = () => {
    if (!newPinned.label.trim() || !newPinned.time || !newPinned.durationId) {
      setError('Enter a label, time, and visit length for the pinned visit.');
      return;
    }
    patchRules({ pinnedTimes: [...rules.pinnedTimes, { id: uid(), ...newPinned }] });
    setNewPinned({ label: '', time: '', durationId: '' });
    setError('');
  };
  const removePinned = (id: string) => {
    const at = rules.pinnedTimes.findIndex((p) => p.id === id);
    const gone = rules.pinnedTimes[at];
    patchRules({ pinnedTimes: rules.pinnedTimes.filter((p) => p.id !== id) });
    if (gone) {
      offerUndo(`Removed the pinned visit "${gone.label}".`, () =>
        setRules((r) => (r.pinnedTimes.some((p) => p.id === gone.id) ? r : { ...r, pinnedTimes: [...r.pinnedTimes.slice(0, at), gone, ...r.pinnedTimes.slice(at)] })),
      );
    }
  };

  // ── packages ────────────────────────────────────────────────────────────────

  const suggestions = useMemo(() => patternsFor(durations, rules), [durations, rules]);

  // The one thing the last destructive action can give back (#1605). Trashing a
  // package or visit, resetting a day and Start new quote all wipe instantly, so
  // each leaves its undo here; the next destructive action replaces it.
  const [undo, setUndo] = useState<{ label: string; restore: () => void } | null>(null);
  const offerUndo = (label: string, restore: () => void) => setUndo({ label, restore });
  const runUndo = () => {
    if (undo === null) return;
    undo.restore();
    setUndo(null);
  };
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
      name: uniqueCopyName(src.name, packages.map((p) => p.name)),
      visits: src.visits.map((v) => ({ ...v, id: uid() })),
      overnightNights: { ...src.overnightNights },
      dayOverrides: {},
    };
    setPackages((prev) => [...prev, copy]);
    setDetailId(copy.id);
  };
  const removePackage = (id: string) => {
    const at = packages.findIndex((p) => p.id === id);
    const gone = packages[at];
    const wasOpen = detailId === id;
    setPackages((prev) => prev.filter((p) => p.id !== id));
    setDetailId((prev) => (prev === id ? null : prev));
    if (gone) {
      offerUndo(`Deleted package "${gone.name}".`, () => {
        setPackages((prev) => (prev.some((p) => p.id === gone.id) ? prev : [...prev.slice(0, at), gone, ...prev.slice(at)]));
        if (wasOpen) setDetailId(gone.id);
      });
    }
  };
  const patchPackage = (id: string, patch: Partial<Package>) =>
    setPackages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  // What is typed in each package's Discount % and Buffer (hrs), kept apart from the
  // value pricing uses (#1593, the #1582 Max gap pattern). Once a field is touched its
  // text stays exactly as typed; a refused entry shows its message beside the field and
  // the package keeps its last good value. A stored value the field would refuse opens
  // as stored, with its message, and prices at the default until it is retyped.
  const [fieldText, setFieldText] = useState<Record<string, string>>(stored.refusedText);
  const fieldParse = (field: PackageField) => (field === 'discount' ? parseDiscountPct : parseBufferHours);
  const fieldError = (pkgId: string, field: PackageField): string => {
    const text = fieldText[fieldKey(pkgId, field)];
    if (text === undefined) return '';
    const parsed = fieldParse(field)(text);
    return parsed.ok ? '' : parsed.message;
  };
  const changePackageField = (pkgId: string, field: PackageField, text: string) => {
    setFieldText((prev) => ({ ...prev, [fieldKey(pkgId, field)]: text }));
    const parsed = fieldParse(field)(text);
    if (parsed.ok) patchPackage(pkgId, field === 'discount' ? { discountPct: parsed.value } : { overnightBufferHours: parsed.value });
  };

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
  const removeVisit = (pkgId: string, visitId: string) => {
    const pkg = packages.find((p) => p.id === pkgId);
    const at = pkg ? pkg.visits.findIndex((v) => v.id === visitId) : -1;
    const gone = pkg && at >= 0 ? pkg.visits[at] : undefined;
    setPackages((prev) => prev.map((p) => (p.id !== pkgId ? p : { ...p, visits: p.visits.filter((v) => v.id !== visitId) })));
    if (gone) {
      offerUndo(`Removed the ${gone.label || 'visit'} from "${pkg!.name}".`, () =>
        setPackages((prev) =>
          prev.map((p) =>
            p.id !== pkgId || p.visits.some((v) => v.id === gone.id) ? p : { ...p, visits: [...p.visits.slice(0, at), gone, ...p.visits.slice(at)] },
          ),
        ),
      );
    }
  };
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
  const resetDay = (pkgId: string, dayIndex: number) => {
    const prior = packages.find((p) => p.id === pkgId)?.dayOverrides[dayIndex];
    setPackages((prev) =>
      prev.map((p) => {
        if (p.id !== pkgId || !p.dayOverrides[dayIndex]) return p;
        const next = { ...p.dayOverrides };
        delete next[dayIndex];
        return { ...p, dayOverrides: next };
      }),
    );
    if (prior) {
      offerUndo(`Day ${dayIndex + 1} is back on the template.`, () =>
        setPackages((prev) => prev.map((p) => (p.id !== pkgId || p.dayOverrides[dayIndex] ? p : { ...p, dayOverrides: { ...p.dayOverrides, [dayIndex]: prior } }))),
      );
    }
  };
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
  const removeDayVisit = (pkgId: string, dayIndex: number, visitId: string) => {
    const list = packages.find((p) => p.id === pkgId)?.dayOverrides[dayIndex];
    const at = list ? list.findIndex((v) => v.id === visitId) : -1;
    const gone = list && at >= 0 ? list[at] : undefined;
    setPackages((prev) =>
      prev.map((p) =>
        p.id !== pkgId || !p.dayOverrides[dayIndex]
          ? p
          : { ...p, dayOverrides: { ...p.dayOverrides, [dayIndex]: p.dayOverrides[dayIndex]!.filter((v) => v.id !== visitId) } },
      ),
    );
    if (gone) {
      offerUndo(`Removed the ${gone.label || 'visit'} from day ${dayIndex + 1}.`, () =>
        setPackages((prev) =>
          prev.map((p) => {
            const cur = p.dayOverrides[dayIndex];
            if (p.id !== pkgId || !cur || cur.some((v) => v.id === gone.id)) return p;
            return { ...p, dayOverrides: { ...p.dayOverrides, [dayIndex]: [...cur.slice(0, at), gone, ...cur.slice(at)] } };
          }),
        ),
      );
    }
  };

  const startNewQuote = () => {
    // Everything this wipes comes back whole with Undo (#1605).
    const snapshot = { packages, detailId, clientName, startDate, endDate, rules, overnightDurationId, gapText, gapError, fieldText };
    offerUndo('Started a new quote.', () => {
      setPackages(snapshot.packages);
      setDetailId(snapshot.detailId);
      setClientName(snapshot.clientName);
      setStartDate(snapshot.startDate);
      setEndDate(snapshot.endDate);
      setRules(snapshot.rules);
      // The Max gap text and its message come back with the rule they feed (#1582).
      setGapText(snapshot.gapText);
      setGapError(snapshot.gapError);
      // So do each package's typed Discount and Buffer (#1593).
      setFieldText(snapshot.fieldText);
      setOvernightDurationId(snapshot.overnightDurationId);
    });
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
    setGapText(String(freshRules.maxGapHours));
    setGapError('');
    setFieldText({});
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
          {/* A div, not a wrapping label: the message must not become part of the field's name. */}
          <div className="cpb__field">
            <label className="cpb__fieldLabel" htmlFor="cpb-end">End</label>
            <input
              id="cpb-end"
              className="cpb__input"
              type="date"
              value={endDate}
              aria-invalid={dateError !== null ? true : undefined}
              aria-describedby={dateError !== null ? 'cpb-end-error' : undefined}
              onChange={(e) => setEndDate(e.target.value)}
            />
            {dateError !== null ? (
              <span id="cpb-end-error" className="cpb__fieldError" role="alert">
                {dateError}
              </span>
            ) : null}
          </div>
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
          {/* A div, not a wrapping label: the message must not become part of the field's name. */}
          <div className="cpb__field">
            <label className="cpb__fieldLabel" htmlFor="cpb-gap">Max gap between visits (hrs)</label>
            <input
              id="cpb-gap"
              className="cpb__input"
              type="text"
              inputMode="decimal"
              value={gapText}
              aria-invalid={gapError !== '' ? true : undefined}
              aria-describedby={gapError !== '' ? 'cpb-gap-error' : undefined}
              onChange={(e) => changeGap(e.target.value)}
            />
            {gapError !== '' ? (
              <span id="cpb-gap-error" className="cpb__fieldError" role="alert">
                {gapError} Prices still use {rules.maxGapHours}h.
              </span>
            ) : null}
          </div>
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
          {/* #1595: a label and a tip, not a label with its explanation run on. */}
          <p className="cpb__pinnedHeading">
            Pinned visits <InfoTip text="This client's non-negotiables. New blank packages start with these." />
          </p>
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
                  <div className="cpb__field">
                    <label className="cpb__fieldLabel" htmlFor={`cpb-buffer-${pkg.id}`}>Buffer (hrs)</label>
                    <input
                      id={`cpb-buffer-${pkg.id}`}
                      className="cpb__input"
                      type="text"
                      inputMode="decimal"
                      value={fieldText[fieldKey(pkg.id, 'buffer')] ?? String(pkg.overnightBufferHours)}
                      aria-invalid={fieldError(pkg.id, 'buffer') !== '' ? true : undefined}
                      aria-describedby={fieldError(pkg.id, 'buffer') !== '' ? `cpb-buffer-error-${pkg.id}` : undefined}
                      onChange={(e) => changePackageField(pkg.id, 'buffer', e.target.value)}
                    />
                    {fieldError(pkg.id, 'buffer') !== '' ? (
                      <span id={`cpb-buffer-error-${pkg.id}`} className="cpb__fieldError" role="alert">
                        {fieldError(pkg.id, 'buffer')} Prices still use {pkg.overnightBufferHours}h.
                      </span>
                    ) : null}
                  </div>
                </div>
                {overnightDuration ? (
                  <p className="cpb__cfgNote">
                    <MoonGlyph /> {overnightDuration.label} → covers until {overnightEndLabel(pkg)}, plus one free visit the next day
                  </p>
                ) : null}

                {nights === 0 ? (
                  <p className="cpb__miniEmpty">{days > 0 ? 'Single day — no nights.' : dateError !== null ? 'Fix the end date above.' : 'Set a date range above.'}</p>
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
                    <input
                      className="cpb__input cpb__input--num"
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      aria-label="Discount percent"
                      value={fieldText[fieldKey(pkg.id, 'discount')] ?? (pkg.discountPct ? String(pkg.discountPct) : '')}
                      aria-invalid={fieldError(pkg.id, 'discount') !== '' ? true : undefined}
                      aria-describedby={fieldError(pkg.id, 'discount') !== '' ? `cpb-discount-error-${pkg.id}` : undefined}
                      onChange={(e) => changePackageField(pkg.id, 'discount', e.target.value)}
                    />
                    <span className="cpb__unit">%</span>
                  </span>
                </div>
                {fieldError(pkg.id, 'discount') !== '' ? (
                  <span id={`cpb-discount-error-${pkg.id}`} className="cpb__fieldError" role="alert">
                    {fieldError(pkg.id, 'discount')} Prices still use {pkg.discountPct}%.
                  </span>
                ) : null}

                <div className="cpb__pkgTotals">
                  {days === 0 ? (
                    <p className="cpb__miniEmpty">{dateError !== null ? 'Fix the end date above to price this.' : 'Set a date range to price this.'}</p>
                  ) : (
                    <>
                      <div className="cpb__totalLine">
                        <span>Subtotal</span>
                        <span>{formatUsd(subtotal)}</span>
                      </div>
                      {discountPct > 0 ? (
                        <div className="cpb__totalLine cpb__totalLine--discount">
                          <span>{pkg.discountLabel || 'Discount'} ({discountPct}%)</span>
                          <span>−{formatUsd(discount)}</span>
                        </div>
                      ) : null}
                      <div className="cpb__totalLine cpb__totalLine--final">
                        <span>Total</span>
                        <span>{formatUsd(total)}</span>
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
        <DenPanel className="cpb__printSurface" title={`${clientName ? `${clientName} — ` : ''}${detail.pkg.name}`} detail={`${days} day${days !== 1 ? 's' : ''}${startDate ? ` · ${dateLabel(startDate, 0)} – ${dateLabel(startDate, days - 1)}` : ''}`}>
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
                {detail.discountPct > 0 ? ` · ${detail.pkg.discountLabel || 'Discount'} ${detail.discountPct}% off ${formatUsd(detail.subtotal)}` : ''}
              </div>
            </div>
            <div className="cpb__finalPriceValue">{formatUsd(detail.total)}</div>
          </div>
        </DenPanel>
      ) : null}
      {/* Last in the flow and sticky to the bottom of the view, so the Undo is on
          screen wherever the trash was pressed, not at the top of a long page. */}
      {undo !== null ? (
        <Banner
          tone="info"
          className="cpb__undo cpb__noprint"
          dismissible
          onDismiss={() => setUndo(null)}
          trailing={<GhostButton label="Undo" onClick={runUndo} />}
        >
          {undo.label}
        </Banner>
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
          <span className={it.free ? 'cpb__dayItemFree' : 'cpb__dayItemPrice'}>{it.free ? '—' : formatUsd(it.price)}</span>
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
          <span className="cpb__dayItemPrice">{formatUsd(row.overnightCost)}</span>
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
        <span className="cpb__nightRowPrice">{formatUsd(row.dayCost)}</span>
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
                    {it ? (it.free ? it.freeReason || 'free' : formatUsd(it.price)) : ''}
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
                + {row.overnightLabel} from {minutesToTime(row.overnightStartMin)} — {formatUsd(row.overnightCost)}
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
            {row.changed ? <span className="cpb__customBadge">Customized</span> : null}
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
