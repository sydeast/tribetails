/**
 * The admin's entire browser-level suite: it is up, and you can sign in.
 *
 * DELIBERATELY THIS SMALL. An earlier version of this branch walked all 21
 * screens, crawled links and drove named workflows, and the operator's judgment
 * was that those tests asserted the wrong things: 46 assertions that an element
 * was present or visible against 2 that anything actually happened. A suite
 * shaped like that goes green while a callable times out and while every screen
 * takes fifteen seconds, because it never asks whether the app DID anything or
 * how long it took.
 *
 * So this file is the setup, and only the setup. It proves the harness works
 * (emulators, seed, dev server, browser) and that the front door opens. Anything
 * that claims to verify a feature belongs in a suite designed around behaviour
 * and timing, agreed before it is written rather than after.
 *
 * Do not grow this file by adding screens to it.
 */
describe('admin smoke', () => {
  it('serves the app and boots it in a browser', () => {
    // `failOnStatusCode` is the point of the first assertion: a 404 or a 500
    // from hosting fails here rather than being swallowed and reported later as
    // an empty page. The second is the app actually mounting: a bundle that
    // throws on load leaves the document served and the root empty, which is
    // the exact failure a status check alone would call a pass.
    cy.visit('/', { failOnStatusCode: true });
    cy.get('#root', { timeout: 30_000 }).should('not.be.empty');
  });

  it('lets an operator sign in and reach a signed-in screen', () => {
    cy.signIn();

    // Asserting on the ROUTE the guard granted, not on the absence of an error.
    // A denied sign-in leaves the form on screen with no banner in some paths,
    // and "no error appeared" would call that a pass.
    cy.location('pathname').should('eq', '/home');
    cy.get('.shell__rail').should('exist');
    cy.get('.signin__card').should('not.exist');
  });
});
