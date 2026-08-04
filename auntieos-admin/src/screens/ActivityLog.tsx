import { useEffect, useState } from 'react';
import {
  ACTIVITY_LOG_QUERY,
  verifyActivityLogChain,
  type ActivityLogEntry,
  type VerifyAnomaly,
  type VerifyResult,
} from '../api/activityLog';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { type Async } from '../lib/async';
import {
  activityChainRows,
  activityDetailRows,
  activityMatchesQuery,
  activityMatchesStatus,
  activityPayloadRows,
  type ActivityStatusFilter,
} from '../lib/activityDetail';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton } from '../components/Buttons';

function statusClass(status: string): string {
  const s = status.toUpperCase();
  if (s === 'SUCCESS') return 'log__status log__status--ok';
  if (s === 'FAILURE' || s === 'ERROR') return 'log__status log__status--fail';
  return 'log__status log__status--pending';
}

/** Human line for each anomaly shape (head_mismatch carries no entryId/seq). */
function anomalyDetail(a: VerifyAnomaly): string {
  switch (a.code) {
    case 'seq_gap':
      return `Sequence gap at #${a.seq} (expected ${a.expectedSeq}), entry ${a.entryId}.`;
    case 'prev_hash_mismatch':
      return `Previous-hash mismatch at #${a.seq}, entry ${a.entryId}.`;
    case 'entry_hash_mismatch':
      return `Entry-hash mismatch at #${a.seq}, entry ${a.entryId}.`;
    case 'head_mismatch':
      return `Chain-head mismatch: sealed head at seq ${a.headSeq}, observed seq ${a.observedSeq}.`;
  }
}

function byDay(rows: ActivityLogEntry[]): [string, ActivityLogEntry[]][] {
  const groups = new Map<string, ActivityLogEntry[]>();
  for (const r of rows) {
    const ts = str(r.timestamp);
    const day = /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : 'Undated';
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(r);
  }
  return [...groups.entries()];
}

/**
 * Admin Activity Log. Streams the `activity_log` collection through the bounded,
 * server-ordered listener (seq desc, capped 200, AO-29 fixed by construction),
 * and verifies the SHA-256 hash chain (auto on mount, re-runnable on demand),
 * matching the wasm screen's verify-on-load behavior.
 *
 * ── R5, 2026-08-03: "the Activity Log is seriously lacking, cant see shit or
 * what the fuck actually happened." ──────────────────────────────────────────
 *
 * The striking thing about that complaint is that it was never a data problem.
 * `writeAuditEntry` has sealed `severity`, `actorRole`, `familyId`, `payload`,
 * `requestId`, `ip` and `userAgent` onto every entry since 2026-05-19, and its
 * docstring calls them "retained for forensic value ... surfaced in detail
 * views". There was no detail view. So this screen rendered four of the eleven
 * fields on each document, and `payload` (the field where every event type puts
 * its specifics, because writeAuditEntry gives it nowhere else) was rendered
 * nowhere in the product at all. Page-spec 22 item 1 has carried "rows aren't
 * clickable / no detail view" as the core complaint since 2026-05-27.
 *
 * Three changes, all reading data that was already on the wire:
 *
 *   1. ROWS OPEN. A row discloses the full record in place: the full ISO
 *      timestamp rather than the `HH:mm` slice, the identity and provenance
 *      fields, the FULL chain hashes (an abbreviated hash cannot be verified
 *      against anything), and the flattened payload.
 *   2. FILTER + SEARCH. A status facet (problems / success / pending) and a
 *      free-text box that searches the payload as well as the visible fields,
 *      because "which entry mentions this booking id" is the real question and
 *      the id lives in the payload.
 *   3. THE COUNT IS STATED. The listener is capped at 200 by chain sequence;
 *      the panel now says how many of how many are shown instead of leaving the
 *      cap to be discovered.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE, so it is not mistaken for finished: the
 * cap itself. Removing it needs a paginated listener (`ACTIVITY_LOG_QUERY` is a
 * fixed `max: 200`), which is page-spec 22 item 6 and a change to the shared
 * `useCollection` contract rather than to this screen. It is named in the PR.
 *
 * The austerity of the ROW is preserved on purpose. This is a tamper-evident
 * audit trail and its rows are evidence; the notification feed next door is
 * work, and it is allowed to be chatty. Nothing here reformats what the writer
 * recorded: the only transformation applied to a payload is flattening its
 * structure to dotted paths, never touching its values.
 */
export function ActivityLog() {
  const entries = useCollection<ActivityLogEntry>(ACTIVITY_LOG_QUERY);
  const [chain, setChain] = useState<Async<VerifyResult>>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ActivityStatusFilter>('all');
  /**
   * Which rows are open, by document id, rather than a single "openId".
   * Comparing two entries is the common case in an audit trail (what did the
   * dispatch say, and what did the delivery say), and a single-open accordion
   * makes that impossible.
   */
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  function toggleOpen(id: string): void {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function verify() {
    setChain({ status: 'loading' });
    try {
      setChain({ status: 'ready', data: await verifyActivityLogChain() });
    } catch (err) {
      setChain({ status: 'error', message: err instanceof Error ? err.message : 'Verification failed.' });
    }
  }

  useEffect(() => {
    void verify();
  }, []);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Activity"
        accentTail="log."
        subtitle="A tamper-evident audit trail. Ordered by hash-chain sequence, newest first."
      />

      <DenPanel
        title="Chain integrity"
        subtitle="Walks the SHA-256 chain server-side and reports the verdict."
        trailing={
          <PrimaryButton
            label="Re-verify"
            busy={chain.status === 'loading'}
            onClick={() => void verify()}
          />
        }
      >
        {chain.status === 'loading' ? (
          <p className="log__hint" role="status">
            Verifying…
          </p>
        ) : chain.status === 'error' ? (
          <Banner tone="error" title="Verification call failed">
            {chain.message}
          </Banner>
        ) : chain.data.ok ? (
          <Banner tone="success" title="Chain verified">
            Scanned {chain.data.scanned} chained entries
            {chain.data.firstSeq !== null && chain.data.lastSeq !== null
              ? ` (seq ${chain.data.firstSeq}..${chain.data.lastSeq})`
              : ''}
            . {chain.data.unchainedCount} legacy entries sit outside the chain.
          </Banner>
        ) : (
          <Banner tone="error" title="Chain broken">
            {anomalyDetail(chain.data.anomaly)} Scanned {chain.data.scanned}.
          </Banner>
        )}
      </DenPanel>

      <DenPanel
        title="Recent activity"
        subtitle="Newest first, capped at 200 by chain sequence. Legacy pre-chain entries are not shown here. Open an entry for the full record."
      >
        <AsyncRegion
          state={entries}
          what="activity"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="log__hint">Loading activity…</p>}
          empty={<p className="log__hint">No chained activity yet.</p>}
        >
          {(rows) => {
            const visible = rows.filter(
              (e) => activityMatchesStatus(e, statusFilter) && activityMatchesQuery(e, query),
            );
            return (
              <>
                <div className="log__toolbar">
                  <ActivityStatusFilters active={statusFilter} onSelect={setStatusFilter} />
                  <label className="log__search">
                    <span className="log__search-label">Search</span>
                    <input
                      type="search"
                      className="log__search-input"
                      // The payload is in the haystack, which is the whole point:
                      // an operator hunts for an id, and the id is in there.
                      placeholder="Actor, action, target, payload…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                </div>

                {/* The cap is STATED rather than left to be discovered. Removing
                    it needs a paginated listener (page-spec 22 item 6), so until
                    then the honest move is to say what is being shown. */}
                <p className="log__count" role="status">
                  Showing {visible.length} of {rows.length} loaded
                  {rows.length >= ACTIVITY_LOG_QUERY.max
                    ? `, the newest ${String(ACTIVITY_LOG_QUERY.max)} by chain sequence`
                    : ''}
                  .
                </p>

                {visible.length === 0 ? (
                  <p className="log__hint">No entries match this filter.</p>
                ) : (
                  <div className="log">
                    {byDay(visible).map(([day, group]) => (
                      <section key={day} className="log__day">
                        <h3 className="log__day-label">{day}</h3>
                        <ul className="log__rows">
                          {group.map((e) => (
                            <ActivityRow
                              key={e._id}
                              entry={e}
                              open={openIds.has(e._id)}
                              onToggle={() => toggleOpen(e._id)}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

const STATUS_FILTERS: readonly (readonly [ActivityStatusFilter, string])[] = [
  ['all', 'All'],
  ['problems', 'Problems'],
  ['success', 'Success'],
  ['pending', 'Pending'],
];

/**
 * Status facet chips. A `tablist` with `useRovingTabs`, matching the eleven
 * other chip rows in this admin (see the note on `NotificationFilters`); a
 * second keyboard contract for the same visual control is worse than either
 * convention alone.
 *
 * The buckets are fixed rather than data-derived, unlike the notification
 * category chips. `writeAuditEntry` types `status` as a closed union of three
 * values, so these are the real domain, not an invented taxonomy. And
 * "Problems" folds FAILURE with the legacy ERROR spelling, because an operator
 * scanning for trouble does not care which writer produced the row.
 */
function ActivityStatusFilters({
  active,
  onSelect,
}: {
  active: ActivityStatusFilter;
  onSelect: (f: ActivityStatusFilter) => void;
}) {
  const activeIndex = Math.max(
    0,
    STATUS_FILTERS.findIndex(([value]) => value === active),
  );
  const { getTabProps } = useRovingTabs({ count: STATUS_FILTERS.length, activeIndex });

  return (
    <div className="log__filters" role="tablist" aria-label="Filter activity by status">
      {STATUS_FILTERS.map(([value, label], index) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={active === value}
          className={active === value ? 'notif-chip notif-chip--active' : 'notif-chip'}
          onClick={() => onSelect(value)}
          {...getTabProps(index)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * One entry. Collapsed it is the row this screen has always shown; opened it is
 * the full sealed record.
 *
 * EVERY ROW OPENS, including a legacy pre-chain one and one with an empty
 * payload, and that is deliberately different from the notification card next
 * door (which hides its opener when there is nothing to show). An audit entry
 * always has something to disclose (at minimum the full timestamp and the
 * action) and, more importantly, a row that refused to open would be
 * indistinguishable from a row whose record is missing. In an evidence log,
 * "this entry carries no payload" is itself a finding and has to be visible.
 */
function ActivityRow({
  entry,
  open,
  onToggle,
}: {
  entry: ActivityLogEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const detailId = `log-detail-${entry._id}`;
  const detail = activityDetailRows(entry);
  const chain = activityChainRows(entry);
  const payload = activityPayloadRows(entry);

  return (
    <li className={open ? 'log__row log__row--open' : 'log__row'}>
      <button
        type="button"
        className="log__summary"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <code className="log__seq">
          {/* A row can carry a seq but no entryHash; slicing that undefined
              would blank the screen, so read the hash through str(). */}
          {entry.seq !== undefined ? `#${entry.seq} · ${str(entry.entryHash).slice(0, 8)}` : 'legacy'}
        </code>
        <div className="log__body">
          <span className="log__action">{entry.actionType || 'event'}</span>
          {entry.description ? <span className="log__desc">{entry.description}</span> : null}
          {entry.actorId || entry.targetId ? (
            <span className="log__ctx">
              {entry.actorId ? `by ${entry.actorId}` : ''}
              {entry.targetId
                ? `${entry.actorId ? ' · ' : ''}${entry.targetCollection || 'target'}/${entry.targetId}`
                : ''}
            </span>
          ) : null}
        </div>
        <span className={statusClass(str(entry.status))}>{entry.status || '-'}</span>
        <time className="log__time">
          {/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str(entry.timestamp))
            ? str(entry.timestamp).slice(11, 16)
            : ''}
        </time>
      </button>

      {open ? (
        <div className="log__detail" id={detailId}>
          <ActivityFieldList rows={detail} />

          <h4 className="log__detail-heading">What happened</h4>
          {payload.length === 0 ? (
            // Stated, not omitted: an entry whose writer recorded no specifics
            // is a fact about the writer, and hiding the section would read as
            // "this screen has nothing more to show" instead.
            <p className="log__hint">This entry was written with no payload.</p>
          ) : (
            <ActivityFieldList rows={payload} mono />
          )}

          <h4 className="log__detail-heading">Chain seal</h4>
          {chain.length === 0 ? (
            <p className="log__hint">
              Legacy entry, written before the hash chain. Not covered by verification.
            </p>
          ) : (
            <ActivityFieldList rows={chain} mono />
          )}
        </div>
      ) : null}
    </li>
  );
}

function ActivityFieldList({
  rows,
  mono,
}: {
  rows: readonly { label: string; value: string }[];
  mono?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <dl className={mono ? 'log__fields log__fields--mono' : 'log__fields'}>
      {rows.map((row) => (
        <div key={row.label} className="log__field">
          <dt className="log__field-label">{row.label}</dt>
          <dd className="log__field-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
