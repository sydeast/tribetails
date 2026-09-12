import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../lib/installState';

/**
 * "Add to Home Screen" helper. Grandma-friendly: big text, two numbered
 * steps for iOS Safari (no install prompt exists there), a single Install
 * button on Android/desktop Chrome via beforeinstallprompt. Hidden when the
 * app is already installed (standalone display mode) or after dismissal.
 *
 * On iOS the steps carry two extra sentences, because on that platform adding
 * the app is not a convenience. Safari will not deliver a notification to a
 * tab at all, and WebKit wipes a tab-only site's storage (cache, service
 * worker and all) after seven days without a visit, which for a household that
 * books monthly is every time. lib/installState.ts has the whole note.
 *
 * The ordering against the notifications banner is owned by
 * InstallAndAlerts.tsx, not by this component.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'mytribe.a2hs.dismissed';

export function AddToHomeScreen() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    function onPrompt(e: Event) {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || dismissed) return null;

  const ios = isIos();
  // Android/desktop: only show once Chrome offers the prompt. iOS: always show the steps.
  if (!ios && !installEvent) return null;

  function dismiss() {
    // Worth knowing rather than engineering around: on iOS this flag is itself
    // script-writable storage, so the seven-day wipe takes it too and the coach
    // comes back on its own for a household that never installs. That is the
    // right outcome here, so nothing tries to make the dismissal outlive it.
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallEvent(null);
  }

  return (
    <section className="glass a2hs d2">
      <div className="hd">
        <div className="ico">{'\u{1F4F1}'}</div>
        <div>
          <b>Keep MyTribe on your home screen</b>
          <p>One tap to check on your pets, just like any app.</p>
        </div>
      </div>

      {ios ? (
        <>
          <div className="steps">
            <div className="step">
              <div className="num">1</div>
              <p>
                Tap the <b>Share</b> button <span className="glyph">{'\u{2B06}\u{FE0F}'}</span> at the
                bottom of Safari.
              </p>
            </div>
            <div className="step">
              <div className="num">2</div>
              <p>
                Scroll down and tap <b>Add to Home Screen</b> <span className="glyph">{'\u{2795}'}</span>,
                then tap <b>Add</b>.
              </p>
            </div>
          </div>
          <p className="note">
            Adding it is what turns notifications on. An iPhone will not send you a visit update
            from a Safari tab, only from the app on your home screen.
          </p>
          <p className="note">
            It will ask you to sign in once more the first time you open it. That is normal. The
            home screen app keeps its own sign in, separate from Safari.
          </p>
        </>
      ) : (
        <button className="btn grad block" onClick={() => void install()}>
          Install MyTribe
        </button>
      )}

      <div className="dismissrow">
        <button className="skiplink" onClick={dismiss}>
          Maybe later
        </button>
      </div>
    </section>
  );
}
