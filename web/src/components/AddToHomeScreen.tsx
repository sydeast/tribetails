import { useEffect, useState } from 'react';

/**
 * "Add to Home Screen" helper. Grandma-friendly: big text, two numbered
 * steps for iOS Safari (no install prompt exists there), a single Install
 * button on Android/desktop Chrome via beforeinstallprompt. Hidden when the
 * app is already installed (standalone display mode) or after dismissal.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'mytribe.a2hs.dismissed';

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  const classicIos = /iPhone|iPad|iPod/.test(ua);
  // iPadOS 13+ reports as Mac; the touch check tells them apart.
  const iPadOs = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
  return classicIos || iPadOs;
}

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
