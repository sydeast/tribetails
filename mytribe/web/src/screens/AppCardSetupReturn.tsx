/**
 * #2427: WHERE STRIPE SENDS A HOUSEHOLD WHO SAVED A CARD FROM THE MYTRIBE APP,
 * when the browser keeps the page.
 *
 * The app hands "Add a card" to the phone's browser. Stripe used to send that
 * browser back to this site's own Account page, which needs a web sign-in a
 * household who lives in the app has usually never done in that browser. So
 * the first thing they saw after saving a card was the sign-in screen, with
 * nothing about the card and nothing pointing back to the app.
 *
 * The app now sends `/app/account` and claims that address, so the phone
 * normally opens the app on Account Settings and this page is never drawn. It
 * is drawn when the browser does not hand the address over, and on a computer,
 * where the MyTribe app for desktop sends the same address.
 *
 * NO SIGN-IN AND NO READS, ON PURPOSE. This page knows only what the address
 * says: whether Stripe finished the card step. It never says a card is on
 * file, because the address cannot know that. The app reads the card itself.
 *
 * The button is shown on Android only, the one place a `mytribe://` link has
 * anything to open, the same rule as `AppCheckoutReturn`.
 */
export const CARD_SETUP_RETURN_PARAM = 'billing';
export const CARD_SETUP_RETURN_VALUE = 'saved';

/** True when Stripe's success address opened this page. Exactly `billing=saved`. */
function cardStepFinished(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(CARD_SETUP_RETURN_PARAM) === CARD_SETUP_RETURN_VALUE;
}

/** The app's own link to Account Settings, keeping what Stripe said. */
export function appAccountLink(saved: boolean): string {
  return saved ? `mytribe://account?${CARD_SETUP_RETURN_PARAM}=${CARD_SETUP_RETURN_VALUE}` : 'mytribe://account';
}

/**
 * The Account page on this site, for a household who would sooner look here.
 * It keeps the marker, so that page reads the card from Stripe as it does for
 * a card saved on the web. It needs a web sign-in, which is why it is the
 * second choice on a phone.
 */
export function webAccountHref(saved: boolean): string {
  return saved ? `/account?${CARD_SETUP_RETURN_PARAM}=${CARD_SETUP_RETURN_VALUE}` : '/account';
}

export function AppCardSetupReturn() {
  const saved = cardStepFinished();
  const onAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  return (
    <>
      <nav className="nav" aria-label="MyTribe">
        <div className="in">
          <div className="wordmark">
            My<span className="grad">Tribe</span>
          </div>
        </div>
      </nav>
      <div className="wrap">
        <main className="glass card" data-testid="app-card-setup-return" style={{ marginTop: 40, textAlign: 'center' }}>
          <div className="sectlabel">Card on file</div>
          <h1>{saved ? 'Your card step is done.' : 'Card setup was closed.'}</h1>
          <p className="sub" style={{ margin: '12px auto 20px', maxWidth: '44ch' }}>
            {saved
              ? 'Go back to MyTribe to see the card on file.'
              : 'No card was added. Go back to MyTribe to try again.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {onAndroid && (
              <a className="btn grad" href={appAccountLink(saved)}>
                Open MyTribe
              </a>
            )}
            <a className="btn ghost" href={webAccountHref(saved)}>
              See Account Settings here
            </a>
          </div>
        </main>
      </div>
    </>
  );
}
