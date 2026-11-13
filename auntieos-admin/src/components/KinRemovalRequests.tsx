import { useCallback, useEffect, useState } from 'react';
import {
  listKinRemovalRequests,
  resolveKinRemovalRequest,
  type KinRemovalDecision,
  type KinRemovalRequestDto,
  type ResolveKinRemovalRequestResult,
} from '../api/kinRemovalRequests';
import { useAdminAccess } from '../lib/access';
import { useToast } from './Toast';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import { LoadingRow } from './LoadingRow';
import './VisitRequestsSection.css';

/**
 * #1408. A household asked to remove a Kin that has history; the office
 * archives it or declines. Two surfaces read the same callable:
 *
 *  - `KinRemovalRequestBand`, near the top of the Kin's own profile (KinView).
 *  - `KinRemovalRequestsSection`, the queue on Bookings beside the visit
 *    requests, where the other household requests already wait.
 *
 * Answering is the owner's: archiving is destructive, so the server refuses an
 * Auntie (`lib/auntieAccess.ts` rule 6). She still sees the request, which is
 * household information, with no buttons she could not use.
 */

type Load =
  | { status: 'loading' }
  | { status: 'ready'; requests: KinRemovalRequestDto[] }
  | { status: 'error'; message: string };

function useRemovalRequests(flatKinId?: string): { load: Load; reload: () => void } {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    listKinRemovalRequests(flatKinId)
      .then((res) => {
        if (live) setLoad({ status: 'ready', requests: res.requests });
      })
      .catch((err: unknown) => {
        if (live) setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Load failed' });
      });
    return () => {
      live = false;
    };
  }, [flatKinId, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, reload };
}

/** "Nov 2, 2026". */
export function removalDateLabel(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function kinLabel(r: KinRemovalRequestDto): string {
  return r.kinName ?? 'This Kin';
}

/** One line: who asked, when. */
export function requestedLine(r: KinRemovalRequestDto): string {
  const date = removalDateLabel(r.requestedAtMs);
  return date !== null
    ? `The household asked on ${date} to remove ${kinLabel(r)} from their profile.`
    : `The household asked to remove ${kinLabel(r)} from their profile.`;
}

/** What the toast says, from what the server actually did. */
export function resolvedMessage(res: ResolveKinRemovalRequestResult): string {
  const name = res.request.kinName ?? 'The Kin';
  const told = res.householdNotified
    ? 'The household has your answer.'
    : 'The message to the household did not go out, so tell them another way.';
  return res.decision === 'archive' ? `${name} is archived. ${told}` : `Declined. ${name} stays on the profile. ${told}`;
}

/** The band on the Kin's profile. Renders nothing when no request is waiting. */
export function KinRemovalRequestBand({
  flatKinId,
  onResolved,
}: {
  flatKinId: string;
  /** Called after an answer, so the profile reloads and shows the new status. */
  onResolved?: (decision: KinRemovalDecision) => void;
}) {
  const { load, reload } = useRemovalRequests(flatKinId);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());

  if (load.status === 'loading') {
    return <LoadingRow label="Checking for a removal request…" className="kview__hint" />;
  }
  if (load.status === 'error') {
    return (
      <Banner tone="error" title="Couldn't check for a removal request" trailing={<GhostButton label="Retry" onClick={reload} />}>
        {load.message}
      </Banner>
    );
  }
  const waiting = load.requests.filter((r) => !answered.has(r.id));
  if (waiting.length === 0) return null;
  return (
    <div data-testid="kin-removal-band">
      {waiting.map((r) => (
        <RemovalRequestBanner
          key={r.id}
          request={r}
          onResolved={(decision) => {
            setAnswered((prev) => new Set(prev).add(r.id));
            onResolved?.(decision);
          }}
        />
      ))}
    </div>
  );
}

function RemovalRequestBanner({
  request,
  onResolved,
}: {
  request: KinRemovalRequestDto;
  onResolved: (decision: KinRemovalDecision) => void;
}) {
  const access = useAdminAccess();
  const isOwner = access?.status === 'admin';
  const [sheet, setSheet] = useState<KinRemovalDecision | null>(null);
  return (
    <>
      <Banner
        tone="warning"
        title="Removal requested"
        trailing={
          isOwner ? (
            <>
              <PrimaryButton label="Archive" onClick={() => setSheet('archive')} />
              <GhostButton label="Decline" onClick={() => setSheet('decline')} />
            </>
          ) : undefined
        }
      >
        {requestedLine(request)}
        {request.reason !== null && <> Reason: {request.reason}</>}
        {access?.status === 'caretaker' && <> Only the owner can archive or decline.</>}
      </Banner>
      {sheet !== null && (
        <KinRemovalDecisionDialog
          request={request}
          decision={sheet}
          onClose={() => setSheet(null)}
          onResolved={() => {
            setSheet(null);
            onResolved(sheet);
          }}
        />
      )}
    </>
  );
}

/**
 * The queue on Bookings. Says so while it loads; renders nothing when empty.
 *
 * `focusRequestId` is the request a "Kinfolk asked to remove a Kin" notice
 * opened this screen for (#1912). The queue arrives unfolded with that row
 * marked, and when the request was answered before the Admin got here it says
 * so in one line instead of showing nothing about it.
 */
export function KinRemovalRequestsSection({ focusRequestId }: { focusRequestId?: string } = {}) {
  const { load, reload } = useRemovalRequests();
  const access = useAdminAccess();
  const isOwner = access?.status === 'admin';
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(focusRequestId !== undefined);
  const [sheet, setSheet] = useState<{ request: KinRemovalRequestDto; decision: KinRemovalDecision } | null>(null);

  if (load.status === 'loading') {
    return <LoadingRow label="Checking for Kin removal requests…" />;
  }
  if (load.status === 'error') {
    return (
      <Banner tone="error" title="Couldn't load Kin removal requests" trailing={<GhostButton label="Retry" onClick={reload} />}>
        {load.message}
      </Banner>
    );
  }
  const rows = load.requests.filter((r) => !answered.has(r.id));
  // Answered before arrival, not by the tap just made here (the toast covers that).
  const answeredNote =
    focusRequestId !== undefined && !load.requests.some((r) => r.id === focusRequestId) ? (
      <Banner tone="info" title="Kin removal request">
        That request has already been answered.
      </Banner>
    ) : null;
  if (rows.length === 0) return answeredNote;

  return (
    <section className="visit-requests" data-testid="kin-removal-queue">
      {answeredNote}
      <Banner
        tone="warning"
        title="Kin removal requests"
        pillLabel={`${String(rows.length)} waiting`}
        trailing={
          <GhostButton
            label={open ? 'Hide' : `Review ${String(rows.length)}`}
            pressed={open}
            onClick={() => setOpen((o) => !o)}
          />
        }
      >
        Households asked to remove a Kin that has history on file.
      </Banner>
      {open && (
        <ul className="visit-requests__list">
          {rows.map((r) => (
            <li
              key={r.id}
              className="visit-requests__row"
              {...(r.id === focusRequestId ? { 'aria-current': 'true' as const } : {})}
            >
              <div className="visit-requests__row-meta">
                <span className="visit-requests__row-kind">Remove Kin</span>
                <span className="visit-requests__row-title">{kinLabel(r)}</span>
              </div>
              <p className="visit-requests__row-when">{requestedLine(r)}</p>
              {r.reason !== null && <p className="visit-requests__row-reason">{r.reason}</p>}
              {isOwner && (
                <div className="visit-requests__row-actions">
                  <PrimaryButton label="Archive" onClick={() => setSheet({ request: r, decision: 'archive' })} />
                  <GhostButton label="Decline" onClick={() => setSheet({ request: r, decision: 'decline' })} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {sheet !== null && (
        <KinRemovalDecisionDialog
          request={sheet.request}
          decision={sheet.decision}
          onClose={() => setSheet(null)}
          onResolved={() => {
            setAnswered((prev) => new Set(prev).add(sheet.request.id));
            setSheet(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Archive or decline, with an optional note for the household. Pessimistic:
 * the dialog stays up with a busy button until the server answers, and a
 * refusal stays on screen.
 */
export function KinRemovalDecisionDialog({
  request,
  decision,
  onClose,
  onResolved,
}: {
  request: KinRemovalRequestDto;
  decision: KinRemovalDecision;
  onClose: () => void;
  onResolved: (res: ResolveKinRemovalRequestResult) => void;
}) {
  const { showToast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = kinLabel(request);
  const archiving = decision === 'archive';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await resolveKinRemovalRequest(request.id, decision, note);
      setBusy(false);
      showToast(resolvedMessage(res));
      onResolved(res);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
    }
  }

  return (
    <Dialog
      title={archiving ? `Archive ${name}` : `Keep ${name}`}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton
            label={busy ? 'Working…' : archiving ? 'Archive it' : 'Send the decline'}
            busy={busy}
            onClick={() => void submit()}
            disabled={busy}
          />
        </>
      }
    >
      <p className="visit-requests__dialog-line">
        {archiving
          ? `${name} comes off the household's profile. Visits, invoices and KinTales are kept, and the household will be told.`
          : `${name} stays on the household's profile. The household will be told.`}
      </p>
      <label className="visit-requests__dialog-label" htmlFor="kin-removal-note">
        Note for the household (optional)
      </label>
      <textarea
        id="kin-removal-note"
        className="visit-requests__dialog-note"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      {error !== null && (
        <Banner tone="error" title="Not done">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}
