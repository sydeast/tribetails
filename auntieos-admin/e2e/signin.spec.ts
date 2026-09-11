import { expect, test } from '@playwright/test';
import { ADMIN, KINFOLK } from './fixtures/accounts';

/**
 * The admin gate, driven in a browser for the first time.
 *
 * `lib/access.test.ts` already covers `accessFromClaims` as a pure function, and
 * covers it well. What it cannot cover is the part that actually decides
 * whether an operator gets in: Firebase minting a token, the force-refresh in
 * `resolveAccess(user, true)` picking up the custom claim, the router's
 * `beforeLoad` guard reading the result, and `SignIn`'s effect signing a denied
 * user back out so the form stays usable. That chain has never run outside a
 * human's browser session, and every screen in this app sits behind it.
 *
 * The denial case matters most and is the reason a second seeded account
 * exists. AuntieOS and the MyTribe portal share ONE Firebase project, so a
 * kinfolk's portal credentials authenticate perfectly well here. The only thing
 * standing between them and the operator's console is the claim check.
 */

test('a wrong password is refused with a line the operator can act on', async ({ page }) => {
  await page.goto('/signin');

  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Jump back in!' }).click();

  await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
  // Not a raw `auth/invalid-credential`: `SignIn.authMessage` maps the code,
  // and this asserts the mapping is reached rather than only that something red
  // appeared.
  await expect(page).toHaveURL(/\/signin$/);
});

test('a kinfolk account authenticates and is still denied the admin app', async ({ page }) => {
  await page.goto('/signin');

  await page.getByLabel('Email').fill(KINFOLK.email);
  await page.getByLabel('Password', { exact: true }).fill(KINFOLK.password);
  await page.getByRole('button', { name: 'Jump back in!' }).click();

  await expect(
    page.getByText('This account does not have admin access.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/signin$/);

  // Denial must also SIGN THEM OUT, not only show a message. A session left
  // signed in would bounce off the router guard forever: reloading would put
  // them back in front of a screen they cannot use, with `SignIn`'s mount
  // effect re-deriving the same denial, and no way to try another account.
  // `signOutSilent` is what prevents that.
  //
  // ASSERTED THROUGH THE APP, not by reading storage. Firebase persists its
  // session to IndexedDB under an internal database name, so a storage probe
  // that goes looking in the wrong place reports "nothing there" and passes
  // whether or not the user was signed out. An earlier draft of this test did
  // exactly that against localStorage. Reloading and watching what the app
  // decides cannot pass for the wrong reason: a surviving session re-renders
  // the denial banner through SignIn's mount effect.
  await page.reload();
  await expect(page.getByLabel('Email')).toBeVisible();
  // A settling window is unavoidable for a "this does not happen" assertion:
  // the effect only runs once `onAuthStateChanged` has resolved, which is after
  // first paint. Two seconds is far longer than the emulator needs.
  await page.waitForTimeout(2000);
  await expect(
    page.getByText('This account does not have admin access.'),
    'the denied kinfolk was still signed in after a reload',
  ).toBeHidden();
});

test('the seeded admin gets in and lands on Home', async ({ page }) => {
  await page.goto('/signin');

  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Jump back in!' }).click();

  await page.waitForURL('**/home', { timeout: 30_000 });
  await expect(page.locator('.signin__card')).toHaveCount(0);
});
