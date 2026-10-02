import { useCallback, useEffect, useState } from 'react';
import {
  clearMessageSuppression,
  listMessageSuppressions,
  type ClearMessageSuppressionResult,
  type MessageSuppression,
  type MessageSuppressionPage,
  type SuppressionFilter,
} from '../../api/messageSuppressions';
import { type Async } from '../../lib/async';
import { formatWhenFull } from '../../lib/time';
import { AsyncRegion } from '../../components/AsyncRegion';
import { LoadingRow } from '../../components/LoadingRow';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Dialog } from '../../components/Dialog';
import '../SettingsEdit.css';
import './DoNotSendSection.css';

/**
 * #1083: the do-not-send list. Every address the app will not mail or text:
 * hard bounces recorded by the smtp2go webhook (#1077) and opt-outs the owner
 * entered. Before this, a household whose address bounced once stayed unmailed
 * until someone deleted the Firestore document by hand.
 *
 * SELF-LOADING, like Tags and the Email frame: the collection is denied to every
 * client in the rules, so the list and the clear are both callables.
 *
 * CLEAR REMOVES A BOUNCE, NEVER AN OPT-OUT. A bounce is a delivery fact; an
 * opt-out is the household's own consent choice. A row that is both keeps its
 * opt-out when the bounce is cleared and stays on the list as an opt-out, and a
 * row that is only an opt-out has no Clear action at all.
 *
 * CLEAR ASKS FIRST, in the page. The server audits who cleared it.
 */

const FILTERS: readonly { key: SuppressionFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'hard_bounce', label: 'Hard bounces' },
  { key: 'opt_out', label: 'Opt-outs' },
];

const OPT_OUT_TIP = 'Opted out by the household';

function reasonLabel(row: MessageSuppression): string {
  return row.reason === 'hard_bounce' ? 'Hard bounce' : 'Opted out';
}

function sourceLabel(row: MessageSuppression): string {
  return row.source === 'smtp2go' ? 'smtp2go' : 'Admin';
}

function whenLabel(row: MessageSuppression): string {
  return row.suppressedAtMs > 0 ? (formatWhenFull(row.suppressedAtMs) ?? '(no time)') : '(no time)';
}

/** The row after its bounce is cleared and the opt-out stays. */
function asOptOutOnly(row: MessageSuppression): MessageSuppression {
  return { ...row, reason: 'opt_out', source: 'admin', eventId: null, optedOut: true };
}

function clearedNote(row: MessageSuppression, res: ClearMessageSuppressionResult): string {
  const who = res.recipientRedacted || row.recipientRedacted;
  return res.optOutKept
    ? `Cleared the bounce on ${who}. The opt-out stays.`
    : `Cleared ${who}. It can be mailed again.`;
}

export function DoNotSendSection() {
  const [filter, setFilter] = useState<SuppressionFilter>('all');
  const [page, setPage] = useState<Async<MessageSuppressionPage>>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [pending, setPending] = useState<MessageSuppression | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setPage({ status: 'loading' });
    listMessageSuppressions({ reason: filter })
      .then((data) => live && setPage({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setPage({
            status: 'error',
            message: err instanceof Error ? err.message : 'Load failed',
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, [filter]);

  useEffect(() => load(), [load]);

  async function loadMore(cursor: string) {
    if (loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await listMessageSuppressions({ reason: filter, cursor });
      setPage((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', data: { items: [...prev.data.items, ...next.items], nextCursor: next.nextCursor } }
          : prev,
      );
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoadingMore(false);
    }
  }

  async function confirmClear() {
    if (!pending || clearing) return;
    const row = pending;
    setClearing(true);
    setError(null);
    setNote(null);
    try {
      const res = await clearMessageSuppression(row.recipient);
      setPage((prev) => {
        if (prev.status !== 'ready') return prev;
        const items = res.optOutKept
          ? prev.data.items.map((r) => (r.recipient === row.recipient ? asOptOutOnly(r) : r))
          : prev.data.items.filter((r) => r.recipient !== row.recipient);
        return { status: 'ready', data: { ...prev.data, items } };
      });
      setNote(clearedNote(row, res));
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'The clear failed.');
    } finally {
      setClearing(false);
      setPending(null);
    }
  }

  return (
    <DenPanel title="Do-not-send list">
      <div className="doNotSend__filters" role="radiogroup" aria-label="Show">
        {FILTERS.map((f) => (
          <label key={f.key} className="doNotSend__filter">
            <input
              type="radio"
              name="doNotSendFilter"
              checked={filter === f.key}
              onChange={() => {
                setFilter(f.key);
                setNote(null);
                setError(null);
              }}
            />
            {f.label}
          </label>
        ))}
      </div>

      {note ? (
        <Banner tone="success" dismissible onDismiss={() => setNote(null)}>
          {note}
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}

      <AsyncRegion
        state={page}
        what="the do-not-send list"
        isEmpty={(d) => d.items.length === 0}
        loading={<LoadingRow label="Loading the do-not-send list…" className="settings__hint" />}
        empty={<p className="settings__hint">No addresses on the list.</p>}
      >
        {(data) => (
          <>
            <ul className="doNotSend__list">
              {data.items.map((row) => (
                <li key={row.recipient} className="doNotSend__row">
                  <div className="doNotSend__who">
                    <span className="doNotSend__address">{row.recipient}</span>
                    <span className="doNotSend__meta">
                      <span title={row.reason === 'opt_out' ? OPT_OUT_TIP : undefined}>{reasonLabel(row)}</span>
                      {row.reason === 'hard_bounce' && row.optedOut ? <span title={OPT_OUT_TIP}>Also opted out</span> : null}
                      <span>{sourceLabel(row)}</span>
                      <span>{whenLabel(row)}</span>
                    </span>
                  </div>
                  {row.reason === 'hard_bounce' ? (
                    <GhostButton
                      label="Clear"
                      ariaLabel={`Clear ${row.recipient}`}
                      onClick={() => setPending(row)}
                      disabled={clearing}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {moreError ? <Banner tone="error">{moreError}</Banner> : null}
            {data.nextCursor ? (
              <div className="doNotSend__more">
                <GhostButton
                  label="Load more"
                  onClick={() => void loadMore(data.nextCursor as string)}
                  disabled={loadingMore}
                />
                {loadingMore ? <LoadingRow label="Loading more…" className="settings__hint" /> : null}
              </div>
            ) : null}
          </>
        )}
      </AsyncRegion>

      {pending ? (
        <Dialog
          title="Clear this bounce?"
          onClose={() => (clearing ? undefined : setPending(null))}
          footer={
            <>
              <GhostButton label="Keep it" onClick={() => setPending(null)} disabled={clearing} />
              <PrimaryButton label="Clear address" onClick={() => void confirmClear()} busy={clearing} />
            </>
          }
        >
          <p>
            {pending.recipient} comes off the bounce list and Auntie can mail it again.{' '}
            {pending.optedOut ? 'Their opt-out stays. ' : ''}Your name is recorded against the change.
          </p>
        </Dialog>
      ) : null}
    </DenPanel>
  );
}
