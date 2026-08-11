/**
 * Every external service this system depends on, what it needs to work, and the
 * exact thing an operator does when it does not.
 *
 * ONE CATALOG, TWO CLIENTS. The React admin and android both render
 * `getIntegrationsHealth`, so a fact stated here is stated once. Before this
 * existed, android decided integration health on the device from a hard-coded
 * list (it still showed "n8n Webhooks: CONFIGURED" more than a year after n8n
 * was retired) and the React admin had no integrations surface at all. Two
 * clients guessing separately is how they end up disagreeing about whether the
 * business can send an invoice.
 *
 * THE THREE QUESTIONS ARE ASKED SEPARATELY BECAUSE THEY FAIL SEPARATELY.
 *
 *   1. DECLARED: some deployed function binds this name. Read from the built
 *      endpoints (`lib/declaredSecrets.ts`). A name nothing declares is a name
 *      the operator can set all day with no effect.
 *   2. RESOLVES: the name arrived in THIS function's environment. The callable
 *      binds every secret below, so an absent one is genuinely unset (or set and
 *      never redeployed), not merely unbound here.
 *   3. LIVENESS: something was actually exercised. Only claimed where a check
 *      exists that costs nothing and calls nobody.
 *
 * NO VALUE, AND NO PREFIX OF ONE, EVER LEAVES THE SERVER. The response carries
 * booleans and a character count. A four-character prefix of a Stripe key names
 * the account mode; a four-character prefix of a Twilio SID names the account.
 * There is no length of secret worth printing, so none is printed.
 *
 * NOTHING HERE PINGS A PAID API TO SAY HELLO. A Mapbox geocode is billed per
 * request, a Stripe call is a live call against the payments account, and a
 * Twilio fetch is a call to a metered vendor. An integrations page that quietly
 * spends money every time it is opened is a worse bug than the one it reports,
 * so where no free check exists the row says so in as many words rather than
 * showing an unexplained blank.
 */

/** The Firebase project every remediation command names. */
export const FIREBASE_PROJECT_ID = 'auntieos-ttpc';

/**
 * What the operator's own situation is, per integration.
 *
 * `unknown` is not decoration. A check that threw and a check that came back
 * empty must never render the same, because the second invites an operator to
 * shrug and move on while the first means nobody knows. Nothing that could not
 * be verified is ever reported as working.
 */
export type IntegrationStatus = 'working' | 'configured' | 'missing' | 'unknown';

export interface CatalogSecret {
  name: string;
  /**
   * False for a secret the integration works without. An optional secret that
   * is unset lowers no status; it is reported anyway, so the operator can see
   * that the part of the feature needing it is switched off.
   */
  required: boolean;
  /** What this one secret is for, in the operator's words. */
  purpose: string;
}

export interface CatalogEntry {
  key: string;
  name: string;
  /** One line: what this service does for the business, not what it is. */
  purpose: string;
  secrets: CatalogSecret[];
  /**
   * A manual step outside the CLI that this repo cannot take for the operator
   * (a console page, a connect flow that is not built). Empty when there is
   * none. Shown whether or not the secrets are set, because a set secret with an
   * unfinished console step is a working-looking integration that does nothing.
   */
  externalStep: string;
  /**
   * The Settings section that owns this integration's own flow, so the UI links
   * to it instead of rebuilding it. Empty when this catalog row is the whole
   * surface.
   */
  ownedBySection: string;
}

/**
 * The seven services. Order is the order both clients render, chosen so the two
 * that take money and reach households (Stripe, Twilio) are read first.
 */
export const INTEGRATION_CATALOG: readonly CatalogEntry[] = [
  {
    key: 'stripe',
    name: 'Stripe',
    purpose: 'Card payments on kinfolk invoices, and the webhook that marks them paid.',
    secrets: [
      { name: 'STRIPE_SECRET_KEY', required: true, purpose: 'Creates the payment intent when a kinfolk pays an invoice.' },
      {
        name: 'STRIPE_WEBHOOK_SECRET',
        required: true,
        purpose: 'Verifies the paid/failed callback. Without it a real payment is never recorded.',
      },
    ],
    // The named external-secret stop. Stripe Connect onboarding is a separate
    // credential pair that no code in this repo holds, so it is named rather
    // than half-built behind a button that cannot work.
    externalStep:
      'Stripe Connect onboarding is not built here. It needs a Connect client ID and secret from ' +
      'dashboard.stripe.com/settings/connect, which no code in this repo holds. Card payments on ' +
      'invoices work without it; payouts to a connected account do not.',
    ownedBySection: '',
  },
  {
    key: 'twilio',
    name: 'Twilio',
    purpose:
      'SMS to kinfolk: visit notifications, broadcasts, and replies from the Inbox. Also the ' +
      'business phone line, which twilioVoice answers.',
    secrets: [
      { name: 'TWILIO_ACCOUNT_SID', required: true, purpose: 'Identifies the Twilio account messages are sent from.' },
      { name: 'TWILIO_AUTH_TOKEN', required: true, purpose: 'Signs sends, and verifies the delivery-status callback.' },
      { name: 'TWILIO_FROM_NUMBER', required: true, purpose: 'The number kinfolk see. A send with no from number fails.' },
      // The Voice SDK set. Not required for SMS, so an unset one must not read
      // as an outage, but every one is needed before the admin app can answer.
      {
        name: 'TWILIO_API_KEY_SID',
        required: false,
        purpose: 'Signs the admin app voice token. Revokable on its own, so voice can be cut off without rotating the account auth token.',
      },
      {
        name: 'TWILIO_API_KEY_SECRET',
        required: false,
        purpose: 'The other half of the voice signing key. Twilio shows it once at creation and never again.',
      },
      {
        name: 'TWIML_APP_SID',
        required: false,
        purpose: 'The TwiML Application whose Voice URL answers the admin app leg of a screened call.',
      },
      {
        name: 'PUSH_CREDENTIAL_SID',
        required: false,
        purpose: 'Lets Twilio wake the admin app for an incoming call. Without it, calling works only while the app is open.',
      },
    ],
    externalStep:
      'Delivery receipts need the twilioStatusCallback URL registered on the messaging service in ' +
      'console.twilio.com. Without it messages still send, and every one of them stays "sent" forever ' +
      'because nothing reports back that it arrived. The inbound VOICE line is separate: the ' +
      "number's \"A call comes in\" webhook must point at the twilioVoice function, and " +
      'TWILIO_VOICE_BASE_URL must name that exact URL, or every call is refused with a 403.',
    ownedBySection: '',
  },
  {
    key: 'smtp2go',
    name: 'SMTP2GO',
    purpose: 'Email to kinfolk: invites, invoices, password recovery, and broadcasts.',
    secrets: [
      { name: 'SMTP2GO_API_KEY', required: true, purpose: 'The restricted send key. Every email goes through it.' },
      { name: 'EMAIL_FROM', required: true, purpose: 'The verified sender address kinfolk see and reply to.' },
    ],
    externalStep:
      'Open and click tracking needs a webhook pointing at smtp2goEventWebhook, added under ' +
      'Sending > Webhooks at app.smtp2go.com. Email sends fine without it; the engagement counts on ' +
      'every send stay at zero.',
    ownedBySection: '',
  },
  {
    key: 'cloudinary',
    name: 'Cloudinary',
    purpose: 'Where every Kin photo, KinTale image and brand logo is stored and served from.',
    secrets: [
      { name: 'CLOUDINARY_CLOUD_NAME', required: true, purpose: 'The account uploads land in and images are served from.' },
      { name: 'CLOUDINARY_API_KEY', required: true, purpose: 'Names this app on a signed upload.' },
      { name: 'CLOUDINARY_API_SECRET', required: true, purpose: 'Signs the upload. Cloudinary refuses an unsigned one.' },
    ],
    externalStep: '',
    ownedBySection: '',
  },
  {
    key: 'mapbox',
    name: 'Mapbox',
    purpose: 'Address lookup when a household is added, and the route the day is planned on.',
    secrets: [
      { name: 'MAPBOX_ACCESS_TOKEN', required: true, purpose: 'Server-side token for address search. No client ever holds it.' },
    ],
    externalStep: '',
    ownedBySection: '',
  },
  {
    key: 'googleCalendar',
    name: 'Google Calendar',
    purpose: 'Writes visits onto the operator’s calendar, and reads busy time back off it.',
    secrets: [
      { name: 'GOOGLE_OAUTH_CLIENT_ID', required: true, purpose: 'Identifies this app on the Google consent screen.' },
      { name: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true, purpose: 'Exchanges the consent code for a token, and revokes it later.' },
    ],
    externalStep: '',
    // The connect flow already exists and is the only place the operator should
    // sign in. This row reports; that section acts. 'calendar' is the merged
    // Settings tab (#145 folded the old googleCalendar tab into it); the web
    // client also aliases the retired id, so older deploys stay routable.
    ownedBySection: 'calendar',
  },
  {
    key: 'sentry',
    name: 'Sentry',
    purpose: 'Where a server error goes so somebody finds out about it.',
    secrets: [
      { name: 'SENTRY_DSN', required: true, purpose: 'The project errors are reported to. Unset means errors are reported nowhere.' },
    ],
    externalStep: '',
    ownedBySection: '',
  },
];

/** Every secret name in the catalog, which is exactly what the callable binds. */
export const INTEGRATION_SECRET_NAMES: readonly string[] = INTEGRATION_CATALOG.flatMap((entry) =>
  entry.secrets.map((secret) => secret.name),
);

/**
 * The command that creates one secret, printed verbatim for the operator to
 * paste.
 *
 * `functions:secrets:set` PROMPTS for the value rather than taking it as an
 * argument, which is why this is the command given: a value passed on a command
 * line lands in shell history, and a leaked Stripe key is not recovered by
 * deleting a line from `.zsh_history`.
 */
export function setSecretCommand(name: string): string {
  return `firebase functions:secrets:set ${name} --project ${FIREBASE_PROJECT_ID}`;
}

/** One resolved secret, as the response reports it. Never a value, never a prefix. */
export interface SecretState {
  name: string;
  required: boolean;
  purpose: string;
  declared: boolean;
  resolves: boolean;
  /** Character count of the resolved value, 0 when it did not resolve. */
  length: number;
}

/**
 * What a probe found, as four outcomes rather than two booleans.
 *
 *   `none`  no free check exists for this integration. `detail` says why, and it
 *           is never left blank: an unexplained gap where a result should be
 *           reads as a failure.
 *   `pass`  something was exercised and it worked.
 *   `fail`  something was exercised and the answer was a real, known "not yet"
 *           (no Google account connected, Sentry never initialised). The
 *           credentials are fine and the finding is in `detail`.
 *   `error` THE CHECK ITSELF could not be made. Kept apart from `fail` because
 *           they send the operator to different places, and because a check that
 *           threw must never be reported as a clean result.
 */
export type LivenessOutcome = 'none' | 'pass' | 'fail' | 'error';

export interface LivenessState {
  outcome: LivenessOutcome;
  detail: string;
}

/**
 * The status, from the secrets and the probe.
 *
 * A MISSING REQUIRED SECRET WINS OVER EVERYTHING. It is the one condition that
 * is certainly broken and certainly fixable, so it is what the operator is told
 * even when a probe also failed.
 *
 * A PROBE THAT ERRORED IS `unknown`, NEVER `missing` and never green. The
 * credentials are there; what broke is our ability to look, and sending an
 * operator to reset a secret that is already correct wastes the one action they
 * had in them.
 */
export function deriveStatus(secrets: readonly SecretState[], liveness: LivenessState): IntegrationStatus {
  const missing = secrets.filter((s) => s.required && !s.resolves);
  if (missing.length > 0) return 'missing';
  switch (liveness.outcome) {
    case 'pass':
      return 'working';
    case 'error':
      return 'unknown';
    // `fail` and `none` are both "the credentials are in place and nothing has
    // proved the integration works". They differ in why, which `detail` carries,
    // and neither is ever shown as working.
    default:
      return 'configured';
  }
}

/** Required secret names that did not resolve. The "named missing piece". */
export function missingSecretNames(secrets: readonly SecretState[]): string[] {
  return secrets.filter((s) => s.required && !s.resolves).map((s) => s.name);
}

/** Joins names as a sentence fragment: "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The single operator-facing line under a row. Verbatim in both clients: it
 * carries the exact command, and a client that paraphrased it would delete the
 * only text that says what to do next.
 *
 * Empty when nothing is owed. A remediation line under a working integration
 * trains the operator to ignore remediation lines.
 *
 * `declaredKnown` GATES THE SECOND BRANCH, and it has to. When the declared-set
 * walk fails, every `declared` comes back false, and without this gate that
 * would print "no deployed function declares it" under all fourteen secrets at
 * once, sending the operator to edit fourteen functions that were already
 * correct. An unknown is not a finding.
 */
export function remediationFor(
  entry: CatalogEntry,
  secrets: readonly SecretState[],
  declaredKnown: boolean,
): string {
  const missing = missingSecretNames(secrets);
  if (missing.length > 0) {
    const commands = missing.map(setSecretCommand).join('\n');
    return (
      `${entry.name} is missing ${listNames(missing)}. Set ${missing.length === 1 ? 'it' : 'them'} from ` +
      `mytribe/ (the command prompts, so the value stays out of your shell history), then redeploy the ` +
      `functions:\n${commands}\nfirebase deploy --only functions:mytribe`
    );
  }
  if (!declaredKnown) return '';
  const undeclared = secrets.filter((s) => s.required && !s.declared).map((s) => s.name);
  if (undeclared.length > 0) {
    return (
      `${listNames(undeclared)} resolved here but no deployed function declares ${
        undeclared.length === 1 ? 'it' : 'them'
      }, so the code that needs ${undeclared.length === 1 ? 'it' : 'them'} will not receive ${
        undeclared.length === 1 ? 'it' : 'them'
      }. Add the name to that function’s secrets array and redeploy: firebase deploy --only functions:mytribe`
    );
  }
  return '';
}

/**
 * The one line the pill is read with. Says what is wrong, or what was actually
 * verified, and never asserts more than was checked.
 */
export function summaryFor(
  entry: CatalogEntry,
  status: IntegrationStatus,
  secrets: readonly SecretState[],
  liveness: LivenessState,
): string {
  if (status === 'missing') {
    const missing = missingSecretNames(secrets);
    return `Not usable: ${listNames(missing)} ${missing.length === 1 ? 'is' : 'are'} not set.`;
  }
  if (status === 'unknown') {
    return `Credentials are set, but the check could not be made: ${liveness.detail}`;
  }
  if (status === 'working') return liveness.detail;
  return `Credentials are set. ${liveness.detail}`;
}
