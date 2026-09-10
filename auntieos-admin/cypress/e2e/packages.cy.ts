/**
 * Coverage Package Builder (`/packages`): the Start date opens on today and
 * the second "Visit menu" rate card is gone (#693, PR #728), and a fresh
 * quote auto-builds the Lean, Balance and Premium tiers again beside a
 * hand-built package (#694, PR #733).
 *
 * A SERVICE RATE IS SEEDED THROUGH A DIRECT FIRESTORE WRITE, not through
 * Settings. `e2e/seed.ts` carries no `business_settings` doc at all
 * (`getBusinessSettings` defaults `serviceRates` to `{}`), and the three
 * tiers only build when there is at least one priced visit-kind KinCare type
 * to sell (`buildDayPatterns`'s one precondition). An earlier version of this
 * file drove the real Settings > KinCare types form for this, and that is
 * what broke: `before` and `after` each sign in and visit a fresh page, and a
 * UI round trip through typing three fields, clicking Add, then Save, is more
 * surface than this setup step needs. This instead does what `gallery.cy.ts`
 * already does for its own setup: a PATCH straight past `firestore.rules`
 * with the emulator's owner bearer, the same bypass `e2e/seed.ts` uses to
 * wipe and reseed the whole database. `after` reads the document back and
 * removes only the one key this file added, never the whole map, in case a
 * concurrent local run has genuinely-set rates of its own.
 *
 * THE QUOTE ITSELF NEEDS NO CLEANUP. It lives in `localStorage`
 * (`tt-coverage-quote-v1`), which Cypress's default test isolation clears
 * before every test in this file, so each test opens on a genuinely fresh
 * quote without this spec touching storage itself.
 */

// A module, not a global script: this file's top-level constants must not
// collide with the same-named ones `gallery.cy.ts` and `schedule.cy.ts`
// declare for their own Firestore REST setup.
export {};

const FIRESTORE = 'http://127.0.0.1:8385';
const PROJECT = 'auntieos-ttpc';
const OWNER = { Authorization: 'Bearer owner' };
const BUSINESS_SETTINGS_URL = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/business_settings/business_settings`;

const STAMP = Date.now().toString(36);
const RATE_NAME = `E2E Dog Walk ${STAMP}`;
const RATE_DURATION_MIN = '30';
const RATE_PRICE = '25';

/** A Firestore REST string-keyed map field, `{ k: { stringValue: v } }` wrapped in a `mapValue`. */
function encodeStringMap(map: Record<string, string>): { mapValue: { fields: Record<string, { stringValue: string }> } } {
  return { mapValue: { fields: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { stringValue: v }])) } };
}

/** Reads `serviceRates`/`serviceDurations` off `business_settings/business_settings` as plain string maps, `{}` for either that is absent (a doc the seed never writes). */
function readServiceMaps(): Cypress.Chainable<{ serviceRates: Record<string, string>; serviceDurations: Record<string, string> }> {
  return cy
    .request({ method: 'GET', url: BUSINESS_SETTINGS_URL, headers: OWNER, failOnStatusCode: false })
    .then((resp) => {
      const fields = (resp.body?.fields ?? {}) as Record<string, { mapValue?: { fields?: Record<string, { stringValue?: string }> } }>;
      const readMap = (key: string): Record<string, string> => {
        const entries = fields[key]?.mapValue?.fields ?? {};
        return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.stringValue ?? '']));
      };
      return { serviceRates: readMap('serviceRates'), serviceDurations: readMap('serviceDurations') };
    });
}

/** Merges only `serviceRates`/`serviceDurations` into the doc (an `updateMask` PATCH), creating it if it does not exist yet, exactly as `saveBusinessSettings`'s `setDoc(..., { merge: true })` would for these two fields. */
function writeServiceMaps(serviceRates: Record<string, string>, serviceDurations: Record<string, string>): void {
  cy.request({
    method: 'PATCH',
    url: `${BUSINESS_SETTINGS_URL}?updateMask.fieldPaths=serviceRates&updateMask.fieldPaths=serviceDurations`,
    headers: { ...OWNER, 'Content-Type': 'application/json' },
    body: { fields: { serviceRates: encodeStringMap(serviceRates), serviceDurations: encodeStringMap(serviceDurations) } },
  });
}

describe('packages', () => {
  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here.

  before(() => {
    readServiceMaps().then(({ serviceRates, serviceDurations }) => {
      writeServiceMaps(
        { ...serviceRates, [RATE_NAME]: RATE_PRICE },
        { ...serviceDurations, [RATE_NAME]: RATE_DURATION_MIN },
      );
    });
  });

  after(() => {
    readServiceMaps().then(({ serviceRates, serviceDurations }) => {
      const nextRates = { ...serviceRates };
      const nextDurations = { ...serviceDurations };
      delete nextRates[RATE_NAME];
      delete nextDurations[RATE_NAME];
      writeServiceMaps(nextRates, nextDurations);
    });
  });

  it('#693 opens the Start date on today’s date', () => {
    cy.signIn();
    cy.visit('/packages');

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const expected = `${y}-${m}-${d}`;

    // Scoped by the PANEL'S OWN TITLE, not by a `.den-panel` containing the
    // word "Coverage window" anywhere: the Packages panel's own subtitle
    // reads "...packages price across this range", and `cy.contains` would
    // just as happily match that panel's `.cpb__noprint` ancestor first.
    cy.contains('.den-panel-title', 'Coverage window')
      .closest('.den-panel')
      .within(() => {
        cy.contains('.cpb__field', 'Start').find('input[type="date"]').should('have.value', expected);
      });
  });

  it('#693 has no Visit menu panel', () => {
    cy.signIn();
    cy.visit('/packages');

    cy.contains('Visit menu').should('not.exist');
    cy.contains('Restore defaults').should('not.exist');
  });

  it('#694 a fresh quote shows Lean, Balance and Premium package cards beside New package', () => {
    cy.signIn();
    cy.visit('/packages');

    // "New package" is unique text on this screen; no panel scoping needed,
    // and none is safe here (see the #693 comment above on why "Packages" as
    // a `.den-panel` match is ambiguous on this exact screen).
    cy.contains('button', 'New package').should('exist');

    cy.get('input[aria-label="Package name"]').should('have.length.at.least', 3);
    cy.get('input[aria-label="Package name"]').then(($inputs) => {
      const names = [...$inputs].map((el) => (el as HTMLInputElement).value);
      expect(names, 'seeded tier names').to.include.members(['Lean', 'Balance', 'Premium']);
    });
  });
});
