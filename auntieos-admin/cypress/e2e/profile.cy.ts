describe('profile', () => {
  it('reaches a rendered screen', () => {
    // NOT `cy.session()`. The Firebase Auth SDK persists to IndexedDB, which
    // `cy.session()` does not cache, so a cached session restores nothing and
    // the next visit lands back on the form. `cy.signIn()` (support/commands.ts)
    // is the supported path and explains the trade in full.
    cy.signIn();
  });
});
