import { usingFixtureAdmin } from '../support/commands';

/**
 * The global Gallery (`/gallery`) with the REAL `deleteMediaFile` (#1195, the
 * real-services counterpart of `cypress/e2e/gallery.cy.ts`).
 *
 * The PR-time spec's one callable is Delete, and it answers it with a stub and
 * asserts the request the tile sent; the row it seeded is still there after. Here
 * the handler runs, so the claims are about the result:
 *
 *   - Cancel sends nothing and the tile stays (the dialog half, as before);
 *   - Delete removes the `media_files` row: the tile goes, and after a reload
 *     the grid (a direct Firestore stream) no longer has it and the counts
 *     dropped by one;
 *   - the viewer (#691) and the pill row (#692) render the seeded row, the
 *     layout claims the PR-time spec makes, kept so this file stands alone.
 *
 * NO VENDOR. `deleteMediaFile` deliberately does not destroy the Cloudinary
 * asset (see its header), and the seeded row's URLs are `data:` URIs, so
 * nothing leaves the machine.
 *
 * The row is written through the `upsertDoc` task rather than the PR-time
 * spec's REST calls: those name the PR-time project id, and this run's
 * emulators answer under `demo-auntieos-e2e`.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

const STAMP = Date.now().toString(36);
const MEDIA_ID = `e2e-real-gallery-${STAMP}`;
const FILE_NAME = `e2e-real-gallery-${STAMP}.png`;

/** RENDER is the stream plus the lazy chunk. DELETE includes the cold start of `deleteMediaFile`. */
const BUDGET_MS = { RENDER: 10_000, DELETE: 12_000 } as const;

/** Fields as `writeMediaFileDoc` (`api/mediaUpload.ts`) writes them on a real upload. */
function seedMediaDoc() {
  cy.task('upsertDoc', {
    collection: 'media_files',
    id: MEDIA_ID,
    doc: {
      kinfolkId: 'e2e-kf-1',
      entityId: 'e2e-kf-1',
      entityType: 'KINFOLK',
      fileType: 'IMAGE',
      storageUrl: PNG_DATA_URI,
      thumbnailUrl: PNG_DATA_URI,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'e2e-real-gallery-seed',
      description: '',
      originalFileName: FILE_NAME,
      isProfilePhoto: false,
      durationSeconds: 0,
    },
  });
}

function pillCount(label: string) {
  return cy
    .contains('.gallery__pills .gallery__pill', label)
    .find('.gallery__pill-count')
    .invoke('text')
    .then((text) => Number(text));
}

function openGallery() {
  cy.signIn();
  cy.visit('/gallery');
  cy.contains('.gallery__tile-caption-strip', FILE_NAME, { timeout: BUDGET_MS.RENDER }).should('exist');
}

describe('gallery (real deleteMediaFile)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    seedMediaDoc();
  });

  after(() => {
    // Gone already when the delete test passed; removing a missing doc is a no-op.
    cy.task('deleteDoc', { collection: 'media_files', id: MEDIA_ID });
  });

  it('#692 #691 renders the seeded row: one pill row with counts, and the viewer with fullscreen and the original', () => {
    openGallery();
    cy.get('.gallery__pills[role="group"]').should('have.length', 1);
    pillCount('Images').should('be.greaterThan', 0);
    cy.get('.gallery__selects select').should('have.length', 2);
    cy.contains('.gallery__tile-caption-strip', FILE_NAME).should('have.css', 'opacity', '0');

    cy.contains('.gallery__tile', FILE_NAME).click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('.dialog__title').should('have.text', FILE_NAME);
      cy.get('button.media-viewer__fullscreen-toggle').should('have.text', 'Fullscreen');
      cy.get('a.media-viewer__original').should('have.attr', 'href', PNG_DATA_URI);
    });
  });

  it('#692 deletes a tile through deleteMediaFile: Cancel keeps it, Delete removes the row for good', () => {
    openGallery();

    cy.contains('.gallery__cell', FILE_NAME).find('> .gallery__tile-actions button').click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('.dialog__title').should('have.text', 'Delete Media');
      cy.contains('button', 'Cancel').click();
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('.gallery__cell', FILE_NAME).should('exist');

    pillCount('All').then((before) => {
      let t0 = 0;
      cy.contains('.gallery__cell', FILE_NAME).find('> .gallery__tile-actions button').click();
      cy.get('[role="dialog"]')
        .contains('button', 'Delete')
        .click()
        .then(() => {
          t0 = Date.now();
        });
      cy.contains('.gallery__cell', FILE_NAME, { timeout: BUDGET_MS.DELETE }).should('not.exist');
      cy.then(() => {
        expect(Date.now() - t0, 'ms from Delete to the tile leaving the grid').to.be.lessThan(BUDGET_MS.DELETE);
      });

      // The write, not the local state: a fresh load of the grid streams
      // `media_files` again and the row is not in it.
      // The cue that the stream is in is either the empty state (this was the
      // only row) or the pill row with the count one lower; both only render
      // once the read has answered, so the absence below is not a race.
      cy.reload();
      if (before === 1) {
        cy.contains('.gallery__empty-title', 'No media files found', { timeout: BUDGET_MS.RENDER }).should('exist');
      } else {
        cy.get('.gallery__pills', { timeout: BUDGET_MS.RENDER }).should('exist');
        pillCount('All').should('eq', before - 1);
      }
      cy.contains('.gallery__tile-caption-strip', FILE_NAME).should('not.exist');
    });
  });
});
