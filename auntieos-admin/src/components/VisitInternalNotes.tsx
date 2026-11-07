import { useCallback, useEffect, useState } from 'react';
import {
  addInternalBookingNote,
  listVisitInternalNotes,
  type VisitNoteTarget,
} from '../api/bookingsWrite';
import type { ListVisitInternalNotesResult, ListVisitInternalNotesResultNote } from '../contracts/bookingContracts.generated';
import { Banner } from './Banner';
import { GhostButton, PrimaryButton } from './Buttons';
import { DenPanel, EmptyHint } from './DenScreenKit';
import { readableVisitNotes } from '../lib/sessionLifecycle';
import './VisitInternalNotes.css';

/**
 * #1580: the visit's ONE list of internal notes, the same panel on Bookings
 * (the booking detail sheet) and on Auntie Time (the session detail).
 *
 * Before #1580 these were two stores under two labels: Bookings read the booking
 * record's `internalNotes` thread, and Auntie Time read and wrote the session's
 * `notes` text, so a note saved on one screen never showed on the other. Both
 * now read `listVisitInternalNotes` and write `addInternalBookingNote`.
 *
 * Operator ruling, 2026-11-05 docket: "two kinds, shared and admin-only. The
 * writer marks each note. Aunties see only shared notes." The server filters
 * the list on the caller's claim and says whether she may mark a note admin
 * only (`canMarkAdminOnly`), so this panel never decides who sees what.
 */

/** "Syd", "Auntie" or "Office", for the note's byline. */
export function noteByline(note: ListVisitInternalNotesResultNote): string {
  if (note.source === 'visitRecord') return 'On the visit record';
  if (note.authorName !== null && note.authorName !== '') return note.authorName;
  if (note.authorRole === 'auntie') return 'Auntie';
  if (note.authorRole === 'admin') return 'Office';
  return 'Staff';
}

/** "Nov 5, 3:00 PM" in the business zone, or '' when the note has no date. */
export function noteWhen(ms: number | null, zone: string): string {
  if (ms === null) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function failure(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ListVisitInternalNotesResult };

export interface VisitInternalNotesProps {
  target: VisitNoteTarget;
  businessZone: string;
  /** Panel heading level; the sheet nests it under its own heading. */
  headingLevel?: 2 | 3;
  className?: string;
}

export function VisitInternalNotes({ target, businessZone, headingLevel = 3, className }: VisitInternalNotesProps) {
  const key = 'sessionId' in target ? `s:${target.sessionId}` : `v:${target.kinfolkId}/${target.batchId}/${target.visitId}`;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [adminOnly, setAdminOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listVisitInternalNotes(target);
      setState({ status: 'ready', data });
    } catch (err) {
      setState({ status: 'error', message: failure(err) });
    }
    // `key` stands for `target`, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  const canMark = state.status === 'ready' && state.data.canMarkAdminOnly && state.data.hasBookingRecord;

  async function save() {
    const body = draft.trim();
    if (body === '' || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const res = await addInternalBookingNote(target, body, canMark && adminOnly ? 'adminOnly' : 'shared');
      setDraft('');
      setAdminOnly(false);
      setSaved(res.visibility === 'adminOnly' ? 'Note added. Only you can see it.' : 'Note added for staff.');
      await load();
    } catch (err) {
      setSaveError(failure(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DenPanel
      title="Internal notes"
      meta="staff only"
      subtitle="The household never sees these."
      headingLevel={headingLevel}
      {...(className !== undefined ? { className } : {})}
    >
      {state.status === 'loading' && <EmptyHint>Loading the notes…</EmptyHint>}
      {state.status === 'error' && (
        <Banner tone="error" title="Could not load the notes">
          {state.message}{' '}
          <GhostButton label="Try again" onClick={() => { setState({ status: 'loading' }); void load(); }} />
        </Banner>
      )}
      {state.status === 'ready' &&
        (state.data.notes.length === 0 ? (
          <EmptyHint>No internal notes yet.</EmptyHint>
        ) : (
          <ul className="vin__list" aria-label="Internal notes">
            {state.data.notes.map((note) => (
              <li key={note.id} className="vin__note" data-visibility={note.visibility}>
                <span className="vin__body">
                  {/* #1592: the visit record's stamps read on the business clock. */}
                  {note.source === 'visitRecord' ? readableVisitNotes(note.body, businessZone) : note.body}
                </span>
                <span className="vin__meta">
                  {note.visibility === 'adminOnly' && <span className="vin__badge">Admin only</span>}
                  <span>{noteByline(note)}</span>
                  {note.createdAtMs !== null && <span>{noteWhen(note.createdAtMs, businessZone)}</span>}
                </span>
              </li>
            ))}
          </ul>
        ))}

      <label className="vin__field">
        <span className="vin__label">Add an internal note</span>
        <textarea
          className="vin__composer"
          rows={3}
          maxLength={4000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          aria-label="Add an internal note"
        />
      </label>
      {canMark && (
        <label className="vin__mark">
          <input type="checkbox" checked={adminOnly} onChange={(e) => setAdminOnly(e.target.checked)} disabled={saving} />
          Admin only (Aunties will not see it)
        </label>
      )}
      <PrimaryButton
        label={saving ? 'Saving…' : 'Add note'}
        onClick={() => void save()}
        disabled={saving || draft.trim() === '' || state.status === 'loading'}
        busy={saving}
      />
      {saved !== null && (
        <p className="vin__ok" role="status">
          {saved}
        </p>
      )}
      {saveError !== null && (
        <Banner tone="error" title="Could not add the note">
          {saveError}
        </Banner>
      )}
    </DenPanel>
  );
}
