import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';

/**
 * Form Schemas (`/form-schemas`) against the REAL `listFormSchemas`,
 * `saveFormSchema` and `listBusinessAdmins` (#1195, the real-services
 * counterpart of `cypress/e2e/form-schemas.cy.ts`).
 *
 * The PR-time spec hands the table three rows it wrote itself, so it proves the
 * table sorts what it is given. Here the three rows are `formSchemas/{id}`
 * documents with Firestore Timestamps, read and serialised by the real handler,
 * so the sort claims are about what the server returned (a Timestamp turned to
 * ISO, a missing one turned to null). The fourth test edits a row through the
 * real editor and reads the server's own bookkeeping back: the version it
 * bumped, the time it stamped, and the editor's uid in Updated by.
 *
 * Every row carries the run stamp in its name, and the table is filtered to
 * that stamp before anything is counted, so other schemas in the database (a
 * KinTale schema a trigger wrote, a re-run's leftovers) never change a count.
 */

const STAMP = Date.now().toString(36);
const ID = {
  zeta: `e2e-real-zeta-${STAMP}`,
  alpha: `e2e-real-alpha-${STAMP}`,
  mid: `e2e-real-mid-${STAMP}`,
};
const NAME = {
  zeta: `Zeta form ${STAMP}`,
  alpha: `Alpha form ${STAMP}`,
  mid: `Mid form ${STAMP}`,
};
const RENAMED_MID = `Mid form renamed ${STAMP}`;

/** RENDER includes the cold start of `listFormSchemas`. SAVE is one real `saveFormSchema` round trip. */
const BUDGET_MS = { RENDER: 12_000, SAVE: 10_000 } as const;

/** One section with one field, every key `saveFormSchema`'s schema requires, so the editor can save it unchanged. */
const SECTIONS = [
  {
    title: 'Basics',
    description: null,
    fields: [
      {
        key: 'petName',
        label: 'Pet name',
        type: 'text',
        required: false,
        helperText: null,
        placeholder: null,
        options: null,
        defaultValue: null,
        group: null,
      },
    ],
  },
];

function rowNames() {
  return cy.get('tbody .schemas__row-name').then(($els) => Cypress._.map($els, (el) => el.textContent));
}

function openFormSchemas() {
  cy.signIn();
  cy.visit('/form-schemas');
  cy.get('.schemas__table', { timeout: BUDGET_MS.RENDER }).should('exist');
  cy.get('input[aria-label="Filter schemas by name or id"]').clear().type(STAMP);
  cy.get('tbody .schemas__row-name').should('have.length', 3);
}

/** Clicks Next until the wizard's last step, where Save schema is. */
function advanceToSave() {
  cy.get('.wiz__foot').then(($foot) => {
    if ($foot.find('button:contains("Save schema")').length > 0) return;
    cy.wrap($foot).contains('button', 'Next').click();
    advanceToSave();
  });
}

describe('form schemas (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    const rows: Array<{ id: string; name: string; appliesTo: string; version: number; updatedAt?: string; updatedBy?: string }> = [
      // Newest: first under the default Updated-descending order, last by Name.
      { id: ID.zeta, name: NAME.zeta, appliesTo: 'KINFOLK', version: 2, updatedAt: '2026-06-01T10:00:00.000Z', updatedBy: 'seed_e2e_real' },
      // Older: first by Name. No updatedBy, so the server returns null and the column shows "-".
      { id: ID.alpha, name: NAME.alpha, appliesTo: 'KIN', version: 1, updatedAt: '2026-05-20T10:00:00.000Z' },
      // No updatedAt at all: the server returns null and the row sorts last.
      { id: ID.mid, name: NAME.mid, appliesTo: 'SESSION', version: 3 },
    ];
    for (const row of rows) {
      const { id, ...doc } = row;
      cy.task('upsertDoc', {
        collection: 'formSchemas',
        id,
        doc: { ...doc, description: null, sections: SECTIONS },
        timestampFields: ['updatedAt'],
      });
    }
  });

  after(() => {
    for (const id of Object.values(ID)) cy.task('deleteDoc', { collection: 'formSchemas', id });
  });

  it('#717 sorts the server rows Updated descending by default, a null updatedAt last', () => {
    openFormSchemas();
    cy.get('.schemas__th--updatedAt').should('have.attr', 'aria-sort', 'descending');
    rowNames().should('deep.equal', [NAME.zeta, NAME.alpha, NAME.mid]);
  });

  it('#717 re-sorts by Name ascending on a header click', () => {
    openFormSchemas();
    cy.get('.schemas__th--name .schemas__sort').click();
    cy.get('.schemas__th--name').should('have.attr', 'aria-sort', 'ascending');
    rowNames().should('deep.equal', [NAME.alpha, NAME.mid, NAME.zeta]);
  });

  it('#717 shows "-" for a row the server returned with no updatedBy, and v2 for a stored version 2', () => {
    openFormSchemas();
    cy.contains('tr.schemas__row', NAME.alpha).find('td.schemas__td--by .schemas__blank').should('have.text', '-');
    cy.contains('tr.schemas__row', NAME.zeta).find('td.schemas__td--version .schemas__version').should('have.text', 'v2');
  });

  it('saves an edit through saveFormSchema: the server bumps the version, stamps the time and names the editor', () => {
    openFormSchemas();
    cy.contains('tr.schemas__row', NAME.mid).find('.schemas__row-main').click();
    cy.contains('.fse__label', /^Name$/, { timeout: BUDGET_MS.RENDER })
      .parent()
      .find('input')
      .should('have.value', NAME.mid)
      .clear()
      .type(RENAMED_MID);
    advanceToSave();

    let t0 = 0;
    cy.get('.wiz__foot')
      .contains('button', 'Save schema')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    cy.contains(`Saved ${RENAMED_MID}.`, { timeout: BUDGET_MS.SAVE }).should('exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Save schema to the server verdict on screen').to.be.lessThan(BUDGET_MS.SAVE);
    });

    // Read back through a reload. The row had no updatedAt, so it sorted last;
    // the server stamped it now, so it is the newest and sorts first.
    cy.reload();
    cy.get('.schemas__table', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('input[aria-label="Filter schemas by name or id"]').type(STAMP);
    rowNames().should('deep.equal', [RENAMED_MID, NAME.zeta, NAME.alpha]);
    cy.contains('tr.schemas__row', RENAMED_MID).within(() => {
      // The server's bump of the stored version 3, not the client's guess.
      cy.get('td.schemas__td--version .schemas__version').should('have.text', 'v4');
    });

    // Updated by is the caller's uid, as `listBusinessAdmins` resolves it: the
    // admin's email when the roster knows the uid, its first 8 characters when not.
    cy.task<string>('authUid', { email: ADMIN.email }).then((uid) => {
      cy.contains('tr.schemas__row', RENAMED_MID)
        .find('td.schemas__td--by')
        .invoke('text')
        .then((text) => {
          expect([ADMIN.email, `${uid.slice(0, 8)}…`], 'Updated by').to.include(text.trim());
        });
    });
  });
});
