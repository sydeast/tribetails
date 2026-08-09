import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The live preview in the Template Bank editor, driven in a real browser.
 *
 * WHAT THIS IS FOR. `account.welcome.business` has shipped for months ending
 * "See their account here: []". The account link is a literal pair of empty
 * brackets. Nothing in this admin ever RENDERED a template: the editor was a
 * Body textarea and an HTML textarea, so the only way to notice was to receive
 * the email. This spec drives the screen the way an operator does and asserts
 * the defect is now on screen where they will see it.
 *
 * It then types a merge field into the body and asserts the unresolved-field
 * warning appears. That is the LIVE half of "live preview": the pane tracking
 * the textarea keystroke by keystroke, plus the warning path, end to end in a
 * browser, with no jsdom in between.
 *
 * WHY THE CALLABLE IS STUBBED HERE. `e2e.firebase.json` declares no functions
 * emulator and `src/lib/firebase.ts` pins the Functions SDK at the unserved
 * `127.0.0.1:5399`, so every callable in an e2e run fails deliberately and
 * loudly (`CallableNotStubbedError`), which is what makes reaching production
 * structurally impossible. `lib/fns.ts` names the remedy in its own error
 * message: stub the callable in the spec with `page.route`. That is what this
 * does, following `e2e/visual/callableStubs.ts`, and it stubs exactly two reads
 * and nothing else, so anything this screen grows later still fails loud.
 *
 * The template row below is VERBATIM from
 * `mytribe/seeds/notificationTemplates/account.welcome.business/email.txt`,
 * including the `[]`. A stub that "fixed" the copy on the way through would
 * make this spec prove nothing.
 */

const WELCOME_BUSINESS_BODY = [
  "Good news: one of your invited Kinfolk just completed their MyTribe account setup. They're connected to your portal now.",
  '',
  "You're ready to start booking and sharing KinTales with them.",
  '',
  'See their account here: []',
].join('\n');

function corsHeaders(requested?: string): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers':
      requested !== undefined && requested !== ''
        ? requested
        : 'authorization, content-type, x-firebase-appcheck, x-firebase-client, x-firebase-gmpid',
    'access-control-max-age': '0',
  };
}

/** The two reads the Template Bank makes on first paint, and nothing else. */
const HANDLERS: Readonly<Record<string, () => unknown>> = {
  listTemplates: () => ({
    templates: [
      {
        templateId: 'account.welcome.business',
        subject: 'A Kinfolk just finished setting up',
        body: WELCOME_BUSINESS_BODY,
        html: null,
        title: 'Kinfolk finished setup',
        description: 'Sent to the business when an invited Kinfolk completes MyTribe setup.',
        tags: ['account'],
        category: 'Account',
        usageInstructions: 'Triggered by acceptInvite and setKinfolkClaim.',
        sectionDefinitions: [],
      },
    ],
    nextCursor: null,
  }),
  listCategories: () => ({ categories: ['Account'], schemaVersion: 1 }),
};

async function stubTemplateReads(page: Page): Promise<void> {
  await page.route('**/127.0.0.1:5399/**', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: corsHeaders(request.headers()['access-control-request-headers']),
      });
      return;
    }
    const segments = new URL(request.url()).pathname.split('/').filter((s) => s !== '');
    const handler = HANDLERS[segments[segments.length - 1] ?? ''];
    if (handler === undefined) {
      // Fall through to the unserved port, so an unstubbed callable still fails
      // loud rather than resolving as an invented empty answer.
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      // The callable envelope: the SDK unwraps `result`.
      body: JSON.stringify({ result: handler() }),
    });
  });
}

test.describe('Template Bank live preview', () => {
  test.beforeEach(async ({ page }) => {
    await stubTemplateReads(page);
    await page.goto('/templates');
  });

  test('shows the welcome template as a recipient receives it, empty link and all', async ({ page }) => {
    await page.getByRole('button', { name: /account\.welcome\.business/ }).click();

    const preview = page.getByRole('region', { name: 'Live preview' });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('A Kinfolk just finished setting up');
    // The defect, on screen. Nothing renders an account link, so the sentence
    // ends in the brackets that were meant to be replaced before it shipped.
    await expect(preview).toContainText('See their account here: []');
  });

  test('names a merge field the dispatch pipeline will not fill, as it is typed', async ({ page }) => {
    await page.getByRole('button', { name: /account\.welcome\.business/ }).click();

    const body = page.getByLabel('Body');
    await expect(page.getByRole('status')).toHaveCount(0);

    // `link` is emitter-supplied, not one of the twelve `enrichTemplateData.ts`
    // hydrates, so writing it here is a promise `acceptInvite` has to keep and
    // the preview says so.
    await body.fill(`${WELCOME_BUSINESS_BODY.replace('[]', '{{link}}')}`);
    await expect(page.getByRole('status')).toContainText('merge field');
    await expect(page.getByRole('status')).toContainText('link');
  });

  test('falls silent again once every merge field is one the pipeline fills', async ({ page }) => {
    await page.getByRole('button', { name: /account\.welcome\.business/ }).click();

    const body = page.getByLabel('Body');
    await body.fill('Hi {{kinfolkName}}, {{kinName}} is all set.');
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Live preview' })).toContainText('Sandy Wren');
  });
});
