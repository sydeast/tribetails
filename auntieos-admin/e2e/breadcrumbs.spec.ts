import { expect, test } from '@playwright/test';

/**
 * The Den breadcrumb trail (`DenBreadcrumbs`), driven through the real router.
 *
 * WHY A BROWSER, given the unit coverage: the whole design question here is
 * which crumbs can be `<Link>`s and which have to be buttons, and jsdom cannot
 * answer it. Half of these destinations are sibling VIEWS rather than routes,
 * so a `<Link to="/directory">` rendered while the address bar already says
 * `/directory` is a control that looks live, announces itself as a link, and
 * does nothing when clicked. Only a real router resolves that, and only a real
 * click proves it. Every test below is therefore about the ADDRESS BAR or about
 * the screen actually changing, not about the markup.
 */

const HOUSEHOLD_ID = 'e2e-kf-1';
const HOUSEHOLD_NAME = 'Wanda Thorne';
/** `vis-kin-1` in `seed.rows.ts`, whose `kinfolkId` is HOUSEHOLD_ID. */
const KIN_NAME = 'Biscuit';

function trail(page: import('@playwright/test').Page) {
  return page.getByRole('navigation', { name: 'Breadcrumb' });
}

test('the members deep link trails back to the Directory list', async ({ page }) => {
  await page.goto(`/household-members/${HOUSEHOLD_ID}`);

  const crumbs = trail(page);
  await expect(crumbs).toBeVisible();
  await expect(crumbs.getByRole('listitem')).toHaveCount(3);

  // The page you are on is not a link, and says so out loud.
  await expect(crumbs.getByText('Members and invites')).toHaveAttribute('aria-current', 'page');
  await expect(crumbs.getByRole('link', { name: 'Members and invites' })).toHaveCount(0);

  // This mount IS a route, so its Directory step is a real anchor: middle-click
  // it, copy it, open it in a tab.
  const directory = crumbs.getByRole('link', { name: 'Directory' });
  await expect(directory).toHaveAttribute('href', '/directory');
  await directory.click();
  await expect(page).toHaveURL(/\/directory$/);
});

/**
 * #1589: `/household-members/` carries only an id, and the walk found the
 * title, avatar and breadcrumb reading that database id. The route now reads
 * the household and names it, so a cold deep link shows the household's name
 * and never its id.
 *
 * The step is a `link`, not a button: this mount IS a route, so the household
 * step goes to a real `/directory/{id}` address, the same as the Directory
 * step above.
 */
test('a cold members deep link names the household, never its id (#1589)', async ({ page }) => {
  await page.goto(`/household-members/${HOUSEHOLD_ID}`);
  const householdStep = trail(page).getByRole('link', { name: HOUSEHOLD_NAME });
  await expect(householdStep).toBeVisible();
  await expect(householdStep).toHaveAttribute('href', `/directory/${HOUSEHOLD_ID}`);
  await expect(trail(page).getByText(HOUSEHOLD_ID)).toHaveCount(0);
});

test('the household profile trails back to the Directory list', async ({ page }) => {
  await page.goto(`/directory/${HOUSEHOLD_ID}`);

  const crumbs = trail(page);
  await expect(crumbs.getByText(HOUSEHOLD_NAME)).toHaveAttribute('aria-current', 'page');

  // An anchor here, because the profile only ever mounts under this route.
  await expect(crumbs.getByRole('link', { name: 'Directory' })).toHaveAttribute(
    'href',
    '/directory',
  );
  await crumbs.getByRole('link', { name: 'Directory' }).click();
  await expect(page).toHaveURL(/\/directory$/);
  await expect(page.getByRole('tab', { name: /^Kinfolk/ })).toBeVisible();
});

/**
 * The case that decided the API. A kin card opens `KinView` as a sibling view
 * of the list with no navigation at all, so this trail is rendered AT
 * `/directory` with a Directory step that points at `/directory`. As a `<Link>`
 * that click would have been a no-op and the operator would still be staring at
 * the pet. The household step beside it IS a link, because it goes somewhere.
 */
test('the trail escapes a kin opened without changing the URL', async ({ page }) => {
  await page.goto('/directory');
  await page.getByRole('tab', { name: /^Kin(\s|·|$)/ }).click();
  await page.getByRole('button', { name: new RegExp(KIN_NAME) }).click();

  const crumbs = trail(page);
  await expect(crumbs.getByText(KIN_NAME)).toHaveAttribute('aria-current', 'page');
  await expect(crumbs.getByRole('link', { name: HOUSEHOLD_NAME })).toHaveAttribute(
    'href',
    `/directory/${HOUSEHOLD_ID}`,
  );
  await expect(page).toHaveURL(/\/directory$/);

  await crumbs.getByRole('button', { name: 'Directory' }).click();
  await expect(trail(page)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Kinfolk/ })).toBeVisible();
});

/**
 * And the kicker it replaced. "THE DEN · DIRECTORY" read the same on the list
 * and three levels down, which is the complaint this item answers, so the list
 * keeps it and the nested screen must not.
 */
test('the list keeps its kicker and the nested screen swaps it for the trail', async ({ page }) => {
  await page.goto('/directory');
  await expect(page.locator('.den-heading-kicker')).toHaveText(/The Den . Directory/);
  await expect(trail(page)).toHaveCount(0);

  await page.goto(`/directory/${HOUSEHOLD_ID}`);
  await expect(trail(page)).toBeVisible();
  await expect(page.locator('.den-heading-kicker')).toHaveCount(0);
});
