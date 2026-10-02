import { useEffect, useRef, useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel, EmptyHint, InfoTip } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton, IconButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import { serviceDurationMinutes, storedDurationMinutes } from '../../lib/newBooking';
import '../SettingsEdit.css';
// The preview panel draws the booking wizard's own service chip, so it loads
// the stylesheet that chip is defined in rather than copying the rules.
import '../../components/NewBookingDialog.css';
import './KinCareRatesEditor.css';

/**
 * The KinCare-type sub-editor. Three columns: NAME, DURATION, RATE.
 *
 * It used to be two, name and rate, with the length of a visit living inside
 * the name ("30Minute", "Half-Day 6Hrs") and read back out by a regex whenever
 * anything needed to sort or schedule. Mark 15 of the 2026-08-17 walk ruled on
 * that: "change copy to Service Duration. OR we create a third attribute to the
 * kincare: duration. so kincare will have a name/title, duration, and price".
 * The operator picked the third attribute, and three columns.
 *
 * LAID OUT AS THE MOCK (`ui-ideas/auntieos-kincare-types-2026-05-27.html`,
 * issue #755): a rows panel with one column-header line, a name, duration and
 * rate input per row and a trash button at the end; a dashed "Add KinCare type"
 * that appends a blank row; a second panel previewing the exact chip the
 * booking screen renders from these rows; and one save bar under both with the
 * mock's "Unsaved changes" light. The mock's grip glyph is not drawn: nothing
 * here drags, and a handle that does nothing is a promise the screen breaks.
 *
 * TWO MAPS, NOT A RESHAPE. `serviceRates` stays `Record<name, rate>`, the shape
 * Schedule, the new-visit dialog, `getServiceCatalog`, the invoice rate card and
 * Android all read today; durations go in a parallel `serviceDurations` keyed by
 * the same name. Nothing needs migrating, no reader breaks, and a type saved
 * before this existed keeps the length its name always implied, because every
 * reader falls back to the name parse. Both maps are folded from the same rows
 * in one save, so a rename can never leave them disagreeing.
 *
 * THE DURATION COLUMN IS PREFILLED, NOT INVENTED. A row whose name states a
 * length shows it, greyed, as a placeholder rather than as a value: it is what
 * the app has always inferred, so it is honest to show, and writing it into the
 * document without the operator typing it would turn a guess into a fact.
 *
 * SORTING IS A VIEW, NEVER A WRITE. The walk asked for a sorter by rate and by
 * name. It reorders what is on screen and leaves the stored map alone, which is
 * why the rows keep their own identity (`RateRow`) rather than being re-keyed.
 *
 * Ported from the wasm `KinCareTypesPanel` (`SettingsScreen.kt`), which is where
 * the row-identity-vs-map-key discipline below comes from: a type name IS the
 * map key, so editing it in place needs a row identity independent of the key
 * that might be mid-edit. One combined Save/Cancel bar for the whole table, not
 * per-row, because a rename changes the map's whole key set.
 *
 * BOOK AT A START TIME (issue #1092). A third map, `serviceStartTimeBooking`,
 * marks the types kinfolk book by clock rather than by time block: an
 * overnight is twelve hours that can start at 21:00 or 07:00, which a block
 * inside one day cannot hold. The flag lives IN the row, like the duration, so
 * a rename carries it, and it is folded from the same rows in the same save.
 * The server ends such a visit by the type's length, so a flagged type with no
 * length anywhere is refused at Save, by name.
 */

interface KinCareRatesEditorProps {
  // `serviceStartTimeBooking` optional: absent reads as "no type flagged",
  // which is what every document written before #1092 means.
  data: Pick<BusinessSettings, 'serviceRates' | 'serviceDurations'> &
    Partial<Pick<BusinessSettings, 'serviceStartTimeBooking'>>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface RateRow {
  type: string;
  duration: string;
  rate: string;
  /**
   * Kinfolk ask for a night and the operator sets the start time on approval,
   * instead of booking a time block (#1092, #1098).
   */
  startTime: boolean;
}
/** The toggle's tooltip. A tooltip, not a subtitle: the 2026-09-11 ruling. */
const START_TIME_TIP =
  'Kinfolk ask for the night. You set the start time when you approve the request. Use it for overnights.';

/** How the table is ordered on screen. Never how it is stored. */
type SortKey = 'stored' | 'name' | 'rate' | 'duration';

const SORT_LABELS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'stored', label: 'As saved' },
  { key: 'name', label: 'Name' },
  { key: 'duration', label: 'Duration' },
  { key: 'rate', label: 'Rate' },
];

function toRows(
  rates: Record<string, string>,
  durations: Record<string, string>,
  startTimes: Record<string, true>,
): RateRow[] {
  return Object.entries(rates).map(([type, rate]) => ({
    type,
    duration: typeof durations[type] === 'string' ? durations[type] : '',
    rate,
    startTime: startTimes[type] === true,
  }));
}

/** Folds rows to the rate map: blank-name rows dropped, last row wins on a duplicate, matching the wasm `associate`. */
function foldRates(rows: RateRow[]): Record<string, string> {
  const edited: Record<string, string> = {};
  for (const row of rows) {
    const type = row.type.trim();
    if (type === '') continue;
    edited[type] = row.rate.trim();
  }
  return edited;
}

/**
 * Folds rows to the duration map, on the same rules, and with one more: a row
 * with a blank duration writes NO KEY at all rather than an empty one.
 *
 * The map is meant to be sparse. An empty string there would be a stored
 * statement that the operator gave a length, which is exactly what did not
 * happen, and it would stop the name-parse fallback from ever running for that
 * type.
 */
function foldDurations(rows: RateRow[]): Record<string, string> {
  const edited: Record<string, string> = {};
  for (const row of rows) {
    const type = row.type.trim();
    const duration = row.duration.trim();
    if (type === '' || duration === '') continue;
    edited[type] = duration;
  }
  return edited;
}

/**
 * Folds rows to the start-time map: only flagged rows write a key, and the
 * value is always `true`, the one value the server honours. Same blank-name
 * and last-row-wins rules as the other two folds, so an unflagged duplicate
 * after a flagged one REMOVES the key, as it would replace a rate.
 */
function foldStartTimeBooking(rows: RateRow[]): Record<string, true> {
  const edited: Record<string, true> = {};
  for (const row of rows) {
    const type = row.type.trim();
    if (type === '') continue;
    if (row.startTime) edited[type] = true;
    else delete edited[type];
  }
  return edited;
}
/**
 * The first flagged row the server could not give an end to: no length typed
 * and none in its name. Null when every flagged row has one.
 */
function startTimeRowMissingLength(rows: RateRow[]): string | null {
  for (const row of rows) {
    const type = row.type.trim();
    if (type === '' || !row.startTime) continue;
    if (rowMinutes(row) === null) return type;
  }
  return null;
}
function sameMap<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/**
 * Rate as a number for sorting. An unset or unparseable rate sorts LAST.
 *
 * The blank check is not redundant: `Number('')` is 0, so without it every
 * priceless row would sort to the top as if it were free.
 */
function rateRank(raw: string): number {
  const trimmed = raw.trim().replace(/^\$/, '');
  if (trimmed === '') return Number.MAX_SAFE_INTEGER;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * The minutes a row runs for, by the same two-source rule every reader uses:
 * what the operator typed, else what the name states, else nothing.
 */
function rowMinutes(row: RateRow): number | null {
  return storedDurationMinutes(row.duration) ?? serviceDurationMinutes(row.type);
}

/**
 * Orders rows for DISPLAY. Returns index-tagged rows, because every edit
 * handler below addresses a row by its position in the stored array and a
 * sorted view must not renumber what an edit is aimed at.
 */
function sortedView(rows: RateRow[], key: SortKey): Array<{ row: RateRow; index: number }> {
  const tagged = rows.map((row, index) => ({ row, index }));
  if (key === 'stored') return tagged;
  // Stable (ES2019+), so rows that tie keep the order they were saved in.
  return tagged.sort((a, b) => {
    if (key === 'name') return a.row.type.trim().localeCompare(b.row.type.trim(), undefined, { numeric: true });
    if (key === 'rate') return rateRank(a.row.rate) - rateRank(b.row.rate);
    return (rowMinutes(a.row) ?? Number.MAX_SAFE_INTEGER) - (rowMinutes(b.row) ?? Number.MAX_SAFE_INTEGER);
  });
}

/** The booking wizard's price line for a chip, byte for byte (`ServiceStep`). */
function chipPrice(rate: string): string {
  const trimmed = rate.trim();
  return trimmed === '' ? 'No price set' : `$${trimmed}`;
}

export function KinCareRatesEditor({ data, onSave }: KinCareRatesEditorProps) {
  // Seeded ONCE from `data` at mount, the `TextFieldsSection` convention.
  const storedStartTimes = data.serviceStartTimeBooking ?? {};
  const [rows, setRows] = useState<RateRow[]>(() =>
    toRows(data.serviceRates, data.serviceDurations, storedStartTimes),
  );
  const [sortKey, setSortKey] = useState<SortKey>('stored');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // The stored index of a row "Add KinCare type" just appended, so its name
  // input takes focus once it exists. Cleared the moment it has been used.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const nameInputs = useRef<Map<number, HTMLInputElement>>(new Map());

  useEffect(() => {
    if (focusIndex === null) return;
    nameInputs.current.get(focusIndex)?.focus();
    setFocusIndex(null);
  }, [focusIndex]);

  const editedRates = foldRates(rows);
  const editedDurations = foldDurations(rows);
  const editedStartTimes = foldStartTimeBooking(rows);
  const dirty =
    !sameMap(editedRates, data.serviceRates) ||
    !sameMap(editedDurations, data.serviceDurations) ||
    !sameMap(editedStartTimes, storedStartTimes);

  function markDirtyEdit() {
    setJustSaved(false);
  }

  function updateRow(i: number, patch: Partial<RateRow>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
    markDirtyEdit();
  }

  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
    markDirtyEdit();
  }

  /**
   * The mock's add: a blank row appears at the end of the table and its name
   * takes focus. A row left blank is dropped by `foldRates`, so an abandoned
   * add never reaches the document and never makes the bar read dirty.
   */
  function addRow() {
    setFocusIndex(rows.length);
    setRows((r) => [...r, { type: '', duration: '', rate: '', startTime: false }]);
    markDirtyEdit();
  }

  async function handleSave() {
    if (!dirty || busy) return;
    // Refused before anything is written: the server ends a start-time visit
    // by the type's length, and with none it would book a visit with no end.
    const missing = startTimeRowMissingLength(rows);
    if (missing !== null) {
      setError({ title: 'Not saved', message: `"${missing}" needs a length so its end time can be worked out.` });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        serviceRates: editedRates,
        serviceDurations: editedDurations,
        serviceStartTimeBooking: editedStartTimes,
      });
      setJustSaved(true);
    } catch (err) {
      setError({ title: 'Save failed', message: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setRows(toRows(data.serviceRates, data.serviceDurations, storedStartTimes));
    setError(null);
    setJustSaved(false);
  }

  const view = sortedView(rows, sortKey);
  const typeCount = rows.length === 1 ? '1 type' : `${rows.length} types`;

  return (
    <div className="kinCareRates">
      <DenPanel
        title="Your KinCare types"
        subtitle="Add, rename, re-rate, or remove. Most operators go by length of visit (30 min, 60 min, Overnight) but you can name them anything. Saving updates the booking screen for new requests. A greyed duration is what the name implies; it is never saved unless you type it."
        {...(rows.length > 0 ? { meta: typeCount } : {})}
      >
        {error ? (
          <Banner tone="error" title={error.title} className="settingsEdit__sectionBanner">
            {error.message}
          </Banner>
        ) : null}

        {rows.length === 0 ? <EmptyHint>No KinCare types yet. Add one below.</EmptyHint> : null}

        {rows.length > 1 ? (
          <div className="kinCareRates__sort" role="group" aria-label="Sort KinCare types">
            <span className="kinCareRates__sortLabel">Sort by</span>
            {SORT_LABELS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className="kinCareRates__sortButton"
                aria-pressed={sortKey === key}
                onClick={() => setSortKey(key)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="kinCareRates__table">
            {/* One header line for the whole table, the mock's `.rhead`. Hidden
                from assistive technology because every input below carries its
                own name; the line is for eyes scanning a column. */}
            <div className="kinCareRates__head" aria-hidden="true">
              <span>Type name</span>
              <span>Duration (min)</span>
              <span>Rate</span>
              <span />
            </div>
            <ul className="kinCareRates__list">
              {view.map(({ row, index }) => {
                // What the name implies, shown as a placeholder when nothing is
                // stored. Visible, and not written unless the operator types it.
                const impliedMinutes = row.duration.trim() === '' ? serviceDurationMinutes(row.type) : null;
                return (
                  <li key={index} className="kinCareRates__row">
                    <input
                      type="text"
                      className="settingsEdit__input"
                      aria-label="Name"
                      placeholder="e.g. 30 min"
                      value={row.type}
                      disabled={busy}
                      ref={(el) => {
                        if (el) nameInputs.current.set(index, el);
                        else nameInputs.current.delete(index);
                      }}
                      onChange={(e) => updateRow(index, { type: e.target.value })}
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      className="settingsEdit__input kinCareRates__mono"
                      aria-label="Duration (min)"
                      placeholder={impliedMinutes === null ? 'Not set' : `${impliedMinutes} (from the name)`}
                      value={row.duration}
                      disabled={busy}
                      onChange={(e) => updateRow(index, { duration: e.target.value })}
                    />
                    <input
                      type="text"
                      className="settingsEdit__input kinCareRates__mono"
                      aria-label="Rate"
                      placeholder="0.00"
                      value={row.rate}
                      disabled={busy}
                      onChange={(e) => updateRow(index, { rate: e.target.value })}
                    />
                    <IconButton
                      icon={<TrashGlyph />}
                      label={row.type.trim() === '' ? 'Remove' : `Remove ${row.type.trim()}`}
                      destructive
                      size={34}
                      onClick={() => removeRow(index)}
                      disabled={busy}
                    />
                    {/* Full width under the three fields, so the column line
                        above stays aligned. The explanation is an InfoTip, which
                        a tap opens on a phone (mobile web is the field backup),
                        never a line of copy. */}
                    <span className="kinCareRates__startTime">
                      <Toggle
                        label={
                          row.type.trim() === ''
                            ? 'You set the start time'
                            : `You set the start time for ${row.type.trim()}`
                        }
                        checked={row.startTime}
                        disabled={busy}
                        onChange={(next) => updateRow(index, { startTime: next })}
                      />
                      <span className="kinCareRates__startTimeLabel" aria-hidden="true">
                        You set the start time
                      </span>
                      <InfoTip text={START_TIME_TIP} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div className="kinCareRates__addRow">
          <button type="button" className="kinCareRates__add" onClick={addRow} disabled={busy}>
            <PlusGlyph />
            Add KinCare type
          </button>
        </div>
      </DenPanel>

      <DenPanel
        title="How it looks on the booking screen"
        subtitle="The exact chip the kinfolk and admin see when picking a KinCare type. The first one shows selected for illustration, and the order matches the rows above."
      >
        <span className="kinCareRates__previewLabel">KinCare type</span>
        {view.length === 0 ? (
          <EmptyHint>No KinCare types yet. Add one above.</EmptyHint>
        ) : (
          <div className="nbw__services kinCareRates__chips" role="list" aria-label="KinCare type preview">
            {view.map(({ row, index }, i) => (
              <span
                key={index}
                role="listitem"
                className={i === 0 ? 'nbw__service nbw__service--on' : 'nbw__service'}
              >
                <span className="nbw__service-name">{row.type.trim() === '' ? 'Untitled' : row.type}</span>
                <span className="nbw__service-price">{chipPrice(row.rate)}</span>
              </span>
            ))}
          </div>
        )}
      </DenPanel>

      <div className="kinCareRates__saveBar">
        {dirty ? (
          <span className="kinCareRates__dirty" role="status">
            <span className="kinCareRates__led" aria-hidden="true" />
            Unsaved changes
          </span>
        ) : justSaved ? (
          <span className="settingsEdit__savedNote" role="status">
            Saved
          </span>
        ) : null}
        <span className="kinCareRates__spacer" />
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save KinCare types'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
      </div>
    </div>
  );
}

/** Inline, the kit's own rule: no icon package is installed here and one glyph is not worth a dependency. */
function glyphProps() {
  return {
    viewBox: '0 0 24 24',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

function TrashGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg {...glyphProps()} className="kinCareRates__addGlyph">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
