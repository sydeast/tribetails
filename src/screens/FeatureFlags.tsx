import { useEffect, useState } from 'react';
import { getFeatureFlags, setFeatureFlags, type FeatureFlags as Flags } from '../api/featureFlags';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Toggle } from '../components/Toggle';

/** One togglable flag: stable dotted key + operator label + what it gates. */
interface FlagMeta {
  key: string;
  label: string;
  detail: string;
}

/**
 * The genuinely-gated `auntieos.*` flags only. Built features that ship ON have
 * no row (they are not experimental) — mirrors the wasm FeatureFlagsScreen's
 * curated FLAGS list. Keep in sync with the config's non-ALWAYS_ON keys.
 */
const FLAGS: readonly FlagMeta[] = [
  {
    key: 'auntieos.settings.integrationManage',
    label: 'Settings: integration manage',
    detail: 'Manage / Connect on integration cards (needs OAuth/connect).',
  },
  {
    key: 'auntieos.communicate.commsRecap',
    label: 'Communicate: comms recap',
    detail:
      'AI-generated 1-2 sentence recap of recent communications in the recipient context panel (recap_recent_comms callable).',
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

  useEffect(() => {
    let live = true;
    getFeatureFlags()
      .then((data) => live && setFlags({ status: 'ready', data }))
      .catch((err: unknown) =>
        live && setFlags({ status: 'error', message: err instanceof Error ? err.message : 'Load failed' }),
      );
    return () => {
      live = false;
    };
  }, []);

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
    <main className="screen">
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
        subtitle="Each flag ships dark by default. Some also need backing code/backend before they do anything."
      >
        <AsyncRegion
          state={flags}
          what="feature flags"
          isEmpty={() => FLAGS.length === 0}
          loading={<p className="flags__hint">Loading flags…</p>}
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
    </main>
  );
}
