import { useCallback, useEffect, useState } from 'react';
import type { NotificationCatalogEntry, NotificationMatrix, UngatedSend } from '../api/myNotifications';
import { listNotificationDeliveries, type DeliveryEvidence } from '../api/notificationDeliveries';
import {
  deliveryPhrase,
  hasPartialDataNote,
  mergeFieldNames,
  recipientLines,
  templateLines,
  type RowBadge,
} from '../lib/notificationProvenance';
import { GhostButton } from '../components/Buttons';

/**
 * The answer half of the notification gate (#396).
 *
 * The gate matrix has always let the operator turn notifications on and off. It
 * has never told them what they were turning on and off. This is the part that
 * does: for one catalog row, who receives it, what fires it, which template
 * renders each channel, what the body can carry, and what the last few real
 * sends actually did.
 *
 * Deliberately NOT a `<details>` element. Folded content in a `<details>` is
 * still in the DOM and jsdom reports it visible, so a test asserting the detail
 * is hidden passes whether or not it is. This mounts and unmounts on a plain
 * toggle button, which is testable and which also means the delivery fetch only
 * happens for a row someone actually opened.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** LOCAL `MM-DD HH:mm`, matching `lib/time.ts` formatWhen but from epoch ms. */
function whenMs(ms: number | null): string {
  if (ms === null) return 'no time recorded';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BadgeRow({ badges }: { badges: RowBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="notifgate__badges">
      {badges.map((badge) => (
        <span
          key={badge.label}
          className={`notifgate__badge notifgate__badge--${badge.tone}`}
          title={badge.detail}
        >
          {badge.label}
          {/* The badge word alone is a hint; the sentence is the actual answer,
              and a screen reader gets it rather than a bare "Never fires". */}
          <span className="notifgate__sr-only">: {badge.detail}</span>
        </span>
      ))}
    </span>
  );
}

interface DetailProps {
  entry: NotificationCatalogEntry;
  matrix: NotificationMatrix;
}

export function GateRowDetail({ entry, matrix }: DetailProps) {
  const who = recipientLines(entry, matrix.businessAdminCount, matrix.businessAdminRosterPath);
  const templates = templateLines(entry);
  const fields = mergeFieldNames(entry);

  return (
    <div className="notifgate__detail">
      <section className="notifgate__detail-block">
        <h4 className="notifgate__detail-heading">Who receives it</h4>
        {who.length === 0 ? (
          <p className="notifgate__detail-empty">
            The server sent no recipient rule for this row. Upgrade MyTribe functions to see it.
          </p>
        ) : (
          <ul className="notifgate__detail-list">
            {who.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="notifgate__detail-block">
        <h4 className="notifgate__detail-heading">What fires it</h4>
        {entry.emitters.length === 0 ? (
          <p className="notifgate__detail-empty">
            Nothing in the platform dispatches this notification, so nothing sets it off. The
            toggles on this row change what nobody receives.
          </p>
        ) : (
          <ul className="notifgate__detail-list">
            {entry.emitters.map((emitter) => (
              <li key={`${emitter.source}:${emitter.trigger}`}>
                {emitter.trigger} <code className="notifgate__code">{emitter.source}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="notifgate__detail-block">
        <h4 className="notifgate__detail-heading">Which template writes it</h4>
        {templates.length === 0 ? (
          <p className="notifgate__detail-empty">This row offers no channels at all.</p>
        ) : (
          <>
            {/* Reporting, not editing. Template Assignments (#439) owns the
                routing table and is where an email gets repointed; both screens
                read the same bindings, so they cannot disagree about what a key
                sends. This line exists so the gate stops naming a catalog
                document that has not rendered anything since the rebind. */}
            <p className="notifgate__detail-note">
              This is what each channel sends today. Repoint an email on the Template
              Assignments screen.
            </p>
            <ul className="notifgate__detail-list">
              {templates.map((line) => (
                <li key={line.channel}>
                  {line.channel}: <code className="notifgate__code">{line.path}</code>
                  {line.missing && ' (this channel is offered with nothing to render it)'}
                  {line.retargetedFrom && (
                    <> (retargeted; the catalog default is {line.retargetedFrom})</>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="notifgate__detail-block">
        <h4 className="notifgate__detail-heading">What the body can carry</h4>
        {fields.length === 0 ? (
          <p className="notifgate__detail-empty">No merge fields are recorded for this row.</p>
        ) : (
          <>
            <p className="notifgate__detail-note">
              Anything on this list can appear in the message, and therefore reach whoever the
              recipient rule above resolves to.
            </p>
            <p className="notifgate__detail-fields">
              {fields.map((field) => (
                <code key={field} className="notifgate__code">
                  {field}
                </code>
              ))}
            </p>
            {hasPartialDataNote(entry) && (
              <p className="notifgate__detail-note">
                {entry.emitters
                  .map((e) => e.dataNote)
                  .filter((n): n is string => Boolean(n))
                  .join(' ')}
              </p>
            )}
          </>
        )}
      </section>

      <DeliveryEvidencePanel notificationKey={entry.key} />
    </div>
  );
}

/**
 * The last few real sends of one catalog key.
 *
 * Loaded on demand, once per opened row: the operator asking "what could go out"
 * usually asks about one notification, and prefetching 44 keys' dispatch history
 * to answer it would be a lot of reads for a question nobody asked.
 */
export function DeliveryEvidencePanel({ notificationKey }: { notificationKey: string }) {
  const [evidence, setEvidence] = useState<DeliveryEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setLoading(true);
    listNotificationDeliveries({ key: notificationKey, limit: 10 })
      .then((res) => {
        if (!live) return;
        setEvidence(res);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Something went wrong');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [notificationKey]);

  useEffect(() => load(), [load]);

  return (
    <section className="notifgate__detail-block">
      <h4 className="notifgate__detail-heading">Whether it got out</h4>
      {loading ? (
        <p className="notifgate__detail-empty">Reading the delivery log…</p>
      ) : error ? (
        <p className="notifgate__detail-error">
          Couldn&rsquo;t read the delivery log: {error}{' '}
          <GhostButton label="Retry" onClick={load} />
        </p>
      ) : !evidence || evidence.deliveries.length === 0 ? (
        <p className="notifgate__detail-empty">
          This notification has not been dispatched yet, so there is nothing to show. An empty log
          is not evidence it failed.
        </p>
      ) : (
        <>
          <p className="notifgate__detail-note">{evidence.sentMeaning}</p>
          <ul className="notifgate__detail-list">
            {evidence.deliveries.map((row) => (
              <li key={row.dispatchId}>
                <span className="notifgate__delivery-when">{whenMs(row.createdAtMs)}</span>{' '}
                to <code className="notifgate__code">{row.recipientUid || 'unknown recipient'}</code>
                {row.attempts.length === 0 ? (
                  <>: no channel was attempted (the gate resolved to nothing for them).</>
                ) : (
                  <ul className="notifgate__delivery-attempts">
                    {row.attempts.map((attempt) => {
                      const phrase = deliveryPhrase(
                        attempt.status,
                        attempt.skipReason,
                        attempt.errorMessage,
                      );
                      return (
                        <li key={attempt.channel} className={`notifgate__attempt notifgate__attempt--${phrase.tone}`}>
                          <strong>{attempt.channel}</strong>: {phrase.label}. {phrase.detail}
                          {attempt.providerMessageId && (
                            <>
                              {' '}
                              Provider id{' '}
                              <code className="notifgate__code">{attempt.providerMessageId}</code>.
                            </>
                          )}
                          {attempt.attempts > 1 && <> Tried {attempt.attempts} times.</>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The mail this screen does NOT govern.
 *
 * Without it, a screen titled "every notification, with an on/off switch" reads
 * as a complete inventory of what the platform can send, and it is not one:
 * invites, account recovery and the error digest go out through
 * `sendFromTemplate` with no catalog row and no gate. Leaving them off the
 * screen is the same class of blindness #396 is about.
 */
export function UngatedSendsPanel({ sends }: { sends: UngatedSend[] }) {
  if (sends.length === 0) return null;
  return (
    <div className="notifgate__ungated">
      <h3 className="notifgate__section-heading">ALSO SENT, BUT NOT GATED HERE</h3>
      <p className="notifgate__detail-note">
        These emails go straight out from a template, with no catalog row and no channel
        resolution. Nothing on this screen turns them off.
      </p>
      <ul className="notifgate__detail-list">
        {sends.map((send) => (
          <li key={`${send.source}:${send.templateId}`}>
            <code className="notifgate__code">emailTemplates/{send.templateId}</code>, sent when: {send.trigger}{' '}
            <code className="notifgate__code">{send.source}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
