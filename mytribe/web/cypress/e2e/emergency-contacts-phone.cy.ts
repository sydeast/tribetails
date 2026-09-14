import type { GetMyTribeProfileResult, ListEmergencyContactsResult } from '../../src/api/tribeApi';
import { ACCESS, HOME, SET_ACTIVE_TRIBE } from '../fixtures/access';
import { KINFOLK } from '../fixtures/accounts';
import { stubCallables } from '../support/callables';

/**
 * The Tribe Profile's Emergency Contacts card at phone width (#829).
 *
 * WHY A BROWSER SPEC. Mobile web is the field backup and iOS kinfolk have only
 * this portal, so the card has to fit a phone. jsdom has no layout, so the
 * only way to know is to open the real screen at 390px and 360px and measure.
 *
 * The callables are stubbed (`cy.intercept`, per `support/callables.ts`), typed
 * against the app's own interfaces. Every assertion is on what the page shows.
 */

const PROFILE: GetMyTribeProfileResult = {
  profile: { kinfolkId: KINFOLK.kinfolkId, displayName: KINFOLK.displayName, customFields: [] },
  homeAccess: { gateCode: null, keyLocation: null, wifiPassword: null, customFields: [], updatedAtMs: null },
};

const TWO_CONTACTS: ListEmergencyContactsResult['contacts'] = [
  { name: 'Rosalind Featherstonehaugh-Whitmore', phone: '+18055550199', relationship: 'Neighbour across the road', recordedAt: null, updatedAt: null },
  { name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null },
];

const WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';

function openTribeProfile(list: ListEmergencyContactsResult, onSave?: (payload: unknown) => void) {
  cy.signIn();
  stubCallables({
    getMyAccess: ACCESS,
    getMyHome: HOME,
    setActiveTribe: SET_ACTIVE_TRIBE,
    getMyTribeProfile: PROFILE,
    getVetClinics: { clinics: [] },
    listMembers: { members: [] },
    getBusinessContact: { name: 'Tribe Tails Pet Care', email: '', phone: '', address: '' },
    listEmergencyContacts: list,
    saveEmergencyContacts: (payload: unknown) => {
      onSave?.(payload);
      return { contacts: TWO_CONTACTS };
    },
  });
  cy.visit('/tribe/edit');
  cy.get('#ec-title', { timeout: 30_000 }).should('contain.text', 'Emergency Contacts');
}

/** The page never scrolls sideways, and nothing inside the card runs past the screen. */
function assertFitsWidth(width: number) {
  cy.document().then((doc) => {
    expect(doc.documentElement.scrollWidth, 'page scrollWidth').to.be.at.most(width);
  });
  cy.get('.ec-card').then(($card) => {
    const card = $card[0]!.getBoundingClientRect();
    expect(card.left, 'card left edge').to.be.at.least(0);
    expect(card.right, 'card right edge').to.be.at.most(width);
    $card.find('input, button, a, li').each((_, el) => {
      const r = el.getBoundingClientRect();
      expect(r.right, `${el.tagName.toLowerCase()}#${el.id || el.className} right edge`).to.be.at.most(card.right + 0.5);
    });
  });
}

for (const width of [390, 360]) {
  describe(`Emergency Contacts at ${width}px`, () => {
    beforeEach(() => {
      cy.viewport(width, 844);
    });

    it('with Home access: both slots, their buttons and Save fit, and a save goes through', () => {
      const saved: unknown[] = [];
      openTribeProfile({ contacts: TWO_CONTACTS, canEdit: true, legacy: false }, (p) => saved.push(p));
      cy.get('#ec-1-name').should('have.value', 'Lee Park');
      for (const id of ['#ec-0-name', '#ec-0-phone', '#ec-0-relationship', '#ec-1-name', '#ec-1-phone', '#ec-1-relationship']) {
        cy.get(id).should('be.visible');
      }
      cy.contains('button', 'Call first').should('be.visible');
      cy.contains('button', 'Save Emergency Contacts').should('be.visible');
      assertFitsWidth(width);

      cy.contains('button', 'Save Emergency Contacts').click();
      cy.contains('.ec-card p', 'Saved.').should('be.visible');
      cy.wrap(saved).should('have.length', 1);
    });

    it('a household with none is prompted, and the single slot fits', () => {
      openTribeProfile({ contacts: [], canEdit: true, legacy: false });
      cy.contains('.ec-card', 'A household needs at least one Emergency Contact').should('be.visible');
      cy.get('#ec-0-name').should('be.visible');
      cy.contains('button', 'Add a second Emergency Contact').should('be.visible');
      assertFitsWidth(width);
    });

    it('without Home access: the read-only list and the lock sentence fit, with no inputs', () => {
      openTribeProfile({ contacts: TWO_CONTACTS, canEdit: false, legacy: false });
      cy.contains('.ec-card li', 'Rosalind Featherstonehaugh-Whitmore').should('be.visible');
      cy.get('[data-testid="ec-locked"]').should('be.visible').and('contain.text', 'Only someone with Home access can change the Emergency Contact.');
      cy.get('.ec-card input').should('not.exist');
      assertFitsWidth(width);
    });

    it('a tap opens the info tip, and the sentence stays on screen', () => {
      openTribeProfile({ contacts: TWO_CONTACTS, canEdit: false, legacy: false });
      cy.get('button[aria-label="Who gets called"]').click();
      cy.get('[role="tooltip"]')
        .should('be.visible')
        .and('have.text', WHO_GETS_CALLED)
        .then(($tip) => {
          const r = $tip[0]!.getBoundingClientRect();
          expect(r.left, 'tip left edge').to.be.at.least(0);
          expect(r.right, 'tip right edge').to.be.at.most(width);
        });
      assertFitsWidth(width);
    });
  });
}
