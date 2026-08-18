import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { serviceDurationMinutes, storedDurationMinutes } from '../../lib/newBooking';
import '../SettingsEdit.css';
import './KinCareRatesEditor.css';

/**
 * The KinCare-type sub-editor. Three columns: NAME, DURATION, PRICE.
 *
 * It used to be two, name and rate, with the length of a visit living inside
 * the name ("30Minute", "Half-Day 6Hrs") and read back out by a regex whenever
 * anything needed to sort or schedule. Mark 15 of the 2026-08-17 walk ruled on
 * that: "change copy to Service Duration. OR we create a third attribute to the
 * kincare: duration. so kincare will have a name/title, duration, and price".
 * The operator picked the third attribute, and three columns.
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
 */

interface KinCareRatesEditorProps {
  data: Pick<BusinessSettings, 'serviceRates' | 'serviceDurations'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface RateRow {
  type: string;
  duration: string;
  rate: string;
}

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
): RateRow[] {
  return Object.entries(rates).map(([type, rate]) => ({
    type,
    duration: typeof durations[type] === 'string' ? durations[type] : '',
    rate,
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

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
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

export function KinCareRatesEditor({ data, onSave }: KinCareRatesEditorProps) {
  // Seeded ONCE from `data` at mount, the `TextFieldsSection` convention.
  const [rows, setRows] = useState<RateRow[]>(() => toRows(data.serviceRates, data.serviceDurations));
  const [newType, setNewType] = useState('');
  const [newDuration, setNewDuration] = useState('');
  const [newRate, setNewRate] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('stored');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const editedRates = foldRates(rows);
  const editedDurations = foldDurations(rows);
  const dirty =
    !sameMap(editedRates, data.serviceRates) || !sameMap(editedDurations, data.serviceDurations);

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

  function addRow() {
    if (newType.trim() === '') return;
    setRows((r) => [
      ...r,
      { type: newType.trim(), duration: newDuration.trim(), rate: newRate.trim() },
    ]);
    setNewType('');
    setNewDuration('');
    setNewRate('');
    markDirtyEdit();
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ serviceRates: editedRates, serviceDurations: editedDurations });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setRows(toRows(data.serviceRates, data.serviceDurations));
    setNewType('');
    setNewDuration('');
    setNewRate('');
    setError(null);
    setJustSaved(false);
  }

  const view = sortedView(rows, sortKey);

  return (
    <DenPanel
      title="KinCare types"
      subtitle="The service types, how long each one runs, and what it costs. Used by Schedule and the new-visit dialog."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      {rows.length === 0 ? <p className="settingsEdit__hint">No KinCare types yet. Add one below.</p> : null}

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

      <ul className="kinCareRates__list">
        {view.map(({ row, index }) => {
          // What the name implies, shown as a placeholder when nothing is
          // stored. Visible, and not written unless the operator types it.
          const impliedMinutes = row.duration.trim() === '' ? serviceDurationMinutes(row.type) : null;
          return (
            <li key={index} className="kinCareRates__row">
              <label className="settingsEdit__field kinCareRates__typeField">
                <span className="settingsEdit__fieldLabel">Name</span>
                <input
                  type="text"
                  className="settingsEdit__input"
                  value={row.type}
                  disabled={busy}
                  onChange={(e) => updateRow(index, { type: e.target.value })}
                />
              </label>
              <label className="settingsEdit__field kinCareRates__durationField">
                <span className="settingsEdit__fieldLabel">Duration (min)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="settingsEdit__input"
                  placeholder={impliedMinutes === null ? 'Not set' : `${impliedMinutes} (from the name)`}
                  value={row.duration}
                  disabled={busy}
                  onChange={(e) => updateRow(index, { duration: e.target.value })}
                />
              </label>
              <label className="settingsEdit__field kinCareRates__rateField">
                <span className="settingsEdit__fieldLabel">Price</span>
                <input
                  type="text"
                  className="settingsEdit__input"
                  placeholder="0.00"
                  value={row.rate}
                  disabled={busy}
                  onChange={(e) => updateRow(index, { rate: e.target.value })}
                />
              </label>
              <GhostButton label="Remove" onClick={() => removeRow(index)} disabled={busy} />
            </li>
          );
        })}
      </ul>

      <div className="kinCareRates__addRow">
        <label className="settingsEdit__field kinCareRates__typeField">
          <span className="settingsEdit__fieldLabel">New name</span>
          <input
            type="text"
            className="settingsEdit__input"
            placeholder="e.g. Drop-in visit"
            value={newType}
            disabled={busy}
            onChange={(e) => setNewType(e.target.value)}
          />
        </label>
        <label className="settingsEdit__field kinCareRates__durationField">
          <span className="settingsEdit__fieldLabel">New duration (min)</span>
          <input
            type="text"
            inputMode="numeric"
            className="settingsEdit__input"
            placeholder="e.g. 30"
            value={newDuration}
            disabled={busy}
            onChange={(e) => setNewDuration(e.target.value)}
          />
        </label>
        <label className="settingsEdit__field kinCareRates__rateField">
          <span className="settingsEdit__fieldLabel">New price</span>
          <input
            type="text"
            className="settingsEdit__input"
            placeholder="0.00"
            value={newRate}
            disabled={busy}
            onChange={(e) => setNewRate(e.target.value)}
          />
        </label>
        <PrimaryButton label="Add" onClick={addRow} disabled={busy || newType.trim() === ''} />
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
