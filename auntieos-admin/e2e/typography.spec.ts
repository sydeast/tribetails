import { expect, test } from '@playwright/test';

/**
 * The Fraunces regression, guarded in the only place it was ever visible.
 *
 * From the React port until 2026-07-25, `--font-fraunces` read
 * `'Fraunces', ui-serif, Georgia, serif`, while
 * `@fontsource-variable/fraunces` registers its `@font-face` under the family
 * name `Fraunces Variable`. Nothing declared `Fraunces`. So every serif heading
 * in the admin fell through to Georgia, on every screen, for the whole port,
 * while the real 121 KB face was downloaded on each page load and never once
 * drawn. `tokenUsage.test.ts` could not see it (the token existed and was
 * referenced correctly), and neither could any jsdom test, because jsdom has no
 * font loading and no text metrics.
 *
 * These tests are deliberately three different kinds of evidence, because each
 * one alone has a way of passing while the face is still absent:
 *   1. the family the CSS names is DECLARED by some @font-face;
 *   2. the heading's computed font-family actually resolves to it;
 *   3. the glyphs the browser drew are NOT the fallback's glyphs.
 * (1) alone passes if a rule forgets the token. (2) alone passes if the file
 * 404s. (3) is the only one that speaks for what the operator saw, and it is
 * the one that would have caught the original bug on day one.
 *
 * The sign-in screen is the subject because it is the one Fraunces heading
 * reachable without authenticating, so this file keeps working even if the auth
 * fixture breaks.
 */

/** Families that must be self-hosted, keyed by the token that names them. */
const REQUIRED_FACES = {
  '--font-fraunces': 'Fraunces Variable',
  '--font-hanken': 'Hanken Grotesk',
  '--font-mono': 'Spline Sans Mono',
} as const;

test.beforeEach(async ({ page }) => {
  await page.goto('/signin');
  await expect(page.locator('.signin__title')).toBeVisible();
  // Fonts are `font-display: swap`, so first paint can legitimately show the
  // fallback. Everything below asks what the page settled on, not what it
  // flashed.
  await page.evaluate(() => document.fonts.ready);
});

test('every brand family the tokens name is declared by an @font-face', async ({ page }) => {
  const declared = await page.evaluate(() =>
    // FontFace.family arrives with the quoting the @font-face used; strip it so
    // 'Hanken Grotesk' and "Hanken Grotesk" compare equal.
    [...document.fonts].map((f) => f.family.replace(/^['"]|['"]$/g, '')),
  );

  for (const [token, family] of Object.entries(REQUIRED_FACES)) {
    expect(
      declared,
      `${token} names "${family}" first, but no @font-face declares it, so every rule using that token silently renders in the fallback`,
    ).toContain(family);
  }
});

test('each font token names a declared family FIRST, not behind a fallback', async ({ page }) => {
  const resolved = await page.evaluate((tokens: string[]) => {
    const root = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const t of tokens) {
      const first = root.getPropertyValue(t).split(',')[0] ?? '';
      out[t] = first.trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  }, Object.keys(REQUIRED_FACES));

  // First position is the whole point. `'Fraunces', 'Fraunces Variable', serif`
  // would satisfy the declaration test above and still render Georgia, because
  // the browser takes the first family it can resolve and 'Fraunces' resolves
  // to nothing.
  expect(resolved).toEqual({ ...REQUIRED_FACES });
});

test('the sign-in heading resolves to Fraunces and is loaded', async ({ page }) => {
  const heading = page.locator('.signin__title');

  const family = await heading.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family.replace(/^['"]|['"]$/g, '')).toMatch(/^['"]?Fraunces Variable['"]?/);

  // `FontFaceSet.check` answers "would this exact font shorthand render from a
  // loaded face". It is asked with the heading's OWN computed weight and size
  // rather than a guess, so a weight the variable font does not cover would
  // fail here instead of quietly synthesizing.
  const loaded = await heading.evaluate((el) => {
    const cs = getComputedStyle(el);
    return document.fonts.check(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`);
  });
  expect(loaded, 'Fraunces Variable is named but not loaded: the face 404d or never downloaded').toBe(true);
});

test('the sign-in heading draws Fraunces glyphs, not the Georgia fallback', async ({ page }) => {
  const metrics = await page.locator('.signin__title').evaluate((el) => {
    const cs = getComputedStyle(el);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    const sample = 'AuntieOS Handgloves 0123';
    const measure = (family: string): number => {
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${family}`;
      return ctx.measureText(sample).width;
    };
    return {
      actual: measure(cs.fontFamily),
      fallback: measure('Georgia, serif'),
      text: el.textContent ?? '',
    };
  });

  expect(metrics.text).toBe('AuntieOS');
  expect(metrics.actual).toBeGreaterThan(0);
  // THE ASSERTION THAT WOULD HAVE CAUGHT IT. When the token named an undeclared
  // family the two measurements were identical, because the second entry in the
  // list the heading resolved through was Georgia. Any real face differs from
  // Georgia by more than a rounding error at this size.
  expect(
    Math.abs(metrics.actual - metrics.fallback),
    `the heading measures the same as Georgia (${metrics.actual}px), so it IS Georgia and Fraunces never rendered`,
  ).toBeGreaterThan(1);
});
