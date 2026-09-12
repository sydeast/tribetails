import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../lib/installState';
import { Banner } from './Banner';
import { PrimaryButton } from './Buttons';
import './InstallPrompt.css';

/**
 * Offers to put the admin on the operator's home screen.
 *
 * WHY, in one line: mobile web is the FIELD FALLBACK (operator ruling
 * 2026-09-12), and an installed admin is the only version of it that opens with
 * no signal. On iOS that is not a preference but the whole mechanism, because
 * WebKit wipes a tab-only site's service worker after seven days; lib/
 * installState.ts has the note.
 *
 * IT IS A Banner, not a new card. The shell already has one way of saying
 * something standing and advisory, with a tone swatch, a glyph tile and a close
 * button, and it sits in this exact position under the sandbox notice. A second
 * shape would be a second visual language for the same job.
 *
 * `suggestion` rather than `info` or `warning`: nothing is wrong, and the Den
 * convention reserves that tone for an offer the operator can take or leave.
 * `dashed`, for the same reason every advisory surface in this app is dashed.
 *
 * WHEN IT SHOWS. Never once installed, never after it is dismissed, and on
 * anything other than iOS never until the browser has actually offered an
 * install through `beforeinstallprompt`. An "Install" button that the browser
 * has not authorised does nothing when pressed, which is worse than no button.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'auntieos.install.dismissed';

export function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    function onPrompt(e: Event) {
      // Chrome shows its own mini-infobar unless the event is cancelled. Taking
      // it here is what moves the offer into the app, where it can say why.
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
  if (!ios && installEvent === null) return null;

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  async function install() {
    if (installEvent === null) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    // Spent either way: the event cannot be prompted twice.
    setInstallEvent(null);
  }

  return (
    <Banner
      tone="suggestion"
      dashed
      title="Keep AuntieOS on your home screen"
      icon="📲"
      onDismiss={dismiss}
      className="install-prompt"
      {...(ios ? {} : { trailing: <PrimaryButton label="Install AuntieOS" onClick={() => void install()} /> })}
    >
      <p>
        Installed, it opens from the home screen and keeps working when the signal does not, which
        is the point of having the admin on a phone at all.
      </p>
      {ios ? (
        <>
          <ol className="install-prompt__steps">
            <li>
              Tap the <b>Share</b> button at the bottom of Safari.
            </li>
            <li>
              Scroll down, tap <b>Add to Home Screen</b>, then tap <b>Add</b>.
            </li>
          </ol>
          <p>
            It will ask you to sign in once more the first time you open it. The home screen app
            keeps its own sign in, separate from Safari.
          </p>
        </>
      ) : null}
    </Banner>
  );
}
