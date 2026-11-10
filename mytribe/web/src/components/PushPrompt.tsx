import { useEffect, useState } from 'react';
import {
  currentPushPermission,
  isPushSupported,
  refreshPushRegistration,
  registerForPush,
  settledPushRegistration,
  type PushRegistrationOutcome,
} from '../lib/push';
import { reportTaggedError } from '../lib/sentry';
import { isIos, isStandalone } from '../lib/installState';
import { BusyLabel } from '../components/Loading';
import { IPHONE_PUSH_NOTE } from './AddToHomeScreen';

/**
 * Notifications card for the portal home, same card shape as AddToHomeScreen
 * (see .push-prompt in styles/auth.css). Four states by browser permission:
 *
 * - 'default': "Enable notifications". The native prompt only ever opens from
 *   that tap, never on app boot.
 * - 'granted': registers silently on sign-in (no prompt is possible, the
 *   browser already said yes). Registered: no card. Failed: the card comes
 *   back as "Finish turning on notifications" with the coded error and a
 *   Retry (#1787; before, the card vanished and a failed token step could
 *   never be retried).
 * - 'denied': a short note on allowing notifications for this site in Chrome.
 * - not supported: nothing.
 *
 * "Maybe later" and the note's close button hide the card for this session.
 *
 * #1808: Notification Settings passes `showDeviceStatus`, and there the card
 * never goes blank. Where Home shows nothing it shows this device's state
 * instead: "Signing up this device…" while the sign-up runs, "Notifications
 * are on for this device." once registerFcmToken has succeeded (that success
 * is the proof the server has the token; nothing else is asked), and "This
 * browser can't get notifications." when push is not supported, with the
 * home-screen step on an iPhone tab. The settings screen is where someone goes
 * to check, so "nothing" there could mean signed up, still signing up,
 * unsupported or a bug, and nobody could tell which.
 */
const DISMISS_KEY = 'mytribe.push.dismissed';

/** Console and Sentry identity of the no-service-worker outcome (#1550). */
const NO_SERVICE_WORKER = {
  code: 'no-service-worker',
  stage: 'service-worker',
  message: 'No service worker registration.',
} as const;

/** Outcomes already sent to the console and Sentry, so a remount does not report the same failure twice. */
const reported = new WeakSet<object>();
/** The line shown under the button for a failed outcome; logs and reports it once. */
function failureLine(outcome: PushRegistrationOutcome): string | null {
  if (outcome.status === 'error') {
    // #1547: the banner clears on the next render and the walk capture was
    // empty, so the code, the stage and the browser state go to the console
    // and to Sentry (when a DSN is set) as well as on screen. No token, no
    // key material: states only.
    const { code, stage, message, error: cause, diagnostics } = outcome;
    if (!reported.has(outcome)) {
      reported.add(outcome);
      console.error('[push] enable failed', { code, stage, message, ...diagnostics });
      reportTaggedError(cause, { code, stage });
    }
    return `Could not enable notifications: ${message} (${code})`;
  }
  if (outcome.status === 'no-service-worker') {
    // #1550: nothing threw, but there is no app-shell worker to hand FCM, so
    // this used to be the one failure that left no trace anywhere. Same console
    // shape and the same Sentry tags as the error branch, with a constructed
    // Error since there is no thrown value. The banner has to be true in a
    // Chrome tab as well as on an iPhone: in a tab the worker simply has not
    // registered yet (a reload fixes it); on iOS Safari only a home-screen app
    // ever gets a worker FCM can use (AddToHomeScreen.tsx says the same).
    const { code, stage, message } = NO_SERVICE_WORKER;
    if (!reported.has(outcome)) {
      reported.add(outcome);
      console.error('[push] enable failed', { code, stage, message, ...outcome.diagnostics });
      reportTaggedError(new Error(message), { code, stage });
    }
    return "Could not enable notifications: the app's background worker could not be installed on this device. Reload the page and try again; on an iPhone, add MyTribe to the home screen first.";
  }
  return null;
}
/** The sign-up answered with a failure the Finish card can retry. */
function isFailure(status: PushRegistrationOutcome['status'] | null): boolean {
  return status === 'error' || status === 'no-service-worker';
}
/** The answer this sign-in already has, so a later mount draws it at once (#1808). */
function settledForGranted(): PushRegistrationOutcome | null {
  return currentPushPermission() === 'granted' ? settledPushRegistration() : null;
}
export function PushPrompt({
  ignoreDismissal = false,
  showDeviceStatus = false,
}: {
  ignoreDismissal?: boolean;
  /** Notification Settings: draw this device's state where Home would draw nothing (#1808). */
  showDeviceStatus?: boolean;
} = {}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => currentPushPermission());
  const [dismissed, setDismissed] = useState(() => !ignoreDismissal && sessionStorage.getItem(DISMISS_KEY) === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const settled = settledForGranted();
    return settled ? failureLine(settled) : null;
  });
  // Granted devices only: what the silent registration (or the last Retry)
  // answered. Null while it is still running.
  const [silentStatus, setSilentStatus] = useState<PushRegistrationOutcome['status'] | null>(
    () => settledForGranted()?.status ?? null,
  );
  useEffect(() => {
    void isPushSupported().then(setSupported);
  }, []);
  useEffect(() => {
    if (!supported || permission !== 'granted') return;
    let live = true;
    void refreshPushRegistration().then((outcome) => {
      if (!live) return;
      const line = failureLine(outcome);
      if (line) {
        setError(line);
      } else if (outcome.status === 'denied') {
        setPermission(currentPushPermission());
      } else if (outcome.status === 'unsupported') {
        setSupported(false);
      }
      setSilentStatus(outcome.status);
    });
    return () => {
      live = false;
    };
  }, [supported, permission]);
  if (supported === null || dismissed) return null;
  if (!supported || permission === 'unsupported') return showDeviceStatus ? <UnsupportedStatus /> : null;
  if (permission === 'granted' && !isFailure(silentStatus)) {
    if (!showDeviceStatus) return null;
    if (silentStatus === null) return <SigningUpStatus />;
    if (silentStatus === 'registered') return <OnStatus />;
    return null;
  }
  function dismiss() {
    // The settings screen is opened on purpose, so closing the card there hides it
    // for this visit only and leaves the home screen's choice alone.
    if (!ignoreDismissal) sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }
  async function enable() {
    setBusy(true);
    setError(null);
    const outcome = await registerForPush();
    setBusy(false);
    if (outcome.status === 'registered') {
      setPermission('granted');
      setSilentStatus('registered');
      return;
    }
    if (outcome.status === 'denied') {
      // Also the answer when the kinfolk closes the browser prompt without
      // choosing, which leaves permission at 'default': read it back rather
      // than calling a dismissed prompt a block.
      setPermission(currentPushPermission());
      return;
    }
    if (outcome.status === 'unsupported') {
      setSupported(false);
      return;
    }
    setError(failureLine(outcome));
  }
  if (permission === 'denied') {
    return (
      <section className="glass push-prompt push-denied d2">
        <div className="hd">
          <div className="ico">{'\u{1F515}'}</div>
          <div>
            <b>Notifications are blocked</b>
            <p>
              To get them, click the lock icon next to the address, open Site settings, and set Notifications to
              Allow. Then reload this page.
            </p>
          </div>
        </div>
        <div className="dismissrow">
          <button className="skiplink" onClick={dismiss}>
            Close
          </button>
        </div>
      </section>
    );
  }
  const finishing = permission === 'granted';
  return (
    <section className="glass push-prompt d2">
      <div className="hd">
        <div className="ico">{'\u{1F514}'}</div>
        <div>
          {finishing ? (
            <b>Finish turning on notifications</b>
          ) : (
            <>
              <b>Get notified about visits</b>
              <p>Know the moment your Auntie checks in, sends a KinTale, or replies to a message.</p>
            </>
          )}
        </div>
      </div>

      <button className="btn grad block" onClick={() => void enable()} disabled={busy}>
        {busy ? <BusyLabel>{finishing ? 'Retrying…' : 'Enabling…'}</BusyLabel> : finishing ? 'Retry' : 'Enable notifications'}
      </button>
      {error && <p className="err">{error}</p>}

      <div className="dismissrow">
        <button className="skiplink" onClick={dismiss}>
          Maybe later
        </button>
      </div>
    </section>
  );
}
/** #1808: the settings card once registerFcmToken has succeeded for this device. */
function OnStatus() {
  return (
    <section className="glass push-prompt push-on d2" role="status">
      <div className="hd">
        <div className="ico">{'\u{1F514}'}</div>
        <div>
          <b>Notifications are on for this device.</b>
        </div>
      </div>
    </section>
  );
}
/** #1808: the settings card while the sign-in's silent registration is still running. */
function SigningUpStatus() {
  return (
    <section className="glass push-prompt push-signing d2" role="status" aria-live="polite" aria-busy="true">
      <div className="hd">
        <div className="ico">{'\u{1F514}'}</div>
        <div>
          <b>
            <span className="loading-spinner loading-spinner--inline" aria-hidden="true" />
            Signing up this device…
          </b>
        </div>
      </div>
    </section>
  );
}
/**
 * #1808: the settings card when this browser cannot take web push at all. On
 * an iPhone tab that is the normal state, and the home-screen app is the fix,
 * so it says so in AddToHomeScreen's words.
 */
function UnsupportedStatus() {
  const iphoneTab = isIos() && !isStandalone();
  return (
    <section className="glass push-prompt push-unsupported d2" role="status">
      <div className="hd">
        <div className="ico">{'\u{1F515}'}</div>
        <div>
          <b>{"This browser can't get notifications."}</b>
          {iphoneTab && (
            <>
              <p>
                Add MyTribe to your home screen first. Tap the <strong>Share</strong> button at the bottom of Safari,
                then <strong>Add to Home Screen</strong>.
              </p>
              <p>{IPHONE_PUSH_NOTE}</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
