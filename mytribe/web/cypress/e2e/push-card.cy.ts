/**
 * #1787: the notifications card on the portal home, by browser permission.
 *
 * The permission is faked before the app loads through cy.setNotificationPermission (the
 * browser in a test run cannot be told to grant or block), and the service
 * worker lookup is faked so the
 * "granted but not registered" outcome is the one the app reaches without
 * waiting on the push service. What this does not cover is a successful
 * registration, which needs a real FCM token; the vitest suite covers that.
 */
type Permission = 'default' | 'granted' | 'denied';
function visitHomeWith(permission: Permission, onWindow?: (win: Cypress.AUTWindow) => void): void {
  cy.stubAccess();
  cy.setNotificationPermission(permission);
  cy.visit('/home', {
    onBeforeLoad(win) {
      win.sessionStorage.removeItem('mytribe.push.dismissed');
      onWindow?.(win);
    },
  });
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
});
