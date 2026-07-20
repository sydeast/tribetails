import { useEffect, useState } from 'react';
import { currentPushPermission, isPushSupported, registerForPush } from '../lib/push';

/**
 * "Enable notifications" banner, same card shape as AddToHomeScreen (see
 * .push-prompt in styles/auth.css). Hidden when: push isn't supported in this
 * browser, permission is already 'granted' or 'denied' (never re-prompt a
 * denial), or the kinfolk dismissed it this session. Registration only ever
 * happens from this explicit tap — never on app boot — so the native
 * permission prompt can't ambush anyone on first paint.
 */

const DISMISS_KEY = 'mytribe.push.dismissed';

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
    setError(outcome.status === 'error' ? outcome.message : 'Could not enable notifications on this device.');
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
        {busy ? 'Enabling…' : 'Enable notifications'}
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
