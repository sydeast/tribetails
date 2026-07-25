import { useId, type ReactNode } from 'react';
import { useRovingTabs } from '../lib/useRovingTabs';
import './ListToolbar.css';

/**
 * The shared header for a long, server-paged list: a search box, the date-range
 * window, and any number of facet selects.
 *
 * CONTROLLED, ALWAYS. This component holds no query state of its own. It renders
 * exactly what it is handed and reports what the operator did, because the same
 * three values also drive `usePagedCollection`'s spec, and a control that
 * remembered its own value would let the chips and the query disagree about
 * which window is on screen. The list would then be honest and the toolbar
 * would be lying, which is the worse of the two failures.
 *
 * The presets are a `tablist` of `tab`s rather than a radiogroup because that is
 * already what every filter chip row in this admin is (Invoices, Bookings,
 * Sessions, KinTales, Communicate, Inbox, TribalIntel, NotificationGate,
 * Directory, Templates, settings/SectionNav), and they all take their arrow-key
 * behaviour from `lib/useRovingTabs.ts`. A second convention for the same visual
 * control is a worse outcome than either convention alone.
 */

export type DateRangeKey = '7d' | '30d' | '90d' | 'all';

export interface DateRangePreset {
  key: DateRangeKey;
  label: string;
  /** Days back from now, or null for "no lower bound at all". */
  days: number | null;
}

/**
 * The Phase 4 windows. Order is the render order, and the FIRST is the default,
 * which is why the default is derived from this list rather than written twice.
 */
export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  // Named "(archive)" rather than plain "All" so the cost is visible before the
  // click: this is the one preset with no server-side lower bound.
  { key: 'all', label: 'All (archive)', days: null },
];

export const DEFAULT_DATE_RANGE: DateRangeKey = DATE_RANGE_PRESETS[0]?.key ?? '7d';

/**
 * The lower bound of a window as an ISO string, or null for the archive.
 *
 * Null and not the epoch: a screen must add NO range predicate for "All", not a
 * predicate that happens to match everything. An always-true `where` still
 * changes the query plan and still demands the composite index, so the two would
 * behave differently for no reason the operator could see.
 *
 * ISO because that is the shape these collections actually store their sort keys
 * in: `kin_care_reports.createdAt` and `kin_care_sessions.startTime` are opaque
 * ISO text written client-side, not Firestore Timestamps (see `api/kinTales.ts`
 * and `api/sessions.ts`). A screen whose sort key IS a Timestamp converts once
 * at its own boundary.
 */
export function rangeStartIso(key: DateRangeKey, now: Date): string | null {
  const days = DATE_RANGE_PRESETS.find((p) => p.key === key)?.days ?? null;
  if (days === null) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export interface ListToolbarFacet {
  /** Stable per screen; used for the control's id, not sent anywhere. */
  id: string;
  /** Visible label, e.g. "Household". */
  label: string;
  /** The selected option's value. Empty string means "all". */
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  /** Overrides the generated "All <label>s" wording where that reads wrong. */
  allLabel?: string;
}

export interface ListToolbarProps {
  /** Accessible name for the toolbar region, e.g. "Filter invoices". */
  label: string;
  search: string;
  onSearchChange: (value: string) => void;
  /** Accessible name AND placeholder for the search box. */
  searchLabel: string;
  range: DateRangeKey;
  onRangeChange: (key: DateRangeKey) => void;
  facets?: readonly ListToolbarFacet[];
  /**
   * The scope line. Every screen using this is searching a WINDOW, not the
   * collection, and the operator cannot tell the difference from the rows alone,
   * so the screen states it here.
   */
  note?: ReactNode;
}

export function ListToolbar({
  label,
  search,
  onSearchChange,
  searchLabel,
  range,
  onRangeChange,
  facets,
  note,
}: ListToolbarProps) {
  const baseId = useId();
  const activeIndex = Math.max(
    0,
    DATE_RANGE_PRESETS.findIndex((p) => p.key === range),
  );
  const { getTabProps } = useRovingTabs({
    count: DATE_RANGE_PRESETS.length,
    activeIndex,
  });

  return (
    <section className="list-toolbar" aria-label={label}>
      <div className="list-toolbar__row">
        <div className="list-toolbar__field list-toolbar__field--search">
          <label className="list-toolbar__label" htmlFor={`${baseId}-search`}>
            {searchLabel}
          </label>
          <input
            id={`${baseId}-search`}
            className="list-toolbar__input"
            type="search"
            value={search}
            placeholder={searchLabel}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {facets?.map((facet) => (
          <div className="list-toolbar__field" key={facet.id}>
            <label className="list-toolbar__label" htmlFor={`${baseId}-${facet.id}`}>
              {facet.label}
            </label>
            <select
              id={`${baseId}-${facet.id}`}
              className="list-toolbar__select"
              value={facet.value}
              onChange={(e) => facet.onChange(e.target.value)}
            >
              <option value="">{facet.allLabel ?? `All ${facet.label.toLowerCase()}s`}</option>
              {facet.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="list-toolbar__chips" role="tablist" aria-label="Date range">
        {DATE_RANGE_PRESETS.map((preset, index) => (
          <button
            key={preset.key}
            type="button"
            role="tab"
            aria-selected={preset.key === range}
            className={
              preset.key === range
                ? 'list-toolbar__chip list-toolbar__chip--active'
                : 'list-toolbar__chip'
            }
            onClick={() => onRangeChange(preset.key)}
            {...getTabProps(index)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {note !== undefined && note !== null && <p className="list-toolbar__note">{note}</p>}
    </section>
  );
}
