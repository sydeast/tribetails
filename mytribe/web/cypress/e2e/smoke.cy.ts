/**
 * The portal's entire browser-level suite: it is up, and a kinfolk can sign in.
 *
 * DELIBERATELY THIS SMALL, for the reason written at the top of the admin's
 * `smoke.cy.ts`: the version of this branch that walked every screen and
 * crawled every link asserted that elements existed, never that anything
 * happened or how long it took, and the operator ruled that out. This file is
 * the setup only. It proves the harness works and that the front door opens.
 *
 * Do not grow this file by adding screens to it.
 */
describe('portal smoke', () => {
  it('serves the app and boots it in a browser', () => {
    // A 404 or 500 from hosting fails on the visit rather than being reported
    // later as an empty page, and the root having content is the app actually
    // mounting: a bundle that throws on load still serves a valid document.
    cy.visit('/', { failOnStatusCode: true });
    cy.get('#root', { timeout: 30_000 }).should('not.be.empty');
  });

  it('lets a kinfolk sign in and reach a signed-in screen', () => {
    cy.signIn();

    cy.location('pathname').should('eq', '/home');
    cy.get('.nav').should('exist');
    // `.errshell` is LaunchError, where every guard failure lands. It renders
    // perfectly, so a check that only asked whether something rendered would
    // call a refused sign-in a success.
    cy.get('.errshell').should('not.exist');
  });
});
