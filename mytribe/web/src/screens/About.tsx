import { Link } from '@tanstack/react-router';
import { PortalNav } from '../components/PortalNav';
import { PhoneActions } from '../components/PhoneActions';
import { PUBLIC_HOURS_DAYS, useBusinessPublicCard } from '../lib/businessPublicCard';
import { businessLabel } from '../lib/businessLabel';
import { hoursLabel } from '../lib/businessHours';
import { formatPhone } from '../lib/phone';
import { APP_VERSION } from '../lib/appVersion';
import { getActiveKinfolkId } from '../lib/activeTribe';
import '../styles/about.css';

/**
 * "About {business}" (#1411, the 2026-11-01 ruling on #1399): where a household
 * finds the business name, its weekly hours, the public number with Call and
 * Text, the privacy policy and the app version. Reached from the avatar menu;
 * Android's AboutScreen.kt is the twin.
 *
 * Everything on it comes from `business_public/card`, the same read the
 * sign-in screen makes (#1321): cached copy first, live copy when it arrives,
 * no callable and no tribe. That is what lets `/about` sit behind
 * `requireSignedIn` alone and open before a tribe is picked, and what keeps it
 * readable offline from the last card this browser saw.
 *
 * No value here is ever invented. A blank name titles the page "About your
 * Auntie" (`businessLabel`); a blank number, URL or version leaves that part
 * out; a closed day reads "Closed".
 */
export function About() {
  const card = useBusinessPublicCard();
  // PortalNav reads `getMyHome(kinfolkId)`, which the server resolves to the
  // caller's first household when the id is null. Before a tribe is picked
  // that would be a real read of a household nobody chose, so the chrome is
  // the bare wordmark instead.
  const hasTribe = getActiveKinfolkId() !== null;
  const showMyTribe = card.privacyPolicyUrl !== '' || APP_VERSION !== '';
  return (
    <>
      {hasTribe ? <PortalNav active={null} /> : <PreTribeNav />}

      <div className="wrap">
        <header className="hero-greet">
          <h1>
            About <span>{businessLabel(card.name)}</span>
          </h1>
        </header>

        <div className="stack">
          <section className="glass card d1">
            <h3 className="title">Hours</h3>
            <dl className="about-rows" data-testid="about-hours">
              {PUBLIC_HOURS_DAYS.map((day) => (
                <div className="about-row" key={day}>
                  <dt>{day}</dt>
                  <dd>{hoursLabel(card.hours[day])}</dd>
                </div>
              ))}
            </dl>
          </section>

          {card.phone !== '' && (
            <section className="glass card d2">
              <h3 className="title">Phone</h3>
              <p className="about-phone mono">{formatPhone(card.phone)}</p>
              <div className="about-actions">
                <PhoneActions phone={card.phone} />
              </div>
            </section>
          )}

          {showMyTribe && (
            <section className="glass card d3">
              <h3 className="title">MyTribe</h3>
              <dl className="about-rows">
                {card.privacyPolicyUrl !== '' && (
                  <div className="about-row">
                    <dt>
                      <a href={card.privacyPolicyUrl} target="_blank" rel="noopener noreferrer">
                        Privacy policy
                      </a>
                    </dt>
                    <dd />
                  </div>
                )}
                {APP_VERSION !== '' && (
                  <div className="about-row">
                    <dt>Version</dt>
                    <dd className="mono">{APP_VERSION}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** The wordmark alone, for a visit before any tribe is picked: no household read behind it. */
function PreTribeNav() {
  return (
    <nav className="nav">
      <div className="in">
        <div className="wordmark">
          My<span className="grad">Tribe</span>
        </div>
        <div className="right">
          <Link className="btn ghost about-back" to="/">
            Back
          </Link>
        </div>
      </div>
    </nav>
  );
}
