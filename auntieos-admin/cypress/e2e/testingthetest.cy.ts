describe('Login to AuntieOS', () => {
  beforeEach(() => {
      cy.visit('/')
  });
  it('Login Screen Visible', () => {

             cy.get('#root')
               .find('main').should('have.class', 'signin')
    

    });

});