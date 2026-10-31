import { useState } from 'react';
import { linkInvoiceSessions } from '../api/invoicesWrite';
import { sessionsForKinfolkQuery, type SessionEntry } from '../api/sessions';
import type { LinkInvoiceSessionsResult } from '../contracts/invoiceContracts.generated';
import { useCollection } from '../lib/firestore';
import { humanizeDate, localDateIso } from '../lib/invoiceFormat';
import { sessionState, sessionStateInfo } from '../lib/sessionFormat';
import { AsyncRegion } from './AsyncRegion';
import { Banner } from './Banner';
import { GhostButton, PrimaryButton } from './Buttons';
import './InvoiceLinkVisitsEditor.css';

/**
 * #1245: the "Link visits" editor on the admin web invoice detail. Admin
 * Android (`InvoiceDetailViewModel.saveLinks`) and the desktop console's Link
 * Sessions dialog (#1197) already edit this set; until this, web only showed
 * how many visits an invoice was linked to.
 *
 * Rendered INLINE inside the invoice detail, never as a second `<Dialog>`: the
 * detail is already one, and two would fight over Escape and the focus trap.
 *
 * THE PENDING SET IS SEEDED FROM `invoice.sessionIds`, NEVER FROM THE ROWS ON
 * SCREEN. The callable takes the full new set, so an id missing from the
 * request is an unlink. A linked visit the household list did not load (blank
 * or different `kinfolkId` on a legacy row, or past the list's cap) still gets
 * a row of its own below, still checked, and still sent.
 *
 * A VISIT ON ANOTHER INVOICE IS SHOWN, NOT HIDDEN, AND CANNOT BE TICKED. The
 * server does not refuse it today (#1254), and taking it would leave the other
 * invoice still claiming the same work. Absent, empty and whitespace
 * `invoiceId` are all "unclaimed", the rule `listUninvoicedSessions` uses.
 * Beyond that one rule the editor adds no eligibility of its own: the callable
 * gates on neither status nor editScope, and Android and desktop offer every
 * household visit.
 */
export interface InvoiceLinkVisitsEditorProps {
  invoiceId: string;
  kinfolkId: string;
  /** The invoice's stored `sessionIds`, read once when the editor opens. */
  linkedIds: readonly string[];
  onCancel: () => void;
  onSaved: (result: LinkInvoiceSessionsResult) => void;
  /** Told when a save starts and ends, so the host can refuse to close mid-save. */
  onBusyChange?: (busy: boolean) => void;
}

/** The confirmation once the server saved the set. Same wording as the desktop console. */
export function linkVisitsSavedText(result: Pick<LinkInvoiceSessionsResult, 'added' | 'removed'>): string {
  const a = result.added.length;
  const r = result.removed.length;
  if (a === 0 && r === 0) return 'Linked visits unchanged.';
  const parts: string[] = [];
  if (a > 0) parts.push(`${String(a)} linked`);
  if (r > 0) parts.push(`${String(r)} unlinked`);
  return `Visits saved: ${parts.join(', ')}.`;
}

/** True when the visit's own back-link names an invoice other than this one. */
export function onOtherInvoice(session: Pick<SessionEntry, 'invoiceId'>, invoiceId: string): boolean {
  const claimed = typeof session.invoiceId === 'string' ? session.invoiceId.trim() : '';
  return claimed !== '' && claimed !== invoiceId;
}

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  if (a.size !== new Set(b).size) return false;
  return b.every((id) => a.has(id));
}

export function InvoiceLinkVisitsEditor({
  invoiceId,
  kinfolkId,
  linkedIds,
  onCancel,
  onSaved,
  onBusyChange,
}: InvoiceLinkVisitsEditorProps) {
  // Seeded once, at open. The live invoice listener can re-render this with a
  // newer `linkedIds`; re-seeding would wipe the operator's picks mid-edit.
  const [initial] = useState<readonly string[]>(() => Array.from(new Set(linkedIds)));
  const [pending, setPending] = useState<Set<string>>(() => new Set(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    if (saving) return;
    setPending((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const result = await linkInvoiceSessions(invoiceId, Array.from(pending));
      setSaving(false);
      onBusyChange?.(false);
      onSaved(result);
    } catch (caught: unknown) {
      // Verbatim, and the editor stays open with every pick as it was, so the
      // operator can correct and press Save again.
      setSaving(false);
      onBusyChange?.(false);
      const message = caught instanceof Error && caught.message ? caught.message : 'Save failed';
      setError(`linkInvoiceSessions failed: ${message}`);
    }
  }

  const unchanged = sameSet(pending, initial);
  const hasHousehold = kinfolkId.trim() !== '';

  return (
    <section className="link-visits" aria-labelledby="link-visits-heading" aria-busy={saving}>
      <h3 className="link-visits__heading" id="link-visits-heading">
        Link visits
      </h3>

      {error !== null && (
        <Banner tone="error" title="Can't save">
          {error}
        </Banner>
      )}

      {hasHousehold ? (
        <HouseholdVisits
          invoiceId={invoiceId}
          kinfolkId={kinfolkId}
          initial={initial}
          pending={pending}
          disabled={saving}
          onToggle={toggle}
        />
      ) : (
        <>
          <p className="link-visits__empty">
            This invoice names no household, so the household's visits cannot be listed. Visits
            already linked are below and can be unlinked.
          </p>
          <UnlistedLinked ids={initial} pending={pending} disabled={saving} onToggle={toggle} />
        </>
      )}

      <div className="link-visits__actions">
        {/* Not while the call is in flight: its answer has to land somewhere. */}
        <GhostButton label="Cancel" onClick={onCancel} disabled={saving} />
        {/* A no-change save is not harmless: the server re-stamps the
            invoice's attribution as manual. So it is only offered once
            something changed. */}
        <PrimaryButton
          label={saving ? 'Saving…' : 'Save'}
          onClick={() => {
            void save();
          }}
          busy={saving}
          disabled={unchanged}
        />
      </div>
    </section>
  );
}

interface RowsProps {
  pending: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
}

function HouseholdVisits({
  invoiceId,
  kinfolkId,
  initial,
  pending,
  disabled,
  onToggle,
}: RowsProps & { invoiceId: string; kinfolkId: string; initial: readonly string[] }) {
  const visits = useCollection<SessionEntry>(sessionsForKinfolkQuery(kinfolkId));
  return (
    <AsyncRegion state={visits} what="the household's visits" isEmpty={() => false} empty={null}>
      {(rows) => {
        const loaded = new Set(rows.map((r) => r._id));
        const unlisted = initial.filter((id) => !loaded.has(id));
        return (
          <>
            {rows.length === 0 && unlisted.length === 0 ? (
              <p className="link-visits__empty">This household has no visits on record.</p>
            ) : (
              <ul className="link-visits__list">
                {rows.map((s) => (
                  <VisitRow
                    key={s._id}
                    session={s}
                    checked={pending.has(s._id)}
                    // Already in this invoice's set: always togglable, even when
                    // its back-link points elsewhere, so a half-link can be undone.
                    elsewhere={!initial.includes(s._id) && onOtherInvoice(s, invoiceId)}
                    disabled={disabled}
                    onToggle={onToggle}
                  />
                ))}
              </ul>
            )}
            <UnlistedLinked ids={unlisted} pending={pending} disabled={disabled} onToggle={onToggle} />
          </>
        );
      }}
    </AsyncRegion>
  );
}

function VisitRow({
  session,
  checked,
  elsewhere,
  disabled,
  onToggle,
}: {
  session: SessionEntry;
  checked: boolean;
  elsewhere: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const service = session.serviceType?.trim() || 'Visit';
  const start = session.startTime ?? '';
  const day = start.trim() === '' ? 'no date' : humanizeDate(start.slice(0, 10), localDateIso(new Date()));
  const status = sessionStateInfo(sessionState(session.status ?? '')).label;
  return (
    <li className={elsewhere ? 'link-visits__row link-visits__row--elsewhere' : 'link-visits__row'}>
      <label className="link-visits__row-label">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(session._id)}
          disabled={disabled || elsewhere}
          aria-label={`Link ${service} on ${day}`}
        />
        <span className="link-visits__row-main">
          <span className="link-visits__row-service">{service}</span>
          <span className="link-visits__row-meta">
            {day} · {status}
            {elsewhere ? ' · on another invoice' : ''}
          </span>
        </span>
      </label>
    </li>
  );
}

/** Linked ids the household list did not return. Kept, and sent, unless unticked. */
function UnlistedLinked({ ids, pending, disabled, onToggle }: RowsProps & { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <ul className="link-visits__list" aria-label="Linked visits not in the household list">
      {ids.map((id) => (
        <li key={id} className="link-visits__row">
          <label className="link-visits__row-label">
            <input
              type="checkbox"
              checked={pending.has(id)}
              onChange={() => onToggle(id)}
              disabled={disabled}
              aria-label={`Link visit ${id}`}
            />
            <span className="link-visits__row-main">
              <span className="link-visits__row-service">Visit {id}</span>
              <span className="link-visits__row-meta">linked, not in this household's visit list</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
