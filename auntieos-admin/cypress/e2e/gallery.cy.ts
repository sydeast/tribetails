/**
 * The global Gallery (`/gallery`): the grid rebuilt toward its mock (#692,
 * PR #739) and the fullscreen viewer freed from its 512px stage (#691, same
 * PR).
 *
 * MEDIA IS SEEDED THROUGH THE REAL UPLOAD PIPELINE, not written straight to
 * Firestore. `e2e/seed.ts` carries no `media_files` row, and the app's own
 * sign -> Cloudinary -> `addDoc` pipeline is exactly how a real row gets
 * there, so intercepting the two external calls (Cloudinary sign-upload,
 * Cloudinary itself) and driving the real Upload dialog is "the same
 * Firestore path the existing specs use for setup": `account-photo.cy.ts`
 * seeds its own `media_files` row through this identical pipeline, same
 * intercepts, same fake `cloudName`. The Firestore write itself is real.
 *
 * CLEANUP is a direct Firestore REST delete with the emulator's owner-bearer
 * bypass (`e2e/seed.ts`'s own trick for wiping the database), by
 * `originalFileName`, since `deleteMediaFile` is a callable and this harness
 * pins every callable at a dead port by design (docs/runbooks/e2e.md): a real
 * delete through the UI has nowhere to run. It is best-effort
 * (`failOnStatusCode: false`, nothing asserted on the response) so a cleanup
 * hiccup cannot fail a test that already passed.
 */

// A module, not a global script: this file's top-level constants must not
// collide with the same-named ones `packages.cy.ts` and `schedule.cy.ts`
// declare for their own Firestore REST setup.
export {};

const FIRESTORE = 'http://127.0.0.1:8385';
const PROJECT = 'auntieos-ttpc';
const OWNER = { Authorization: 'Bearer owner' };

const CALLABLE = (name: string) => `**/us-central1/${name}`;

/** A 1x1 transparent PNG, same bytes `account-photo.cy.ts` uses. `fixturesFolder` is off. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

/** Per-run suffix so a leftover row from a previous local run cannot collide with this one's assertions. */
const STAMP = Date.now().toString(36);

/**
 * Finds the `media_files` doc this run's upload wrote, by its unique
 * `originalFileName`, and deletes it. Best-effort: the emulator wipes the
 * whole database at the start of the next full run either way, so a failed
 * cleanup here degrades to harmless residue, never a failing test.
 */
function cleanupMediaDoc(fileName: string): void {
  cy.request({
    method: 'GET',
    url: `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/media_files?pageSize=300`,
    headers: OWNER,
    failOnStatusCode: false,
  }).then((resp) => {
    const documents = (resp.body?.documents ?? []) as Array<{
      name: string;
      fields?: Record<string, { stringValue?: string }>;
    }>;
    const match = documents.find((d) => d.fields?.['originalFileName']?.stringValue === fileName);
    if (match) {
      cy.request({ method: 'DELETE', url: `${FIRESTORE}/v1/${match.name}`, headers: OWNER, failOnStatusCode: false });
    }
  });
}

/**
 * Signs in, intercepts the sign-upload and Cloudinary calls (mirroring
 * `account-photo.cy.ts` exactly), opens Gallery, uploads one 1x1 PNG under
 * `fileName`, and waits for its tile to land (the caption strip carries the
 * file name even at rest; it is only invisible, never absent, see the CSS
 * assertion below).
 */
function uploadTestImage(fileName: string): void {
  // The fake thumbnail Cloudinary URL `writeMediaFileDoc` computes from the
  // fake `cloudName` points at a real host with nothing behind this path;
  // this keeps the grid from making a real network request for it.
  cy.intercept('GET', 'https://res.cloudinary.com/**', { statusCode: 404, body: '' });

  cy.intercept('POST', '**/api/cloudinary/sign-upload', (req) => {
    req.reply({
      statusCode: 200,
      body: {
        cloudName: 'e2e-cloud',
        apiKey: 'e2e-key',
        timestamp: 1,
        signature: 'e2e-sig',
        folder: req.body.folder,
        entityType: req.body.entityType,
      },
    });
  }).as('sign');
  cy.intercept('POST', 'https://api.cloudinary.com/v1_1/e2e-cloud/auto/upload', {
    statusCode: 200,
    body: {
      secure_url: PNG_DATA_URI,
      public_id: `tribetails/gallery/e2e/${fileName}`,
      resource_type: 'image',
      format: 'png',
      bytes: 68,
      width: 1,
      height: 1,
    },
  }).as('cloudinary');

  cy.signIn();
  cy.visit('/gallery');
  cy.contains('button', 'Upload media').click();
  cy.get('[role="dialog"]').within(() => {
    // The household picker (the default KINFOLK target) renders a <select>
    // only once `kinfolkOptions` has resolved; before that it renders a
    // "No households on file yet" hint instead. Worse, `kinfolkId` seeds
    // itself from `kinfolkOptions[0]?.id` in a `useState` INITIALIZER, which
    // runs once at mount: if the dialog opened before the roster resolved
    // (it reliably does, since nothing on this screen blocks "Upload media"
    // on that read), the select can render for real and still carry a
    // `kinfolkId` of `''`, and `handleUpload` bails out on a blank
    // `entityId` before it ever asks for a signed upload. That is why an
    // upload driven the instant the dialog opens sends no request at all.
    // Explicitly choosing a household is what fixes it: a real `select`
    // fires the `onChange` that sets the state, regardless of what the
    // initializer saw. `account-photo.cy.ts` never has to do this: its
    // upload target is fixed, with no roster to race.
    cy.get('select', { timeout: 10_000 }).should('exist');
    cy.get('select option')
      .first()
      .invoke('val')
      .then((householdId) => {
        cy.get('select').select(householdId as string);
      });
    cy.get('input[type="file"]').selectFile(
      { contents: Cypress.Buffer.from(PNG_BASE64, 'base64'), fileName, mimeType: 'image/png' },
      { force: true }, // the input is visually hidden behind its own label
    );
    cy.contains('button', 'Upload').click();
  });
  cy.wait('@cloudinary');
  // The dialog closed and the real Firestore write landed: the tile's caption
  // strip carries the file name (`mediaCaption` falls back to it), present in
  // the DOM even though it is invisible at rest.
  cy.contains('.gallery__tile-caption-strip', fileName, { timeout: 10_000 }).should('exist');
}

describe('gallery', () => {
  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here.

  // The file name each test's upload used, so the afterEach below can find and
  // remove exactly that row. Every test sets this as its first statement
  // (inside `uploadTestImage`'s caller), before anything that could fail.
  let currentFileName = '';

  beforeEach(() => {
    currentFileName = '';
  });

  afterEach(() => {
    if (currentFileName !== '') cleanupMediaDoc(currentFileName);
  });

  it('#692 shows one filter pill row with per-type counts, and no caption text under a tile at rest', () => {
    currentFileName = `e2e-gallery-${STAMP}-a.png`;
    uploadTestImage(currentFileName);

    // ONE pill row, not three labelled chip rows.
    cy.get('.gallery__pills[role="group"]').should('have.length', 1);
    // The mock's per-type counts: the type this upload actually wrote carries
    // a real, positive count on its own pill.
    cy.contains('.gallery__pills .gallery__pill', 'Images')
      .find('.gallery__pill-count')
      .invoke('text')
      .then((text) => {
        expect(Number(text), 'Images pill count').to.be.greaterThan(0);
      });
    cy.contains('.gallery__pills .gallery__pill', 'All')
      .find('.gallery__pill-count')
      .invoke('text')
      .then((text) => {
        expect(Number(text), 'All pill count').to.be.greaterThan(0);
      });
    // The two facets the mock's own entity-scoped screen never had, now
    // compact selects beside the pills rather than their own labelled chip
    // rows: household and month, exactly two.
    cy.get('.gallery__selects select').should('have.length', 2);

    // No caption text under the tile at rest: the strip is in the DOM (the
    // upload helper above already proved that) but invisible until hover or
    // focus. jsdom cannot see this (opacity is not a visibility check any unit
    // test can make), which is exactly why this assertion lives here.
    cy.contains('.gallery__tile-caption-strip', currentFileName).should('have.css', 'opacity', '0');
  });

  it('#692 carries the count chip and the upload action in one heading row', () => {
    currentFileName = `e2e-gallery-${STAMP}-b.png`;
    uploadTestImage(currentFileName);

    cy.get('.gallery__header-actions').within(() => {
      cy.get('.gallery__count-chip').should('exist');
      cy.get('.gallery__count-chip .gallery__count-chip-n')
        .invoke('text')
        .then((text) => expect(Number(text), 'header chip count').to.be.greaterThan(0));
      cy.contains('button', 'Upload media').should('exist');
    });
  });

  it('#692 offers a delete control on a tile, a sibling of the open button', () => {
    currentFileName = `e2e-gallery-${STAMP}-c.png`;
    uploadTestImage(currentFileName);

    cy.contains('.gallery__cell', currentFileName).as('cell');
    // The open button and the delete control are siblings inside the cell,
    // never one nested in the other (nesting is invalid HTML, and jsdom
    // accepts it silently, which is exactly why this is asserted through a
    // real browser).
    cy.get('@cell').find('> .gallery__tile').should('have.length', 1);
    cy.get('@cell').find('> .gallery__tile-actions button').as('deleteBtn');

    // Cancel: the dialog closes, nothing is sent, the tile stays.
    cy.get('@deleteBtn').click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('.dialog__title').should('have.text', 'Delete Media');
      cy.contains('.gallery__dialog-body', 'delete this image').should('exist');
      cy.contains('button', 'Cancel').click();
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('.gallery__cell', currentFileName).should('exist');

    // Confirm: the callable is intercepted (this harness pins every callable
    // at a dead port, see docs/runbooks/e2e.md), and what is asserted is the
    // request the tile actually sends: the file's own id, with no entity
    // scope, because this global grid spans every household.
    cy.intercept('POST', CALLABLE('deleteMediaFile'), {
      statusCode: 200,
      body: {
        result: { ok: true, mediaFileId: 'x', entityType: 'KINFOLK', entityId: 'x', clearedProfilePhoto: false },
      },
    }).as('deleteCall');

    cy.get('@deleteBtn').click();
    cy.get('[role="dialog"]').contains('button', 'Delete').click();
    cy.wait('@deleteCall').then(({ request }) => {
      const body = request.body as { data: { mediaFileId: string; entityId?: string } };
      expect(body.data.mediaFileId, 'mediaFileId').to.have.length.greaterThan(0);
      expect(body.data.entityId, 'no entity scope on the global grid').to.equal(undefined);
    });
    cy.get('[role="dialog"]').should('not.exist');
  });

  it('#691 the viewer offers a fullscreen toggle and an Open original link for an image', () => {
    currentFileName = `e2e-gallery-${STAMP}-d.png`;
    uploadTestImage(currentFileName);

    cy.contains('.gallery__tile', currentFileName).click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('.dialog__title').should('have.text', currentFileName);
      cy.get('button.media-viewer__fullscreen-toggle').should('have.text', 'Fullscreen');
      cy.get('a.media-viewer__original')
        .should('have.text', 'Open original')
        .and('have.attr', 'href', PNG_DATA_URI)
        .and('have.attr', 'target', '_blank');
    });
  });
});
