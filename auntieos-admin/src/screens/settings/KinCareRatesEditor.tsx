import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import '../SettingsEdit.css';
import './KinCareRatesEditor.css';

/**
 * The KinCare-type rates sub-editor, one of the three DEFERRED editors this
 * port fills in (see `Settings.tsx`'s header). Edits
 * `BusinessSettings.serviceRates: Record<type, rate>`, the map Schedule and the
 * new-visit dialog read when booking, and writes the SAME shape the read-only
 * overview's `serviceRateRows` (`lib/settingsFormat.ts`) already parses (a
 * blank-type key is unsaveable, a blank rate reads back as "Not set").
 *
 * Ported field-for-field from the wasm `KinCareTypesPanel`
 * (`SettingsScreen.kt`): rows are edited as `(type, rate)` string pairs, not
 * directly as the record, because a type name IS the map key -- editing it
 * in place needs a row identity independent of the key that might be
 * mid-edit. `edited` folds rows to a `Record<string, string>` the exact way
 * the wasm panel's `associate` does: blank-type rows are dropped, and on a
 * duplicate type name the LAST row wins (`Object.fromEntries`/spread has the
 * same last-write-wins behavior as Kotlin's `associate`).
 *
 * One combined Save/Cancel bar for the whole table, matching the wasm panel's
 * single `AuntieSaveBar` (dirty = folded rows vs. the loaded `serviceRates`),
 * rather than a per-row save -- a row rename changes the whole map's key set,
 * so there is no way to save "just one row" independently of the others.
 */

interface KinCareRatesEditorProps {
  data: Pick<BusinessSettings, 'serviceRates'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface RateRow {
  type: string;
  rate: string;
}

function toRows(rates: Record<string, string>): RateRow[] {
  return Object.entries(rates).map(([type, rate]) => ({ type, rate }));
}

/** Folds rows to the wire map: blank-type rows dropped, last row wins on a duplicate type, matching the wasm `associate`. */
function foldRows(rows: RateRow[]): Record<string, string> {
  const edited: Record<string, string> = {};
  for (const row of rows) {
    const type = row.type.trim();
    if (type === '') continue;
    edited[type] = row.rate.trim();
  }
  return edited;
}

function sameRateMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

export function KinCareRatesEditor({ data, onSave }: KinCareRatesEditorProps) {
  // Seeded ONCE from `data` at mount, the `TextFieldsSection` convention.
  const [rows, setRows] = useState<RateRow[]>(() => toRows(data.serviceRates));
  const [newType, setNewType] = useState('');
  const [newRate, setNewRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const edited = foldRows(rows);
  const dirty = !sameRateMap(edited, data.serviceRates);

  function markDirtyEdit() {
    setJustSaved(false);
  }

  function updateType(i: number, next: string) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, type: next } : row)));
    markDirtyEdit();
  }

  function updateRate(i: number, next: string) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, rate: next } : row)));
    markDirtyEdit();
  }

  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
    markDirtyEdit();
  }

  function addRow() {
    if (newType.trim() === '') return;
    setRows((r) => [...r, { type: newType.trim(), rate: newRate.trim() }]);
    setNewType('');
    setNewRate('');
    markDirtyEdit();
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ serviceRates: edited });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setRows(toRows(data.serviceRates));
    setNewType('');
    setNewRate('');
    setError(null);
    setJustSaved(false);
  }

  return (
    <DenPanel
      title="KinCare types"
      subtitle="The service types and rates kinfolk pick when booking. Used by Schedule and the new-visit dialog."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      {rows.length === 0 ? <p className="settingsEdit__hint">No KinCare types yet. Add one below.</p> : null}

      <ul className="kinCareRates__list">
        {rows.map((row, i) => (
          <li key={i} className="kinCareRates__row">
            <label className="settingsEdit__field kinCareRates__typeField">
              <span className="settingsEdit__fieldLabel">Type</span>
              <input
                type="text"
                className="settingsEdit__input"
                value={row.type}
                disabled={busy}
                onChange={(e) => updateType(i, e.target.value)}
              />
            </label>
            <label className="settingsEdit__field kinCareRates__rateField">
              <span className="settingsEdit__fieldLabel">Rate</span>
              <input
                type="text"
                className="settingsEdit__input"
                placeholder="0.00"
                value={row.rate}
                disabled={busy}
                onChange={(e) => updateRate(i, e.target.value)}
              />
            </label>
            <GhostButton label="Remove" onClick={() => removeRow(i)} disabled={busy} />
          </li>
        ))}
      </ul>

      <div className="kinCareRates__addRow">
        <label className="settingsEdit__field kinCareRates__typeField">
          <span className="settingsEdit__fieldLabel">New type</span>
          <input
            type="text"
            className="settingsEdit__input"
            placeholder="e.g. Drop-in visit"
            value={newType}
            disabled={busy}
            onChange={(e) => setNewType(e.target.value)}
          />
        </label>
        <label className="settingsEdit__field kinCareRates__rateField">
          <span className="settingsEdit__fieldLabel">Rate</span>
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
