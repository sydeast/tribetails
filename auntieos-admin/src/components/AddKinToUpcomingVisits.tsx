import { useCallback, useEffect, useState } from 'react';
import { addKinToUpcomingVisits } from '../api/addKinToUpcomingVisits';
import { useAdminAccess } from '../lib/access';
import { useToast } from './Toast';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import { LoadingRow } from './LoadingRow';
import './VisitRequestsSection.css';

/** "Add Pepper to the 3 upcoming visits", or "the upcoming visit" for one. */
export function addKinToVisitsLabel(name: string, count: number): string {
  return count === 1 ? `Add ${name} to the upcoming visit` : `Add ${name} to the ${count} upcoming visits`;
}

/** "Added Pepper to 3 upcoming visits." */
export function addedKinToVisitsLine(name: string, count: number): string {
  return count === 1 ? `Added ${name} to 1 upcoming visit.` : `Added ${name} to ${count} upcoming visits.`;
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; upcoming: number };

/**
 * #1822 (operator ruling 2026-11-20). A Kin adopted after visits were booked
 * is on every visit booked from then on; the visits already booked keep the
 * Kin they were made for. This is the owner's option to put the Kin on the
 * household's upcoming visits too, on the Kin's own profile (KinView).
 *
 * Owner only: an Auntie never sees it (the server refuses her as well). Shows
 * nothing when every upcoming visit already carries the Kin.
 */
export function AddKinToUpcomingVisits({
  kinfolkId,
  kinId,
  kinName,
}: {
  kinfolkId: string;
  kinId: string;
  kinName: string;
}) {
  const access = useAdminAccess();
  // The owner only. A sandbox test admin carries no `admin` claim, so
  // `wrapAdminCallable` refuses her too: the band would only ever show an error.
  const isOwner = access?.status === 'admin';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const name = kinName.trim() !== '' ? kinName : 'this Kin';

  const check = useCallback(() => {
    let live = true;
    setLoad({ status: 'loading' });
    addKinToUpcomingVisits(kinfolkId, kinId, false)
      .then((res) => {
        if (live) setLoad({ status: 'ready', upcoming: res.upcoming });
      })
      .catch((err: unknown) => {
        if (live) setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Load failed' });
      });
    return () => {
      live = false;
    };
  }, [kinfolkId, kinId]);

  useEffect(() => {
    if (!isOwner) return undefined;
    return check();
  }, [isOwner, check]);

  if (!isOwner) return null;
  if (load.status === 'loading') {
    return <LoadingRow label="Checking upcoming visits…" className="kview__hint" />;
  }
  if (load.status === 'error') {
    return (
      <Banner tone="error" title="Couldn't check upcoming visits" trailing={<GhostButton label="Retry" onClick={check} />}>
        {load.message}
      </Banner>
    );
  }
  if (load.upcoming === 0) return null;
  return (
    <div data-testid="add-kin-to-visits">
      <Banner
        tone="info"
        trailing={
          <PrimaryButton label={addKinToVisitsLabel(name, load.upcoming)} onClick={() => setConfirming(true)} />
        }
      >
        {load.upcoming === 1
          ? `${name} is not on 1 upcoming visit.`
          : `${name} is not on ${load.upcoming} upcoming visits.`}
      </Banner>
      {confirming && (
        <ConfirmAddDialog
          kinfolkId={kinfolkId}
          kinId={kinId}
          name={name}
          count={load.upcoming}
          onClose={() => setConfirming(false)}
          onDone={(added) => {
            setConfirming(false);
            setLoad({ status: 'ready', upcoming: Math.max(0, load.upcoming - added) });
            check();
          }}
        />
      )}
    </div>
  );
}

function ConfirmAddDialog({
  kinfolkId,
  kinId,
  name,
  count,
  onClose,
  onDone,
}: {
  kinfolkId: string;
  kinId: string;
  name: string;
  count: number;
  onClose: () => void;
  onDone: (added: number) => void;
}) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await addKinToUpcomingVisits(kinfolkId, kinId, true);
      setBusy(false);
      showToast(
        res.added === 0 ? `${name} is already on every upcoming visit.` : addedKinToVisitsLine(name, res.added),
      );
      onDone(res.added);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
    }
  }

  return (
    <Dialog
      title={`Add ${name} to upcoming visits`}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton
            label={busy ? 'Adding…' : `Add ${name}`}
            busy={busy}
            onClick={() => void submit()}
            disabled={busy}
          />
        </>
      }
    >
      <p className="visit-requests__dialog-line">
        {count === 1
          ? `${name} will be on the upcoming visit already booked for this household.`
          : `${name} will be on the ${count} upcoming visits already booked for this household.`}{' '}
        Visits that have started or are over stay as they are.
      </p>
      {error !== null && (
        <Banner tone="error" title="Not done">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}
