import { useCallback, useEffect, useState } from 'react';
import {
  getNotificationMatrix,
  NOTIFICATION_CHANNELS,
  STREAM_BUSINESS,
  type NotificationCatalogEntry,
  type NotificationChannel,
  type NotificationMatrix,
  type NotificationOverride,
  type NotifStream,
} from '../api/myNotifications';
import { saveBusinessNotificationOverride } from '../api/notificationOverridesWrite';
import {
  displayTitle,
  lockReasonFor,
  sectionedNotifications,
  streamEffectiveChannel,
  streamEffectiveChannelLocked,
  streamEffectiveEnabled,
  streamEffectiveLockedEnabled,
} from '../lib/myNotificationsFormat';
import {
  NOTIF_AUDIENCES,
  alwaysEnabledFor,
  audienceBlurb,
  catalogForStream,
  currentOverride,
  setLockReason,
  setStreamChannel,
  setStreamEnabled,
  sharedCopyCaption,
  toggledStreamChannelLock,
  toggledStreamEnabledLock,
} from '../lib/notificationGateEdit';
import { rowBadges } from '../lib/notificationProvenance';
import { BadgeRow, GateRowDetail, UngatedSendsPanel } from './NotificationGateDetail';
import { DenPanel } from '../components/DenScreenKit';
import { Banner } from '../components/Banner';
import { Toggle } from '../components/Toggle';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { useRovingTabs } from '../lib/useRovingTabs';
import './NotificationGate.css';

const LOCK_REASON_MAX = 300;

/** Short column labels for the compact matrix header (channelLabel is the long form). */
function columnLabel(channel: NotificationChannel): string {
  switch (channel) {
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS';
    case 'push':
      return 'Push';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * The BUSINESS notification gate matrix. Ports the wasm SettingsScreen.kt
 * NotificationMatrixPanel: the operator's single source of truth for which
 * channels each notification OFFERS, tabbed by audience (Business / Staff /
 * Kinfolk). For each notification a row shows an on/off master plus one toggle
 * per channel, each with a lock (force it on for recipients), and a lock-reason
 * editor under any locked row.
 *
 * Reads the catalog + saved overrides via `getNotificationMatrix`
 * (api/myNotifications.ts, the same callable the operator's own My Notifications
 * screen reads). Persists each edit immediately and optimistically via
 * `saveBusinessNotificationOverride` (api/notificationOverridesWrite.ts); a save
 * failure is fail-loud (an error banner) and reloads to server truth rather than
 * leaving the optimistic edit standing. A row shown under tab T edits `streams[T]`
 * (a per-stream overlay), never the flat fields, so a shared key gates each
 * audience's copy independently, exactly like the Compose panel.
 *
 * Embedded in the Settings "Notifications" section is the only place this
 * renders now (#718 retired the standalone `/notification-gate` screen and
 * its rail entry, leaving Settings as the one way in). It no longer renders
 * its own page heading: Settings' own heading and section tab already say
 * where the operator is, so a second "Notification gate." heading nested
 * inside the tab panel would only repeat that.
 */
export function NotificationGate() {
  const [matrix, setMatrix] = useState<NotificationMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedStream, setSelectedStream] = useState<NotifStream>(STREAM_BUSINESS);

  const load = useCallback(() => {
    let live = true;
    setLoading(true);
    getNotificationMatrix()
      .then((m) => {
        if (!live) return;
        setMatrix(m);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(`Couldn't load the notification gate: ${errMessage(err)}`);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Optimistic write: apply the edit locally, persist it, and on failure surface
  // the error and reload to server truth (never leave a phantom optimistic edit).
  function persist(entry: NotificationCatalogEntry, override: NotificationOverride) {
    if (!matrix) return;
    setMatrix({ ...matrix, overrides: { ...matrix.overrides, [entry.key]: override } });
    saveBusinessNotificationOverride(entry.key, override)
      .then(() => setSaveError(null))
      .catch((err: unknown) => {
        setSaveError(`saveBusinessNotificationOverride failed: ${errMessage(err)}`);
        load();
      });
  }

  const activeIndex = Math.max(
    0,
    NOTIF_AUDIENCES.findIndex((a) => a.stream === selectedStream),
  );
  const { getTabProps } = useRovingTabs({ count: NOTIF_AUDIENCES.length, activeIndex });
  const audienceTitle = NOTIF_AUDIENCES[activeIndex]?.title ?? 'Business';

  return (
    <div className="screen">
      {saveError && (
        <Banner tone="error" title="Save failed">
          {saveError}
        </Banner>
      )}

      <DenPanel
        title="Notification gate"
        subtitle="This is the gate: it decides which channels every notification even offers before anyone
        picks their own preferences. Turn a channel on to offer it, lock it to force it on for
        recipients and carry your reason, or turn it off to hide it. Each tab gates one audience, and
        a notification can serve more than one."
      >
        {loading ? (
          <p className="notifgate__hint">Loading the notification gate…</p>
        ) : loadError ? (
          <Banner tone="error" title="Couldn&rsquo;t load the notification gate" trailing={<GhostButton label="Retry" onClick={load} />}>
            {loadError}
          </Banner>
        ) : !matrix || matrix.catalog.length === 0 ? (
          <p className="notifgate__hint">No notification types in the catalog yet.</p>
        ) : (
          <NotificationGateBody
            matrix={matrix}
            selectedStream={selectedStream}
            onSelectStream={setSelectedStream}
            getTabProps={getTabProps}
            audienceTitle={audienceTitle}
            onPersist={persist}
          />
        )}
      </DenPanel>
    </div>
  );
}

interface GateBodyProps {
  matrix: NotificationMatrix;
  selectedStream: NotifStream;
  onSelectStream: (stream: NotifStream) => void;
  getTabProps: ReturnType<typeof useRovingTabs>['getTabProps'];
  audienceTitle: string;
  onPersist: (entry: NotificationCatalogEntry, override: NotificationOverride) => void;
}

function NotificationGateBody({
  matrix,
  selectedStream,
  onSelectStream,
  getTabProps,
  audienceTitle,
  onPersist,
}: GateBodyProps) {
  const shown = catalogForStream(matrix.catalog, selectedStream);
  const sections = sectionedNotifications(shown, selectedStream);

  return (
    <>
      <div className="notifgate__tabs" role="tablist" aria-label="Notification audience">
        {NOTIF_AUDIENCES.map((audience, index) => {
          const active = audience.stream === selectedStream;
          const count = catalogForStream(matrix.catalog, audience.stream).length;
          return (
            <button
              key={audience.stream}
              type="button"
              role="tab"
              aria-selected={active}
              className={active ? 'notifgate__tab notifgate__tab--active' : 'notifgate__tab'}
              onClick={() => onSelectStream(audience.stream)}
              {...getTabProps(index)}
            >
              {audience.title} <span className="notifgate__tab-count">{count}</span>
            </button>
          );
        })}
      </div>

      <p className="notifgate__blurb">{audienceBlurb(selectedStream)}</p>

      <div className="notifgate__matrix">
        <div className="notifgate__header">
          <span className="notifgate__header-title" />
          <span className="notifgate__col">On/Off</span>
          {NOTIFICATION_CHANNELS.map((channel) => (
            <span key={channel} className="notifgate__col">
              {columnLabel(channel)}
            </span>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="notifgate__hint">No notifications in this tab.</p>
        ) : (
          sections.map(([section, rows]) => (
            <div key={section.title} className="notifgate__section">
              <h3 className="notifgate__section-heading">{section.title.toUpperCase()}</h3>
              {rows.map((entry) => (
                <GateRow
                  key={entry.key}
                  entry={entry}
                  matrix={matrix}
                  stream={selectedStream}
                  audienceTitle={audienceTitle}
                  onPersist={onPersist}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <UngatedSendsPanel sends={matrix.ungated} />
    </>
  );
}

interface GateRowProps {
  entry: NotificationCatalogEntry;
  matrix: NotificationMatrix;
  stream: NotifStream;
  audienceTitle: string;
  onPersist: (entry: NotificationCatalogEntry, override: NotificationOverride) => void;
}

function GateRow({ entry, matrix, stream, audienceTitle, onPersist }: GateRowProps) {
  const [open, setOpen] = useState(false);
  const title = displayTitle(entry);
  const enabled = streamEffectiveEnabled(matrix, entry.key, stream);
  const enabledLockOn = streamEffectiveLockedEnabled(matrix, entry.key, stream);
  const anyChannelLockOn = NOTIFICATION_CHANNELS.some((c) =>
    streamEffectiveChannelLocked(matrix, entry.key, stream, c),
  );
  const caption = sharedCopyCaption(entry, stream);
  // The "Always on" caption used to sit here and was not true: nothing enforces
  // `alwaysEnabled` at send time (ruling #7, warn-but-allow-off). `rowBadges`
  // replaces it with a risk marker that escalates to a warning once the row is
  // actually switched off. See lib/notificationProvenance.ts for the full why.
  const badges = rowBadges(entry, stream, enabled);
  // Unchanged on purpose: the lock-reason editor belongs to LOCKED rows and to
  // the always-on ones, not to every row that grew a badge. A "Never fires" or
  // "Marketing" badge must not sprout a "why it stays on" field with nothing
  // locked behind it.
  const showReason = enabledLockOn || anyChannelLockOn || alwaysEnabledFor(entry, stream);

  return (
    <div className="notifgate__row">
      <div className="notifgate__row-line">
        <div className="notifgate__row-main">
          <span className="notifgate__row-title">{title}</span>
          <BadgeRow badges={badges} />
          {caption && <span className="notifgate__row-caption">{caption}</span>}
          <button
            type="button"
            className="notifgate__detail-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide details' : 'Who gets this, and what fires it'}
          </button>
        </div>

        <GateCell
          on={enabled}
          locked={enabledLockOn}
          toggleLabel={`${title}, on or off for ${audienceTitle}`}
          lockLabel={enabledLockOn ? `Locked on for ${audienceTitle}, tap to unlock` : `Lock on for ${audienceTitle}`}
          onToggle={() =>
            onPersist(entry, setStreamEnabled(currentOverride(matrix, entry), stream, !enabled))
          }
          onToggleLock={() => onPersist(entry, toggledStreamEnabledLock(matrix, entry, stream))}
        />

        {NOTIFICATION_CHANNELS.map((channel) => {
          const channelOn = streamEffectiveChannel(matrix, entry.key, stream, channel);
          const channelLocked = streamEffectiveChannelLocked(matrix, entry.key, stream, channel);
          return (
            <GateCell
              key={channel}
              on={channelOn}
              locked={channelLocked}
              // On/Off supersedes channels: a channel toggle is inert while the
              // notification's master is off, but stays visible.
              toggleDisabled={!enabled}
              toggleLabel={`${title} via ${columnLabel(channel)} for ${audienceTitle}`}
              lockLabel={
                channelLocked
                  ? `${columnLabel(channel)} locked on for ${audienceTitle}, tap to unlock`
                  : `Lock ${columnLabel(channel)} on for ${audienceTitle}`
              }
              onToggle={() =>
                onPersist(
                  entry,
                  setStreamChannel(currentOverride(matrix, entry), stream, channel, !channelOn),
                )
              }
              onToggleLock={() =>
                onPersist(entry, toggledStreamChannelLock(matrix, entry, stream, channel))
              }
            />
          );
        })}
      </div>

      {showReason && (
        <GateLockReason
          key={entry.key}
          reason={lockReasonFor(matrix, entry.key)}
          onSave={(text) => onPersist(entry, setLockReason(currentOverride(matrix, entry), text))}
        />
      )}
      {open && <GateRowDetail entry={entry} matrix={matrix} />}
    </div>
  );
}

interface GateCellProps {
  on: boolean;
  locked: boolean;
  toggleLabel: string;
  lockLabel: string;
  toggleDisabled?: boolean;
  onToggle: () => void;
  onToggleLock: () => void;
}

/** One aligned matrix cell: a toggle over a lock control. */
function GateCell({ on, locked, toggleLabel, lockLabel, toggleDisabled = false, onToggle, onToggleLock }: GateCellProps) {
  return (
    <div className="notifgate__cell">
      <Toggle checked={on} onChange={onToggle} disabled={toggleDisabled} label={toggleLabel} />
      <button
        type="button"
        className={locked ? 'notifgate__lock notifgate__lock--on' : 'notifgate__lock'}
        aria-pressed={locked}
        aria-label={lockLabel}
        onClick={onToggleLock}
      >
        {locked ? <LockIcon /> : <LockOpenIcon />}
      </button>
    </div>
  );
}

interface GateLockReasonProps {
  reason: string | undefined;
  onSave: (text: string) => void;
}

/**
 * Compact inline editor for the operator's lock reason, shown under any row that
 * carries an active lock. Saving persists through the same override write; an
 * empty save clears the reason (the wire treats "" as an explicit clear). Ports
 * NotifLockReasonEditor from SettingsScreen.kt.
 */
function GateLockReason({ reason, onSave }: GateLockReasonProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(reason ?? '');
  const tooLong = draft.length > LOCK_REASON_MAX;

  if (!editing) {
    return (
      <div className="notifgate__reason">
        <div className="notifgate__reason-view">
          <span
            className={
              reason ? 'notifgate__reason-text' : 'notifgate__reason-text notifgate__reason-text--empty'
            }
          >
            {reason ?? 'Tell folks why this one stays on'}
          </span>
          <GhostButton
            label={reason ? 'Edit reason' : 'Add reason'}
            onClick={() => {
              setDraft(reason ?? '');
              setEditing(true);
            }}
          />
        </div>
      </div>
    );
  }

  function commit() {
    if (tooLong) return;
    onSave(draft.trim());
    setEditing(false);
  }

  return (
    <div className="notifgate__reason">
      <div className="notifgate__reason-edit">
        <label className="notifgate__reason-field">
          <span className="notifgate__reason-label">Why it stays on</span>
          <input
            type="text"
            className="notifgate__reason-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Tell folks why this one stays on"
            aria-invalid={tooLong}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
          />
          {tooLong && <span className="notifgate__reason-error">Keep it under 300 characters</span>}
        </label>
        <PrimaryButton label="Save" onClick={commit} disabled={tooLong} />
        <GhostButton label="Cancel" onClick={() => setEditing(false)} />
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function LockOpenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-1.9" />
    </svg>
  );
}
