import { expect, test } from '@playwright/test';

/**
 * The Directory's sub-views are real URLs, proved in a browser.
 *
 * This is the half no unit test can assert. `Directory.test.tsx` mocks
 * `useNavigate`, so it proves the screen ASKS to navigate; only a real router,
 * a real reload and a real Back press prove the address it asks for exists,
 * survives a fresh page load, and unwinds in the right order. Before this
 * change the profile was local state under an unchanged `/directory`, so a
 * reload dropped back to the list and Back left the screen entirely.
 *
 * `e2e-kf-1` (Wanda Thorne) is seeded by `seed.ts`.
 */

const KINFOLK_ID = 'e2e-kf-1';
const HOUSEHOLD = 'Wanda Thorne';

test('a household profile is linkable and survives a reload', async ({ page }) => {
  await page.goto(`/directory/${KINFOLK_ID}`);
  await expect(page.getByRole('button', { name: /back to directory/i })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(HOUSEHOLD);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(HOUSEHOLD);
  await expect(page).toHaveURL(new RegExp(`/directory/${KINFOLK_ID}$`));
});

test('opening a household from the list puts it in the URL, and Back returns to the list', async ({
  page,
}) => {
  await page.goto('/directory');
  await page.getByRole('button', { name: new RegExp(HOUSEHOLD, 'i') }).click();

  await expect(page).toHaveURL(new RegExp(`/directory/${KINFOLK_ID}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/directory$/);
  // Back lands on the LIST, not outside the screen: the card is here again.
  await expect(page.getByRole('button', { name: new RegExp(HOUSEHOLD, 'i') })).toBeVisible();
});

test('Members and invites is an anchor to its own route, and Back returns to the profile', async ({
  page,
}) => {
  await page.goto(`/directory/${KINFOLK_ID}`);

  const members = page.getByRole('link', { name: /members and invites/i });
  // A real anchor, which is what makes it middle-clickable and bookmarkable.
  await expect(members).toHaveAttribute('href', `/household-members/${KINFOLK_ID}`);
  await members.click();
  await expect(page).toHaveURL(new RegExp(`/household-members/${KINFOLK_ID}$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/directory/${KINFOLK_ID}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(HOUSEHOLD);
});
