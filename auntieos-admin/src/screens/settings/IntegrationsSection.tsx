import { useCallback, useEffect, useState } from 'react';
import {
  getIntegrationsHealth,
  STATUS_LABEL,
  STATUS_TONE,
  type IntegrationHealth,
  type IntegrationSecret,
  type IntegrationsHealthResult,
} from '../../api/integrations';
import { type Async } from '../../lib/async';
import { AsyncRegion } from '../../components/AsyncRegion';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { GhostButton } from '../../components/Buttons';
import './IntegrationsSection.css';

/**
 * Settings > Integrations: whether the outside services this business runs on
 * are actually working.
 *
 * EVERY WORD OF THE VERDICT COMES FROM THE SERVER. A browser cannot see a Cloud
 * Functions secret, so a status decided here would be a guess dressed as a fact.
 * The status, the one-line summary and the remediation all arrive decided by
 * `getIntegrationsHealth`, and android renders the same answer, so the two
 * surfaces cannot tell an operator different things about the same key.
 *
 * THE REMEDIATION IS PRINTED VERBATIM, in a selectable monospace block, because
 * it is a command to paste. Summarising it as "check your Stripe settings" would
 * delete the only text on the page that says what to do next.
 *
 * A FAILED READ IS NEVER GREEN. `AsyncRegion` owns that: an error renders the
 * error and nothing else, so a page that could not load its answer cannot show a
 * row of reassuring pills. The partial case has its own banner: when the server
 * could not work out which secrets are declared anywhere, every "declared" fact
 * is withdrawn rather than shown as false, because "nothing declares it" and "we
 * could not find out" send an operator to different places.
 *
 * NOTHING HERE CONNECTS ANYTHING. Setting a secret is a CLI action and Stripe
 * Connect onboarding is a credential this repo does not hold, so those are named
 * as steps rather than staged behind a button that could not work. The one
 * exception is Google Calendar, whose OAuth flow already exists: that row links
 * to the section that owns it instead of growing a second copy of it.
 */

interface Props {
  /**
   * Switches the Settings shell to another section. Supplied by `Settings.tsx`
   * so the Google Calendar row's link really moves the operator; without it the
   * row states where to go rather than offering a button that does nothing.
   */
  onOpenSection?: (id: string) => void;
}

/** Local time, or an honest note when the stamp will not parse. */
function checkedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Checked just now, at an unreadable time.';
  return `Checked ${d.toLocaleString()}.`;
}

export function IntegrationsSection({ onOpenSection }: Props) {
  const [state, setState] = useState<Async<IntegrationsHealthResult>>({ status: 'loading' });

  // Hoisted so a failed load can hand AsyncRegion a real Retry, the
  // FeatureFlags.tsx / Settings.tsx convention.
  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    getIntegrationsHealth()
      .then((data) => live && setState({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'The check did not come back.',
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <DenPanel
      title="Integrations"
      subtitle="The outside services this business runs on, checked on the server. Nothing here is guessed from your browser."
    >
      <AsyncRegion
        state={state}
        what="integrations"
        isEmpty={(data) => data.integrations.length === 0}
        loading={<p className="settingsEdit__hint">Checking integrations&hellip;</p>}
        empty={<p className="settingsEdit__hint">The server reported no integrations to check.</p>}
      >
        {(data) => (
          <>
            {!data.declaredKnown ? (
              <Banner
                tone="warning"
                title="Part of this check could not run"
                className="settingsEdit__sectionBanner"
              >
                The server could not read which secrets the deployed functions declare, so the
                &ldquo;declared&rdquo; line is left off every row below. Everything else on this page still
                stands. {data.declaredError}
              </Banner>
            ) : null}

            <div className="integrations__meta">
              <span className="integrations__checked">{checkedLabel(data.checkedAt)}</span>
              <GhostButton label="Check again" onClick={load} />
            </div>

            <ul className="integrations__list">
              {data.integrations.map((integration) => (
                <IntegrationRow
                  key={integration.key}
                  integration={integration}
                  declaredKnown={data.declaredKnown}
                  {...(onOpenSection ? { onOpenSection } : {})}
                />
              ))}
            </ul>
          </>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}

interface RowProps {
  integration: IntegrationHealth;
  declaredKnown: boolean;
  onOpenSection?: (id: string) => void;
}

function IntegrationRow({ integration, declaredKnown, onOpenSection }: RowProps) {
  const tone = STATUS_TONE[integration.status];
  return (
    <li className="integrations__row" data-status={integration.status}>
      <div className="integrations__head">
        <div className="integrations__naming">
          <h4 className="integrations__name">{integration.name}</h4>
          <p className="integrations__purpose">{integration.purpose}</p>
        </div>
        {/* The pill carries its own words as well as its colour. Colour alone is
            not a status: this panel is read by whoever is on call, on whatever
            screen they have, and half of them will not see the tint. */}
        <span className="integrations__pill" data-tone={tone}>
          {STATUS_LABEL[integration.status]}
        </span>
      </div>

      <p className="integrations__summary">{integration.summary}</p>

      <ul className="integrations__secrets">
        {integration.secrets.map((secret) => (
          <SecretLine key={secret.name} secret={secret} declaredKnown={declaredKnown} />
        ))}
      </ul>

      {integration.remediation !== '' ? (
        <div className="integrations__remediation">
          <span className="integrations__remediationLabel">What to do</span>
          {/* Verbatim, selectable, and pre-wrapped: it is a command to paste. */}
          <pre className="integrations__command">{integration.remediation}</pre>
        </div>
      ) : null}

      {integration.externalStep !== '' ? (
        <p className="integrations__external">{integration.externalStep}</p>
      ) : null}

      {integration.ownedBySection !== '' ? (
        <div className="integrations__handoff">
          {onOpenSection ? (
            <GhostButton
              label="Open Google Calendar settings"
              onClick={() => onOpenSection(integration.ownedBySection)}
            />
          ) : (
            <p className="settingsEdit__hint">
              Connecting and disconnecting live in the Google Calendar section of these settings.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * One credential line. Never a value: the server sends booleans and a character
 * count, and the count is here because a half-pasted key resolves exactly like a
 * good one and fails every call.
 */
function SecretLine({ secret, declaredKnown }: { secret: IntegrationSecret; declaredKnown: boolean }) {
  return (
    <li className="integrations__secret">
      <code className="integrations__secretName">{secret.name}</code>
      <span className="integrations__secretState" data-set={secret.resolves ? 'yes' : 'no'}>
        {secret.resolves ? `set, ${String(secret.length)} characters` : 'not set'}
      </span>
      {/* Withdrawn entirely when the server could not look, rather than shown as
          a false. "Nothing declares it" is a bug to fix; "we could not find out"
          is not, and they must not read alike. */}
      {declaredKnown && !secret.declared ? (
        <span className="integrations__secretWarn">no deployed function declares this</span>
      ) : null}
      {!secret.required ? <span className="integrations__secretOptional">optional</span> : null}
      <span className="integrations__secretPurpose">{secret.purpose}</span>
    </li>
  );
}
