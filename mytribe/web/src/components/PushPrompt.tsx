import { useEffect, useState } from 'react';
import { currentPushPermission, isPushSupported, registerForPush } from '../lib/push';
import { reportTaggedError } from '../lib/sentry';
import { BusyLabel } from '../components/Loading';

/**
 * "Enable notifications" banner, same card shape as AddToHomeScreen (see
 * .push-prompt in styles/auth.css). Hidden when: push isn't supported in this
 * browser, permission is already 'granted' or 'denied' (never re-prompt a
 * denial), or the kinfolk dismissed it this session. Registration only ever
 * happens from this explicit tap — never on app boot — so the native
 * permission prompt can't ambush anyone on first paint.
 */

const DISMISS_KEY = 'mytribe.push.dismissed';

/** Console and Sentry identity of the no-service-worker outcome (#1550). */
const NO_SERVICE_WORKER = {
  code: 'no-service-worker',
  stage: 'service-worker',
  message: 'No service worker registration.',
} as const;

export function PushPrompt() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => currentPushPermission());
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void isPushSupported().then(setSupported);
  }, []);

  if (supported === null || !supported || permission !== 'default' || dismissed) return null;

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  async function enable() {
    setBusy(true);
    setError(null);
    const outcome = await registerForPush();
    setBusy(false);
    if (outcome.status === 'registered') {
      setPermission('granted');
      return;
    }
    if (outcome.status === 'denied') {
      setPermission('denied');
      return;
    }
    if (outcome.status === 'unsupported') {
      setSupported(false);
      return;
    }
    if (outcome.status === 'error') {
      // #1547: the banner clears on the next render and the walk capture was
      // empty, so the code, the stage and the browser state go to the console
      // and to Sentry (when a DSN is set) as well as on screen. No token, no
      // key material: states only.
      const { code, stage, message, error: cause, diagnostics } = outcome;
      console.error('[push] enable failed', { code, stage, message, ...diagnostics });
      reportTaggedError(cause, { code, stage });
      setError(`Could not enable notifications: ${message} (${code})`);
      return;
    }
    // #1550: nothing threw, but there is no app-shell worker to hand FCM, so
    // this used to be the one failure that left no trace anywhere. Same console
    // shape and the same Sentry tags as the error branch, with a constructed
    // Error since there is no thrown value. The banner has to be true in a
    // Chrome tab as well as on an iPhone: in a tab the worker simply has not
    // registered yet (a reload fixes it); on iOS Safari only a home-screen app
    // ever gets a worker FCM can use (AddToHomeScreen.tsx says the same).
    const { code, stage, message } = NO_SERVICE_WORKER;
    console.error('[push] enable failed', { code, stage, message, ...outcome.diagnostics });
    reportTaggedError(new Error(message), { code, stage });
    setError(
      "Could not enable notifications: the app's background worker could not be installed on this device. Reload the page and try again; on an iPhone, add MyTribe to the home screen first.",
    );
  }

  return (
    <section className="glass push-prompt d2">
      <div className="hd">
        <div className="ico">{'\u{1F514}'}</div>
        <div>
          <b>Get notified about visits</b>
          <p>Know the moment your Auntie checks in, sends a KinTale, or replies to a message.</p>
        </div>
      </div>

      <button className="btn grad block" onClick={() => void enable()} disabled={busy}>
        {busy ? <BusyLabel>Enabling…</BusyLabel> : 'Enable notifications'}
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
