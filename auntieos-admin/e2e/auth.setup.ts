import { expect, test as setup } from '@playwright/test';
import { ADMIN } from './fixtures/accounts';

const STATE = 'e2e/.auth/operator.json';

/**
 * Signs the operator in ONCE and saves the session for the `operator` project.
 *
 * IT DRIVES THE REAL FORM rather than poking a token into storage. The gate is
 * not `signInWithEmailAndPassword` on its own: `SignIn.doSignIn` then calls
 * `resolveAccess(user, true)`, which force-refreshes the ID token, reads the
 * custom claims, and pins `setTestScope`. Fabricating a storageState would skip
 * every one of those steps and leave the harness unable to fail on the thing
 * most likely to break, which is claim propagation.
 *
 * The forced refresh is also why this cannot be replaced by a faster fixture:
 * a token minted before the claim was written carries no claim, which is the
 * portal's O-37 lesson, and this is the only place in the suite that proves the
 * admin app survives it.
 */
setup('operator signs in', async ({ page }) => {
  await page.goto('/signin');

  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The route change is the gate's verdict. Asserting on it, rather than on
  // "no error banner appeared", means a denial cannot pass as a pass.
  await page.waitForURL('**/home', { timeout: 30_000 });
  await expect(page.locator('.signin__card')).toHaveCount(0);

  // `indexedDB: true` IS REQUIRED, not a tuning option. The Firebase Auth web
  // SDK persists its session to IndexedDB (`firebaseLocalStorageDb`), and
  // Playwright's storageState captures only cookies and localStorage unless
  // asked for IndexedDB as well. Without it the file is written, is accepted
  // without complaint, restores nothing, and every dependent spec lands on the
  // sign-in form instead of the screen it asked for. That is what the first run
  // of this harness did.
  await page.context().storageState({ path: STATE, indexedDB: true });
});
