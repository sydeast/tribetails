import { KINFOLK } from '../fixtures/accounts';

/**
 * #1833: the bell badge counts a new notice with no reload.
 *
 * The walk that found it: Kinfolk A's badge read 6, the Auntie tapped "OMW",
 * the notice was listed with a red dot and the badge still read 6, four times
 * out of four, until the page was reloaded.
 *
 * This is the one test of the real listener: the app's own Firestore SDK,
 * signed in as the kinfolk, listening through `firestore.rules` on the
 * emulator. The rows are written from outside the browser the way the
 * dispatcher writes them, and the page is never reloaded and never navigated
 * after the first visit. `getMyHome` is stubbed with no unread count, so every
 * number on the bell here comes from the listener.
 */

const BADGE = '[data-testid="bell-badge"]';
const mine = (id: string, extra: Record<string, unknown> = {}) => ({ id, kinfolkId: KINFOLK.kinfolkId, ...extra });
const IDS = ['e2e-bell-1', 'e2e-bell-2', 'e2e-bell-other', 'e2e-bell-archived'];

describe('bell badge, live (#1833)', () => {
  after(() => {
    for (const id of IDS) cy.task('removeNotification', id);
  });

  it('goes up as notices arrive and down as they are read, without a reload', () => {
    cy.signIn();
    cy.get('a.iconbtn[aria-label="Notifications"]').should('exist');
    cy.get(BADGE).should('not.exist');

    // A notice arrives.
    cy.task('putNotification', mine('e2e-bell-1'));
    cy.get(BADGE, { timeout: 15_000 }).should('have.text', '1');
    cy.get('a.iconbtn').should('have.attr', 'aria-label', 'Notifications, 1 unread');

    // A second one.
    cy.task('putNotification', mine('e2e-bell-2'));
    cy.get(BADGE, { timeout: 15_000 }).should('have.text', '2');

    // One about another household, and one that is archived: neither counts.
    cy.task('putNotification', { id: 'e2e-bell-other', kinfolkId: 'some-other-household' });
    cy.task('putNotification', mine('e2e-bell-archived', { archived: true }));
    // A third counted row would have made this 3; a fourth 4.
    cy.task('putNotification', mine('e2e-bell-1', { minutesAgo: 1 }));
    cy.get(BADGE).should('have.text', '2');

    // One is read somewhere else.
    cy.task('putNotification', mine('e2e-bell-1', { read: true }));
    cy.get(BADGE, { timeout: 15_000 }).should('have.text', '1');

    // The rest are read: no badge, and the bell says so.
    cy.task('putNotification', mine('e2e-bell-2', { read: true }));
    cy.get(BADGE, { timeout: 15_000 }).should('not.exist');
    cy.get('a.iconbtn').should('have.attr', 'aria-label', 'Notifications');

    // Marked unread again by the office: it is back on the bell.
    cy.task('putNotification', mine('e2e-bell-2', { read: false }));
    cy.get(BADGE, { timeout: 15_000 }).should('have.text', '1');
  });
});
