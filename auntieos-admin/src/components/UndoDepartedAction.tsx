import { useState } from 'react';
import { useDocById } from '../lib/firestore';
import { undoDeparted, useUndoDepartedOpen, type UndoDepartedSession } from '../lib/undoDeparted';
import { ErrorHint } from './DenScreenKit';
import { GhostButton, PrimaryButton } from './Buttons';
import { LoadingRow } from './LoadingRow';
import { Dialog } from './Dialog';

interface UndoDepartedActionProps {
  /** The visit as the screen holds it. */
  session: UndoDepartedSession & { _id: string };
  /** The household's name, for the confirm. */
  household: string;
  /** Called once the visit is back at Arrived, so a one-shot list re-reads. */
  onUndone?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * #2250, operator ruling 2026-11-14: "Undo departed" on a visit that has just
 * been departed, for the owner and for an Auntie. One self-contained block for
 * the Auntie Time card and the visit drawer: the button, its confirm, the
 * waiting row and the refusal. It renders nothing at all once the few minutes
 * are up, or on a visit that has not departed.
 *
 * WHY IT WATCHES THE VISIT ITSELF. The board's list is read once. The server
 * stamps when the undo closes a moment after the Departed tap, in the same
 * write that completes the visit, so the row the board holds may not carry it
 * yet. A Departed visit with no stamp on its row is watched until it has one.
 * A Completed visit is never watched: the board re-reads when a visit
 * completes, and that row carries the stamp.
 */
export function UndoDepartedAction({ session, household, onUndone, className }: UndoDepartedActionProps) {
  const status = typeof session.status === 'string' ? session.status.trim().toUpperCase() : '';
  const rowStamp = typeof session.undoDepartedUntil === 'string' ? session.undoDepartedUntil : '';
  const live = useDocById<UndoDepartedSession>(
    'kin_care_sessions',
    status === 'DEPARTED' && rowStamp === '' ? session._id : null,
  );
  const liveRow = live.status === 'ready' && live.data !== null ? live.data : null;
  const current: UndoDepartedSession = liveRow ?? session;
  const open = useUndoDepartedOpen(current);

  const [asked, setAsked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setAsked(false);
    setSaving(true);
    setError(null);
    try {
      await undoDeparted(session._id);
      onUndone?.();
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  // A refusal stays readable after the button has gone: the commonest one is
  // that the time ran out while the confirm was open.
  if (!open && !saving && error === null) return null;

  return (
    <div className={className} data-testid="undo-departed">
      {open && (
        <GhostButton
          label="Undo departed"
          leading={<span>↶</span>}
          onClick={() => {
            setError(null);
            setAsked(true);
          }}
          disabled={saving}
        />
      )}
      {saving && (
        <div role="status">
          <LoadingRow label="Putting the visit back to Arrived…" className="den-hint" />
        </div>
      )}
      {error !== null && <ErrorHint>Couldn&rsquo;t undo the departure. {error}</ErrorHint>}
      {asked && (
        <Dialog
          title="Undo departed?"
          onClose={() => setAsked(false)}
          footer={
            <>
              <GhostButton label="Not now" onClick={() => setAsked(false)} />
              <PrimaryButton label="Yes, undo departed" onClick={() => void run()} />
            </>
          }
        >
          <p>
            {household === '' ? 'This visit' : `${household}’s visit`} will go back to Arrived, with the
            arrival time it already has. The household is not told.
          </p>
        </Dialog>
      )}
    </div>
  );
}
