import { useCallback, useEffect, useState } from 'react';
import { getFeatureFlags, setFeatureFlags, type FeatureFlags as Flags } from '../api/featureFlags';
import {
  KEY_COMMUNICATE_COMMS_RECAP,
  KEY_INBOX_WAITING_SECTIONS,
} from '../lib/featureFlagsCatalog';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Toggle } from '../components/Toggle';
import { LoadingRow } from '../components/LoadingRow';

/** One togglable flag: stable dotted key + operator label + what it gates. */
export interface FlagMeta {
  key: string;
  label: string;
  detail: string;
}

/**
 * The genuinely-gated `auntieos.*` flags only. Built features that ship ON have
 * no row (they are not experimental), mirrors the Kotlin clients' curated FLAGS
 * lists. Keys come from the shared featureFlagsCatalog, not string literals, so
 * a typo can never silently drop a row. FeatureFlags.coverage.test.ts pins this
 * to exactly catalog KEYS minus ALWAYS_ON, the guarantee the Kotlin
 * FeatureFlagsScreenCoverageTest gives those two clients, now ported here.
 */
export const FLAGS: readonly FlagMeta[] = [
  {
    key: KEY_COMMUNICATE_COMMS_RECAP,
    label: 'Communicate: comms recap',
    detail:
      'AI-generated 1-2 sentence recap of recent communications in the recipient context panel (recap_recent_comms callable).',
  },
  {
    key: KEY_INBOX_WAITING_SECTIONS,
    label: 'Inbox: waiting/answered sections',
    detail:
      'ON (the default): message threads sit under "Waiting on a reply" and "Answered", each still grouped by day. OFF: one flat list grouped by day, the arrangement before this. Both are finished; pick either. Open the Inbox to see the change, no reload needed.',
  },
];

/**
 * Admin Feature Flags. Reads current values via getFeatureFlags, writes each
 * toggle through the admin-gated setFeatureFlags callable. Writes are optimistic
 * and revert on failure with a fail-loud banner (never a silent no-op). Changes
 * apply on the next app load (flags are fetched at startup).
 */
export function FeatureFlags() {
  const [flags, setFlags] = useState<Async<Flags>>({ status: 'loading' });
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Hoisted so the error state can hand AsyncRegion a real retry (S1): a failed
  // load offers "Retry", not a dead end that forces a full page reload.
  const load = useCallback(() => {
    let live = true;
    setFlags({ status: 'loading' });
    getFeatureFlags()
      .then((data) => live && setFlags({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setFlags({
            status: 'error',
            message: err instanceof Error ? err.message : 'Load failed',
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  async function toggle(key: string, next: boolean) {
    if (flags.status !== 'ready' || savingKey) return;
    const prev = flags.data;
    setFlags({ status: 'ready', data: { ...prev, [key]: next } }); // optimistic
    setSavingKey(key);
    setWriteError(null);
    try {
      await setFeatureFlags({ [key]: next });
    } catch (err) {
      setFlags({ status: 'ready', data: prev }); // revert
      setWriteError(err instanceof Error ? err.message : 'Saving the flag failed.');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Feature"
        accentTail="flags."
        subtitle="Toggle the central auntieos.* flags. Writes business_settings/feature_flags; takes effect on the next app load."
      />

      {writeError ? (
        <Banner tone="error" title="Feature-flag call failed">
          {writeError}
        </Banner>
      ) : null}

      <DenPanel
        title="Central flags"
        subtitle="Every flag here is a finished feature. Flipping it on switches it on, nothing left to build."
      >
        <AsyncRegion
          state={flags}
          what="feature flags"
          isEmpty={() => FLAGS.length === 0}
          loading={<LoadingRow label="Loading flags…" className="flags__hint" />}
          empty={<p className="flags__hint">No togglable flags.</p>}
        >
          {(data) => (
            <ul className="flags">
              {FLAGS.map((meta) => (
                <li key={meta.key} className="flags__row">
                  <div className="flags__meta">
                    <span className="flags__label">{meta.label}</span>
                    <code className="flags__key">{meta.key}</code>
                    <span className="flags__detail">{meta.detail}</span>
                  </div>
                  {savingKey === meta.key ? (
                    <span className="flags__saving" role="status">
                      <span className="flags__spinner" aria-hidden="true" />
                      Saving…
                    </span>
                  ) : null}
                  <Toggle
                    label={`Toggle ${meta.label}`}
                    checked={data[meta.key] ?? false}
                    disabled={savingKey !== null}
                    onChange={(next) => void toggle(meta.key, next)}
                  />
                </li>
              ))}
            </ul>
          )}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}
