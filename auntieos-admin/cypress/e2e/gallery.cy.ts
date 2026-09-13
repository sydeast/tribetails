/**
 * The global Gallery (`/gallery`): the grid rebuilt toward its mock (#692,
 * PR #739), the fullscreen viewer freed from its 512px stage (#691, same
 * PR), and the glass sweep's skin pass (#755): the kit hero and the tile
 * wearing the shared lift.
 *
 * ONE MEDIA DOC IS SEEDED THROUGH A DIRECT FIRESTORE WRITE, not through the
 * real Upload dialog. `e2e/seed.ts` carries no `media_files` row at all, and
 * an earlier pass here drove the real dialog instead (sign-upload and
 * Cloudinary intercepted, matching `account-photo.cy.ts`); that was fragile
 * in a way this spec does not need to be. Gallery's dialog offers a Target
 * type AND (once the household roster resolves) a Household picker, two
 * `<select>`s where `account-photo.cy.ts`'s fixed-target upload has none,
 * and `kinfolkId` seeds itself from a `useState` initializer that runs once
 * at MOUNT, before that roster reliably resolves. This spec is not about the
 * dialog; #692 and #691 are about the grid and the viewer once a row already
 * exists, so this writes the row directly, the same owner-bearer Firestore
 * REST bypass `packages.cy.ts` and `schedule.cy.ts` already use (`e2e/
 * seed.ts`'s own trick for wiping and reseeding the whole database). One
 * row, seeded once for the whole file and removed once at the end: nothing
 * here mutates it for real (the delete test's callable is intercepted,
 * never a real write), so every test can share it.
 *
 * FIELDS MIRROR WHAT `writeMediaFileDoc` (`api/mediaUpload.ts`) ITSELF
 * WRITES on a real upload: `fileType`, `storageUrl`/`thumbnailUrl`,
 * `uploadedAt` as a real ISO-8601 INSTANT STRING (never a Firestore
 * Timestamp -- `GALLERY_QUERY` orders by it and silently drops any doc
 * missing it, see `api/gallery.ts`), `uploadedBy`, `originalFileName`,
 * `isProfilePhoto`, `durationSeconds`, and a real seeded household id
 * (`kinfolkId`/`entityId` = `e2e-kf-1`, Wanda Thorne) so the tile resolves a
 * real name rather than "Household unavailable". `storageUrl` and
 * `thumbnailUrl` are both the same `data:` URI: it renders everywhere with
 * no network request at all, so no Cloudinary intercept is needed anywhere
 * in this file, including the viewer test.
 */

// A module, not a global script: this file's top-level constants must not
// collide with the same-named ones `packages.cy.ts` and `schedule.cy.ts`
// declare for their own Firestore REST setup.
export {};

const FIRESTORE = 'http://127.0.0.1:8385';
const PROJECT = 'auntieos-ttpc';
const OWNER = { Authorization: 'Bearer owner' };

const CALLABLE = (name: string) => `**/us-central1/${name}`;

/** A 1x1 transparent PNG, same bytes `account-photo.cy.ts` uses, as a `data:` URI: it loads with no network request, so it stands in for both `storageUrl` and `thumbnailUrl`. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

/** Per-run suffix so a leftover doc from a previous local run cannot collide with this one's assertions or its own cleanup. */
const STAMP = Date.now().toString(36);
const MEDIA_ID = `e2e-gallery-${STAMP}`;
const FILE_NAME = `e2e-gallery-${STAMP}.png`;

/** A Firestore REST `Value`, the same encoding `e2e/seed.ts#enc` uses for the shapes this doc needs. */
function enc(v: string | number | boolean): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { integerValue: String(v) };
}

/** Writes one `media_files` doc straight past `firestore.rules` with the emulator's owner bearer. */
function seedMediaDoc(): void {
  const raw: Record<string, string | number | boolean> = {
    kinfolkId: 'e2e-kf-1',
    entityId: 'e2e-kf-1',
    entityType: 'KINFOLK',
    fileType: 'IMAGE',
    storageUrl: PNG_DATA_URI,
    thumbnailUrl: PNG_DATA_URI,
    uploadedAt: new Date().toISOString(),
    uploadedBy: 'e2e-gallery-seed',
    description: '',
    originalFileName: FILE_NAME,
    isProfilePhoto: false,
    durationSeconds: 0,
  };
  const fields = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, enc(v)]));
  cy.request({
    method: 'POST',
    url: `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/media_files?documentId=${MEDIA_ID}`,
    headers: { ...OWNER, 'Content-Type': 'application/json' },
    body: { fields },
  });
}

function cleanupMediaDoc(): void {
  cy.request({
    method: 'DELETE',
    url: `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/media_files/${MEDIA_ID}`,
    headers: OWNER,
    failOnStatusCode: false,
  });
}

describe('gallery', () => {
  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here.

  before(() => seedMediaDoc());
  after(() => cleanupMediaDoc());

  beforeEach(() => {
    cy.signIn();
    cy.visit('/gallery');
    // The seeded row has landed: the tile's caption strip carries the file
    // name (`mediaCaption` falls back to it), present in the DOM even though
    // it is invisible at rest (see the CSS assertion below).
    cy.contains('.gallery__tile-caption-strip', FILE_NAME, { timeout: 10_000 }).should('exist');
  });

  it('#692 shows one filter pill row with per-type counts, and no caption text under a tile at rest', () => {
    // ONE pill row, not three labelled chip rows.
    cy.get('.gallery__pills[role="group"]').should('have.length', 1);
    // The mock's per-type counts: the type this row actually carries has a
    // real, positive count on its own pill.
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
    // beforeEach above already proved that) but invisible until hover or
    // focus. jsdom cannot see this (opacity is not a visibility check any
    // unit test can make), which is exactly why this assertion lives here.
    cy.contains('.gallery__tile-caption-strip', FILE_NAME).should('have.css', 'opacity', '0');
  });

  it('#755 draws the kit hero with the nav kicker and the mock-shaped title, and a tile that lifts', () => {
    cy.get('.den-heading .den-heading-kicker').should('have.text', 'The Den · Gallery');
    cy.get('.den-heading h1').should('have.text', 'All media');
    cy.get('.den-heading h1 .den-heading-accent').should('have.text', 'media');
    // The tile is the shared `lift` wearer; the delete control beside it is not.
    cy.contains('.gallery__cell', FILE_NAME).find('> .gallery__tile').should('have.class', 'lift');
    cy.contains('.gallery__cell', FILE_NAME).find('> .gallery__tile-actions button').should('not.have.class', 'lift');
  });
  it('#692 carries the count chip and the upload action in one heading row', () => {
    cy.get('.gallery__header-actions').within(() => {
      cy.get('.gallery__count-chip').should('exist');
      cy.get('.gallery__count-chip .gallery__count-chip-n')
        .invoke('text')
        .then((text) => expect(Number(text), 'header chip count').to.be.greaterThan(0));
      cy.contains('button', 'Upload media').should('exist');
    });
  });

  it('#692 offers a delete control on a tile, a sibling of the open button', () => {
    cy.contains('.gallery__cell', FILE_NAME).as('cell');
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
    cy.contains('.gallery__cell', FILE_NAME).should('exist');

    // Confirm: the callable is intercepted (this harness pins every callable
    // at a dead port, see docs/runbooks/e2e.md), and what is asserted is the
    // request the tile actually sends: the file's own id, with no entity
    // scope, because this global grid spans every household. Intercepted,
    // not real, which is also why the seeded row survives for any test that
    // runs after this one.
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
    cy.contains('.gallery__tile', FILE_NAME).click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('.dialog__title').should('have.text', FILE_NAME);
      cy.get('button.media-viewer__fullscreen-toggle').should('have.text', 'Fullscreen');
      cy.get('a.media-viewer__original')
        .should('have.text', 'Open original')
        .and('have.attr', 'href', PNG_DATA_URI)
        .and('have.attr', 'target', '_blank');
    });
  });
});
