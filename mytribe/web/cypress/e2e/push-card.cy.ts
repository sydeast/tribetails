import type { registerFcmToken } from '../../src/api/pushApi';
import { ACCESS, HOME, SET_ACTIVE_TRIBE } from '../fixtures/access';
import { stubCallables } from '../support/callables';

/**
 * #1787: the notifications card on the portal home, by browser permission.
 * #1808: and on Notification Settings, where a signed-up device says so.
 *
 * The permission is faked before the app loads through cy.setNotificationPermission (the
 * browser in a test run cannot be told to grant or block), and the service
 * worker lookup is faked so the
 * "granted but not registered" outcome is the one the app reaches without
 * waiting on the push service.
 *
 * A SUCCESSFUL registration (#1808) runs the real lib/push.ts and the real
 * Firebase messaging SDK end to end, with three things faked underneath it: a
 * service worker registration whose push subscription is canned, the two
 * Google endpoints getToken() calls (Firebase Installations for the auth
 * token, FCM registrations for the token itself), and the registerFcmToken
 * callable. Both Google hosts are answered for every method and path, so a
 * request the SDK makes that this file did not expect is still answered here
 * and never reaches the live project the e2e config names.
 */
type Permission = 'default' | 'granted' | 'denied';
type RegisterFcmTokenResult = Awaited<ReturnType<typeof registerFcmToken>>;

function visitWith(
  path: string,
  permission: Permission,
  onWindow?: (win: Cypress.AUTWindow) => void,
  stubCallablesYourself = false,
): void {
  if (!stubCallablesYourself) cy.stubAccess();
  cy.setNotificationPermission(permission);
  cy.visit(path, {
    onBeforeLoad(win) {
      win.sessionStorage.removeItem('mytribe.push.dismissed');
      onWindow?.(win);
    },
  });
}
function visitHomeWith(permission: Permission, onWindow?: (win: Cypress.AUTWindow) => void): void {
  visitWith('/home', permission, onWindow);
}

/** The FCM token the faked registration endpoint hands back. Never a real one. */
const FAKE_FCM_TOKEN = 'e2e-fake-fcm-token';

const GOOGLE_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, x-goog-api-key, x-goog-firebase-installations-auth, x-firebase-client',
} as const;

/**
 * Answers Firebase Installations and FCM registrations locally. Every request
 * to either host is replied to here; nothing passes through.
 */
function fakeGooglePush(): void {
  cy.intercept({ hostname: 'firebaseinstallations.googleapis.com' }, (req) => {
    if (req.method === 'OPTIONS') return req.reply({ statusCode: 204, headers: { ...GOOGLE_CORS } });
    if (req.method === 'POST' && /\/installations$/.test(new URL(req.url).pathname)) {
      return req.reply({
        statusCode: 200,
        headers: { ...GOOGLE_CORS },
        body: {
          name: 'projects/e2e/installations/e2eFakeFid0000000000',
          fid: 'e2eFakeFid0000000000',
          refreshToken: 'e2e-fake-refresh-token',
          authToken: { token: 'e2e-fake-installations-token', expiresIn: '604800s' },
        },
      });
    }
    return req.reply({ statusCode: 404, headers: { ...GOOGLE_CORS }, body: { error: { message: 'not faked' } } });
  }).as('installations');
  cy.intercept({ hostname: 'fcmregistrations.googleapis.com' }, (req) => {
    if (req.method === 'OPTIONS') return req.reply({ statusCode: 204, headers: { ...GOOGLE_CORS } });
    if (req.method === 'POST') return req.reply({ statusCode: 200, headers: { ...GOOGLE_CORS }, body: { token: FAKE_FCM_TOKEN } });
    return req.reply({ statusCode: 200, headers: { ...GOOGLE_CORS }, body: {} });
  }).as('fcmRegistrations');
}

/**
 * A ServiceWorkerRegistration the messaging SDK accepts (it checks
 * `instanceof`) with an active worker and a canned push subscription, so no
 * real worker is installed and no real push service is subscribed.
 */
function fakeServiceWorker(win: Cypress.AUTWindow): void {
  const key = (bytes: number) => new Uint8Array(bytes).fill(7).buffer;
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-fake-endpoint',
    getKey: (name: string) => (name === 'auth' ? key(16) : key(65)),
    toJSON: () => ({}),
    unsubscribe: () => Promise.resolve(true),
  };
  const registration = Object.create(win.ServiceWorkerRegistration.prototype) as ServiceWorkerRegistration;
  Object.defineProperties(registration, {
    active: { value: { state: 'activated' } },
    waiting: { value: null },
    installing: { value: null },
    scope: { value: `${win.location.origin}/` },
    showNotification: { value: () => Promise.resolve() },
    pushManager: {
      value: {
        getSubscription: () => Promise.resolve(subscription),
        subscribe: () => Promise.reject(new Error('e2e: the canned subscription should have been used')),
      },
    },
  });
  const container = win.navigator.serviceWorker;
  cy.stub(container, 'getRegistration').resolves(registration);
  cy.stub(container, 'register').rejects(new Error('e2e: no real worker is installed'));
  // Last run's token would let getToken() skip the faked endpoints, so start clean.
  win.indexedDB.deleteDatabase('firebase-messaging-database');
  win.indexedDB.deleteDatabase('firebase-installations-database');
}

/** Visits [path] on a granted browser whose sign-up succeeds; returns the tokens registerFcmToken received. */
function visitSignedUp(path: string): string[] {
  const registered: string[] = [];
  fakeGooglePush();
  stubCallables({
    getMyAccess: ACCESS,
    getMyHome: HOME,
    setActiveTribe: SET_ACTIVE_TRIBE,
    registerFcmToken: (payload: unknown): RegisterFcmTokenResult => {
      registered.push((payload as { token: string }).token);
      return { ok: true };
    },
  });
  visitWith(path, 'granted', fakeServiceWorker, true);
  return registered;
}

describe('portal notifications card (#1787)', () => {
  before(() => {
    cy.signIn();
  });
  it('default permission shows the Enable notifications card', () => {
    visitHomeWith('default');
    cy.get('.nav', { timeout: 30_000 }).should('exist');
    cy.contains('.push-prompt button', 'Enable notifications').should('be.visible');
    cy.contains('.push-prompt', 'Get notified about visits').should('be.visible');
  });
  it('denied permission shows the Chrome note instead of the Enable button, and Close hides it', () => {
    visitHomeWith('denied');
    cy.get('.nav', { timeout: 30_000 }).should('exist');
    cy.contains('.push-prompt', 'Notifications are blocked').should('be.visible');
    cy.contains('.push-prompt', 'lock icon next to the address').should('be.visible');
    cy.contains('button', 'Enable notifications').should('not.exist');
    cy.contains('.push-prompt button', 'Close').click();
    cy.get('.push-prompt').should('not.exist');
  });
  it('granted permission that fails to register shows the finish card with the code, and Retry tries again', () => {
    let failureLogs: sinon.SinonSpy | undefined;
    visitHomeWith('granted', (win) => {
      const container = win.navigator.serviceWorker;
      cy.stub(container, 'getRegistration').resolves(undefined);
      cy.stub(container, 'register').rejects(new Error('blocked for the test'));
      failureLogs = cy.spy(win.console, 'error');
    });
    cy.expectConsoleError(/\[push\] enable failed/);
    const failures = () => failureLogs!.getCalls().filter((c) => c.args[0] === '[push] enable failed').length;
    cy.get('.nav', { timeout: 30_000 }).should('exist');
    cy.contains('.push-prompt', 'Finish turning on notifications', { timeout: 30_000 }).should('be.visible');
    cy.contains('.push-prompt .err', 'Could not enable notifications').should('be.visible');
    cy.contains('.push-prompt button', 'Enable notifications').should('not.exist');
    // One silent attempt on load, however many screens mounted the card.
    cy.then(() => expect(failures(), 'silent attempt').to.equal(1));
    cy.contains('.push-prompt button', 'Retry').click();
    cy.then(() => expect(failures(), 'after Retry').to.equal(2));
    cy.contains('.push-prompt button', 'Retry').should('be.enabled');
    cy.contains('.push-prompt .err', 'Could not enable notifications').should('be.visible');
  });

  // #1808: a device whose sign-up worked.
  it('a signed-up device shows no card on Home', () => {
    const registered = visitSignedUp('/home');
    cy.get('.nav', { timeout: 30_000 }).should('exist');
    cy.wait('@fcmRegistrations', { timeout: 30_000 });
    cy.wrap(registered, { timeout: 30_000 }).should('deep.equal', [FAKE_FCM_TOKEN]);
    cy.get('.push-prompt').should('not.exist');
  });
  it('a signed-up device says notifications are on in Notification Settings', () => {
    const registered = visitSignedUp('/account/notifications');
    cy.contains('h1', 'Notification', { timeout: 30_000 }).should('be.visible');
    cy.contains('.push-prompt', 'Notifications are on for this device.', { timeout: 30_000 }).should('be.visible');
    cy.wrap(registered).should('deep.equal', [FAKE_FCM_TOKEN]);
    cy.contains('.push-prompt', 'Finish turning on notifications').should('not.exist');
    cy.contains('.push-prompt button', 'Retry').should('not.exist');
  });
});
