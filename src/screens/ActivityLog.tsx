import { useState } from 'react';
import {
  ACTIVITY_LOG_QUERY,
  verifyActivityLogChain,
  type ActivityLogEntry,
  type VerifyResult,
} from '../api/activityLog';
import { useCollection } from '../lib/firestore';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton } from '../components/Buttons';

function statusClass(status: string): string {
  const s = status.toUpperCase();
  if (s === 'SUCCESS') return 'log__status log__status--ok';
  if (s === 'FAILURE') return 'log__status log__status--fail';
  return 'log__status log__status--pending';
}

/** Group rows by calendar day (the leading YYYY-MM-DD of the ISO timestamp). */
function byDay(rows: ActivityLogEntry[]): [string, ActivityLogEntry[]][] {
  const groups = new Map<string, ActivityLogEntry[]>();
  for (const r of rows) {
    const day = /^\d{4}-\d{2}-\d{2}/.test(r.timestamp) ? r.timestamp.slice(0, 10) : 'Undated';
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(r);
  }
  return [...groups.entries()];
}

/**
 * Admin Activity Log. Streams the `activity_log` collection through the bounded,
 * server-ordered listener (seq desc, capped 200 — AO-29 fixed by construction),
 * and verifies the SHA-256 hash chain on demand via verifyActivityLogChain.
 */
export function ActivityLog() {
  const entries = useCollection<ActivityLogEntry>(ACTIVITY_LOG_QUERY);
  const [chain, setChain] = useState<Async<VerifyResult> | null>(null); // null = not run yet

  async function verify() {
    setChain({ status: 'loading' });
    try {
      setChain({ status: 'ready', data: await verifyActivityLogChain() });
    } catch (err) {
      setChain({ status: 'error', message: err instanceof Error ? err.message : 'Verification failed.' });
    }
  }

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
            label="Verify chain"
            busy={chain?.status === 'loading'}
            onClick={() => void verify()}
          />
        }
      >
        {chain === null ? (
          <p className="log__hint">Not verified this session. Run a check to confirm the chain is intact.</p>
        ) : chain.status === 'loading' ? (
          <p className="log__hint">Verifying…</p>
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
            First break: {chain.data.anomaly.code} at seq {chain.data.anomaly.seq}
            {chain.data.anomaly.expectedSeq !== undefined
              ? ` (expected ${chain.data.anomaly.expectedSeq})`
              : ''}{' '}
            — entry <code>{chain.data.anomaly.entryId}</code>. Scanned {chain.data.scanned}.
          </Banner>
        )}
      </DenPanel>

      <DenPanel
        title="Recent activity"
        subtitle="Newest first, capped at 200 by chain sequence. Legacy pre-chain entries are not shown here."
      >
        <AsyncRegion
          state={entries}
          what="activity"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="log__hint">Loading activity…</p>}
          empty={<p className="log__hint">No chained activity yet.</p>}
        >
          {(rows) => (
            <div className="log">
              {byDay(rows).map(([day, group]) => (
                <section key={day} className="log__day">
                  <h3 className="log__day-label">{day}</h3>
                  <ul className="log__rows">
                    {group.map((e) => (
                      <li key={e._id} className="log__row">
                        <code className="log__seq">
                          {e.seq !== undefined ? `#${e.seq} · ${e.entryHash.slice(0, 8)}` : 'legacy'}
                        </code>
                        <div className="log__body">
                          <span className="log__action">{e.actionType || 'event'}</span>
                          {e.description ? <span className="log__desc">{e.description}</span> : null}
                        </div>
                        <span className={statusClass(e.status)}>{e.status || '—'}</span>
                        <time className="log__time">
                          {/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.timestamp)
                            ? e.timestamp.slice(11, 16)
                            : ''}
                        </time>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}
