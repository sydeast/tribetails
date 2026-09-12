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
  activityCategoryOf,
  activityChainRows,
  activityDayLabel,
  activityDetailRows,
  activityIsFailure,
  activityMatchesCategory,
  activityMatchesQuery,
  activityMatchesStatus,
  activityPayloadRows,
  humanizeAction,
  localDayKey,
  type ActivityCategory,
  type ActivityStatusFilter,
} from '../lib/activityDetail';
import { formatTime } from '../lib/denFormat';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton } from '../components/Buttons';
import { IconTile, type IconTileTone } from '../components/IconTile';
import { LoadingRow } from '../components/LoadingRow';
import { Spinner } from '../components/Spinner';
import './ActivityLog.css';

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
 * Drawn to `ui-ideas/auntieos-activity-log-2026-05-27.html` (issue #755): the
 * chain verdict is a badge in the hero band rather than a panel of its own, the
 * filters sit between the hero and the log, and the log is one untitled glass
 * panel of day separators and rows (time, glyph tile, title with the raw code
 * beside it, seq and hash).
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
 *      timestamp rather than the clock slice, the identity and provenance
 *      fields, the FULL chain hashes (an abbreviated hash cannot be verified
 *      against anything), and the flattened payload.
 *   2. FILTER + SEARCH. The mock's six category chips, a status facet
 *      (problems / success / pending) beside them, and a free-text box that
 *      searches the payload as well as the visible fields, because "which entry
 *      mentions this booking id" is the real question and the id lives in the
 *      payload.
 *   3. THE COUNT IS STATED. The listener is capped at 200 by chain sequence;
 *      the panel's meta says how many of how many are shown instead of leaving
 *      the cap to be discovered.
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
  const [category, setCategory] = useState<ActivityCategory>('all');
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

  const today = localDayKey(new Date());

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Activity log"
        title="Every move,"
        accentTail="sealed."
        subtitle="A tamper-evident audit trail, newest first and capped at 200 by chain sequence. Legacy pre-chain entries are not listed. Open an entry for the full record. Re-verify walks the SHA-256 chain server-side and reports the verdict."
        trailing={<ChainBadge chain={chain} onVerify={() => void verify()} />}
      />

      <AsyncRegion
        state={entries}
        what="activity"
        isEmpty={(rows) => rows.length === 0}
        loading={
          <DenPanel title="" className="activity__log">
            <LoadingRow label="Loading activity…" className="den-hint" />
          </DenPanel>
        }
        empty={
          <DenPanel title="" className="activity__log">
            <EmptyHint>No chained activity yet.</EmptyHint>
          </DenPanel>
        }
      >
        {(rows) => {
          const visible = rows.filter(
            (e) =>
              activityMatchesCategory(e, category) &&
              activityMatchesStatus(e, statusFilter) &&
              activityMatchesQuery(e, query),
          );
          // The cap is STATED rather than left to be discovered. Removing it
          // needs a paginated listener (page-spec 22 item 6), so until then
          // the honest move is to say what is being shown.
          const count =
            `${visible.length} of ${rows.length} loaded` +
            (rows.length >= ACTIVITY_LOG_QUERY.max
              ? `, the newest ${String(ACTIVITY_LOG_QUERY.max)} by seq`
              : '');
          return (
            <>
              <div className="activity__filters">
                <ActivityCategoryFilters active={category} onSelect={setCategory} />
                <ActivityStatusFilters active={statusFilter} onSelect={setStatusFilter} />
                <label className="activity__search">
                  <span className="activity__search-glyph" aria-hidden="true">
                    <SearchGlyph />
                  </span>
                  <input
                    type="search"
                    className="activity__search-input"
                    aria-label="Search activity"
                    // The payload is in the haystack, which is the whole point:
                    // an operator hunts for an id, and the id is in there.
                    placeholder="Search actor, action, target, payload…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>

              <DenPanel title="" meta={count} className="activity__log">
                {visible.length === 0 ? (
                  <EmptyHint>No entries match this filter.</EmptyHint>
                ) : (
                  byDay(visible).map(([day, group]) => (
                    <section key={day} className="activity__day">
                      <h3 className="activity__day-label">{activityDayLabel(day, today)}</h3>
                      <ul className="activity__rows">
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
                  ))
                )}
              </DenPanel>
            </>
          );
        }}
      </AsyncRegion>
    </div>
  );
}

/**
 * The mock's `.chain`: a lit dot, the verdict, a mono line of numbers and the
 * Re-verify button, in the hero's trailing slot.
 *
 * Four states, and each says which it is in words as well as in colour: the
 * dot is teal only for a verified chain, red for a broken one or a failed call,
 * and while the callable is in flight the dot is replaced by the spinner
 * (issue #714: verifyActivityLogChain cold-starts at up to 8.3s, and a badge
 * that only changed its button label left 8 seconds with nothing moving).
 */
function ChainBadge({ chain, onVerify }: { chain: Async<VerifyResult>; onVerify: () => void }) {
  const verifying = chain.status === 'loading';
  const state =
    chain.status === 'loading'
      ? 'verifying'
      : chain.status === 'error'
        ? 'failed'
        : chain.data.ok
          ? 'verified'
          : 'broken';

  let verdict: string;
  let line: string;
  if (chain.status === 'loading') {
    verdict = 'Verifying the chain';
    line = 'Walking the SHA-256 chain server-side.';
  } else if (chain.status === 'error') {
    verdict = 'Verification call failed';
    line = chain.message;
  } else if (chain.data.ok) {
    const d = chain.data;
    const range = d.firstSeq !== null && d.lastSeq !== null ? ` · seq ${d.firstSeq}..${d.lastSeq}` : '';
    const legacy = d.unchainedCount > 0 ? ` · ${d.unchainedCount.toLocaleString('en-US')} legacy outside the chain` : '';
    verdict = 'Chain verified';
    line = `${d.scanned.toLocaleString('en-US')} entries${range} · 0 anomalies${legacy}`;
  } else {
    verdict = 'Chain broken';
    line = `${anomalyDetail(chain.data.anomaly)} Scanned ${chain.data.scanned}.`;
  }

  const alarming = state === 'broken' || state === 'failed';

  return (
    <div className="activity__chain" data-state={state}>
      {verifying ? (
        <Spinner label="Verifying…" />
      ) : (
        <span className="activity__led" aria-hidden="true" />
      )}
      {/* One live region for the verdict: polite while it is working or fine,
          assertive the moment the chain is broken or the call fails. */}
      <span className="activity__chain-text" role={alarming ? 'alert' : 'status'} aria-live={alarming ? 'assertive' : 'polite'}>
        <b className="activity__chain-verdict">{verdict}</b>
        <small className="activity__chain-line">{line}</small>
      </span>
      <GhostButton label="Re-verify" onClick={onVerify} disabled={verifying} />
    </div>
  );
}

/** The mock's search glyph: a magnifier, inline because no icon package is installed here. */
function SearchGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
    </svg>
  );
}

const CATEGORY_FILTERS: readonly (readonly [ActivityCategory, string])[] = [
  ['all', 'All'],
  ['auth', 'Auth'],
  ['bookings', 'Bookings'],
  ['kintales', 'KinTales'],
  ['notifications', 'Notifications'],
  ['admin', 'Admin'],
];

const STATUS_FILTERS: readonly (readonly [ActivityStatusFilter, string])[] = [
  ['all', 'Any status'],
  ['problems', 'Problems'],
  ['success', 'Success'],
  ['pending', 'Pending'],
];

/**
 * The mock's six category chips, the same taxonomy Android's `ActivityFilter`
 * has drawn since its Den port. A `tablist` with `useRovingTabs`, matching the
 * other chip rows in this admin (see the note on `NotificationFilters`).
 */
function ActivityCategoryFilters({
  active,
  onSelect,
}: {
  active: ActivityCategory;
  onSelect: (c: ActivityCategory) => void;
}) {
  return (
    <ChipTabs
      label="Filter activity by category"
      options={CATEGORY_FILTERS}
      active={active}
      onSelect={onSelect}
    />
  );
}

/**
 * The status facet. Not in the mock: it arrived with R5 (2026-08-03) and stays
 * beside the category chips, behind a hairline, as the second question an
 * operator asks of the trail ("what went wrong?" after "what kind of thing?").
 *
 * The buckets are fixed rather than data-derived. `writeAuditEntry` types
 * `status` as a closed union of three values, so these are the real domain, and
 * "Problems" folds FAILURE with the legacy ERROR spelling because an operator
 * scanning for trouble does not care which writer produced the row.
 */
function ActivityStatusFilters({
  active,
  onSelect,
}: {
  active: ActivityStatusFilter;
  onSelect: (f: ActivityStatusFilter) => void;
}) {
  return (
    <ChipTabs
      label="Filter activity by status"
      options={STATUS_FILTERS}
      active={active}
      onSelect={onSelect}
      className="activity__chips--status"
    />
  );
}

/** One chip row: a tablist whose active chip is the mock's cream-on-navy `.fchip.on`. */
function ChipTabs<T extends string>({
  label,
  options,
  active,
  onSelect,
  className,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  active: T;
  onSelect: (value: T) => void;
  className?: string;
}) {
  const activeIndex = Math.max(
    0,
    options.findIndex(([value]) => value === active),
  );
  const { getTabProps } = useRovingTabs({ count: options.length, activeIndex });

  return (
    <div className={className ? `activity__chips ${className}` : 'activity__chips'} role="tablist" aria-label={label}>
      {options.map(([value, text], index) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={active === value}
          className="activity__chip"
          onClick={() => onSelect(value)}
          {...getTabProps(index)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The mock's `.ico` per category: its glyph and its tone. A failure row takes
 * the warning glyph in the error tone whatever its category, the same rule
 * Android's `actionIcon` applies, so trouble reads at a glance without a
 * status pill on the row (the mock draws none).
 */
const CATEGORY_TILE: Record<Exclude<ActivityCategory, 'all'>, { glyph: string; tone: IconTileTone }> = {
  auth: { glyph: '⚿', tone: 'purple' },
  bookings: { glyph: '◷', tone: 'orange' },
  kintales: { glyph: '✎', tone: 'success' },
  notifications: { glyph: '▣', tone: 'teal' },
  admin: { glyph: '⚑', tone: 'error' },
};

function rowTile(entry: ActivityLogEntry): { glyph: string; tone: IconTileTone } {
  if (activityIsFailure(entry)) return { glyph: '⚠', tone: 'error' };
  const category = activityCategoryOf(entry);
  return category === null ? { glyph: '·', tone: 'neutral' } : CATEGORY_TILE[category];
}

/** The mock's `.meta small`: description, actor, target, whichever are on the record. */
function rowContext(entry: ActivityLogEntry): string {
  const parts: string[] = [];
  if (str(entry.description).trim() !== '') parts.push(str(entry.description).trim());
  if (str(entry.actorId).trim() !== '') parts.push(str(entry.actorId).trim());
  const targetId = str(entry.targetId).trim();
  const targetCollection = str(entry.targetCollection).trim();
  if (targetId !== '' && targetCollection !== '') parts.push(`${targetCollection}/${targetId}`);
  else if (targetId !== '') parts.push(targetId);
  else if (targetCollection !== '') parts.push(targetCollection);
  return parts.join(' · ');
}

/**
 * One entry. Collapsed it is the mock's row; opened it is the full sealed
 * record.
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
  const tile = rowTile(entry);
  const context = rowContext(entry);
  const timestamp = str(entry.timestamp);
  const clock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp) ? formatTime(timestamp) : '';
  // A row can carry a seq but no entryHash; slicing that undefined would blank
  // the screen, so read the hash through str().
  const hash = str(entry.entryHash).slice(0, 8);

  return (
    <li className={open ? 'activity__row activity__row--open' : 'activity__row'}>
      <button
        type="button"
        className="activity__summary"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <time className="activity__time" dateTime={timestamp || undefined}>
          {clock}
        </time>
        <IconTile icon={tile.glyph} size={26} tone={tile.tone} className="activity__ico" />
        <span className="activity__meta">
          <span>
            <b className="activity__title">{humanizeAction(str(entry.actionType))}</b>
            {entry.actionType ? <code className="activity__code">{entry.actionType}</code> : null}
          </span>
          {context !== '' ? <small className="activity__ctx">{context}</small> : null}
        </span>
        <span className="activity__seq">
          {entry.seq !== undefined ? (
            <>
              <span className="activity__seq-n">#{entry.seq}</span>
              {hash !== '' ? (
                <span className="activity__hash">
                  <i className="activity__lk" aria-hidden="true" />
                  {hash}
                </span>
              ) : null}
            </>
          ) : (
            <span className="activity__seq-n">legacy</span>
          )}
        </span>
      </button>

      {open ? (
        <div className="activity__detail" id={detailId}>
          <ActivityFieldList rows={detail} />

          <h4 className="activity__detail-heading">What happened</h4>
          {payload.length === 0 ? (
            // Stated, not omitted: an entry whose writer recorded no specifics
            // is a fact about the writer, and hiding the section would read as
            // "this screen has nothing more to show" instead.
            <EmptyHint>This entry was written with no payload.</EmptyHint>
          ) : (
            <ActivityFieldList rows={payload} mono />
          )}

          <h4 className="activity__detail-heading">Chain seal</h4>
          {chain.length === 0 ? (
            <EmptyHint>Legacy entry, written before the hash chain. Not covered by verification.</EmptyHint>
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
    <dl className={mono ? 'activity__fields activity__fields--mono' : 'activity__fields'}>
      {rows.map((row) => (
        <div key={row.label} className="activity__field">
          <dt className="activity__field-label">{row.label}</dt>
          <dd className="activity__field-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
