import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards how the rest of the app CONSUMES the tokens. `tokens.test.ts` guards
 * what tokens.css declares; this file guards every other stylesheet's
 * references to them, which is where the 2026-07-25 audit found the real damage.
 *
 * Two rules, both learned from bugs that shipped:
 *
 * 1. NO REFERENCE TO A TOKEN NOTHING DECLARES. Eleven such tokens were live:
 *    `--color-surface-raised`, `--color-surface-sunken`, `--color-error-soft`,
 *    `--color-accent-soft`, `--color-on-primary`, `--color-bg`, `--color-teal`,
 *    `--font-display`, `--tracking-mono`, and `--type-label-family` / `-size` /
 *    `-tracking` (the real names carry an `-md`/`-sm` step). Each silently took
 *    its literal fallback, or nothing at all where there was no fallback, so
 *    `.tribal-form__chip:hover` had no hover colour and the vet clinic and
 *    address field labels rendered with no face, size, or tracking.
 *
 * 2. NO LITERAL FALLBACK ON A THEME TOKEN. `var(--color-x, #hex)` cannot be
 *    right in both schemes: the literal is one theme's value at best, and it
 *    hides a wrong token name behind a plausible colour. That is exactly how
 *    `body { color: var(--color-primary, #1a1c28) }` survived, painting every
 *    unstyled element Kinfolk Orange while the fallback recorded that navy was
 *    intended, and how 20 uses of `var(--color-secondary, #5a5c6a)` rendered
 *    Pack Pink as muted grey. 146 stale fallbacks were stripped on 2026-07-25.
 *
 * Fallbacks on tokens set at RUNTIME per element are fine and are not flagged:
 * `--den-tone`, `--avatar-gradient` and friends are declared by a component on
 * itself, so a consumer that has not been given one needs a default.
 *
 * HOW THE SUITES BELOW ARE BUILT: wherever a shared class or token has
 * adopters, the adopter set is DISCOVERED by scanning the sources, never kept
 * as a list. This file used to carry ledgers (seven lift adopters, seven
 * wearer strings, three staggered screens) and changed five times in eighty
 * commits keeping them current, and a test every new screen must edit is a
 * test that gets edited on autopilot. What stays written down is only what a
 * scan cannot know: which two surfaces are ALLOWED the brand gradient
 * (exclusivity is the rule), and what the bundler's emit order decides (the
 * `.signin .signin__card` pin). A new screen that follows the rules changes
 * nothing here; one that breaks them fails here.
 */

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(stylesDir);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith('.css') ? [full] : [];
  });
}

const FILES = cssFiles(srcDir);
const rel = (f: string) => f.slice(srcDir.length + 1);

/** Every custom property declared anywhere in the CSS, plus those set from TS. */
const declared = new Set<string>();
for (const f of FILES) {
  for (const m of readFileSync(f, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]!);
}
for (const f of tsFiles(srcDir)) {
  // Components set custom properties as string keys, e.g. `'--avatar-size'`.
  for (const m of readFileSync(f, 'utf8').matchAll(/'(--[a-z0-9-]+)'/g)) declared.add(m[1]!);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

/** Markup that can put a class on an element. Tests are excluded: a test that
 *  NAMES a class is not an element that WEARS it. */
const TSX_FILES = tsFiles(srcDir).filter(
  (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'),
);

/**
 * The class tokens a TSX file puts on elements, one token list per line: every
 * string literal on a line that mentions `className`, split on whitespace.
 * Loose on purpose (it reads plain attributes, template literals and the
 * conditional-array form alike), while comments that merely DISCUSS a class
 * stay out because they never say `className`. This scan is how adopters of a
 * shared class are DISCOVERED below, instead of being listed by hand: the old
 * ledgers of adopter files were why every new screen had to edit this test.
 */
function classTokenLines(file: string): string[][] {
  const out: string[][] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('className')) continue;
    const tokens: string[] = [];
    for (const m of line.matchAll(/["'`]([^"'`]*)["'`]/g)) {
      tokens.push(...m[1]!.split(/\s+/).filter(Boolean));
    }
    if (tokens.length > 0) out.push(tokens);
  }
  return out;
}

const classTokens = (file: string) => new Set(classTokenLines(file).flat());

/** Tokens tokens.css owns: the global design system, as opposed to per-component locals. */
const globalTokens = new Set(
  [...readFileSync(join(stylesDir, 'tokens.css'), 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)].map(
    (m) => m[1]!,
  ),
);

interface Ref {
  file: string;
  line: number;
  name: string;
  hasFallback: boolean;
}

/** Every `var(...)` reference in every stylesheet, with its fallback presence. */
function references(): Ref[] {
  const out: Ref[] = [];
  for (const f of FILES) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,?)/g)) {
          out.push({ file: rel(f), line: i + 1, name: m[1]!, hasFallback: m[2] === ',' });
        }
      });
  }
  return out;
}

const REFS = references();

describe('token usage across every stylesheet', () => {
  it('has stylesheets to check (guards the walker itself)', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(REFS.length).toBeGreaterThan(500);
  });

  it('never references a custom property nothing declares', () => {
    const missing = REFS.filter((r) => !declared.has(r.name)).map(
      (r) => `${r.file}:${String(r.line)} -> ${r.name}`,
    );
    expect(missing).toEqual([]);
  });

  it('never gives a global design token a literal fallback', () => {
    // A theme token resolves differently per scheme; a baked-in literal can only
    // ever match one of them, and it disguises a wrong token name as a working
    // colour. tokens.css itself is exempt: it is where defaults belong.
    const withFallback = REFS.filter(
      (r) => r.hasFallback && globalTokens.has(r.name) && r.file !== 'styles/tokens.css',
    ).map((r) => `${r.file}:${String(r.line)} -> var(${r.name}, ...)`);
    expect(withFallback).toEqual([]);
  });
});

describe('the specific mis-wirings found on 2026-07-25', () => {
  it('body text follows the text token, never the orange brand token', () => {
    const base = readFileSync(join(stylesDir, 'base.css'), 'utf8');
    const body = base.slice(base.indexOf('body {'), base.indexOf('}', base.indexOf('body {')));
    expect(body).toContain('color: var(--color-text-primary)');
    expect(body).not.toContain('color: var(--color-primary)');
  });

  it('never uses --color-secondary as a text colour (it is Pack Pink, not grey)', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (rel(f) === 'styles/tokens.css') continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/(^|[^-])color:\s*var\(--color-secondary\)/.test(line)) {
            offenders.push(`${rel(f)}:${String(i + 1)}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('leaves the rail links interactive', () => {
    const shell = readFileSync(join(stylesDir, 'shell.css'), 'utf8');
    expect(shell).toContain('.shell__link:hover');
    expect(shell).toContain('.shell__link:focus-visible');
    // `cursor: default` belongs only on the not-yet-built destinations.
    expect(shell).toMatch(/\.shell__link--pending\s*\{[^}]*cursor:\s*default/);
  });
});

describe('Fraunces actually renders', () => {
  const tokens = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');
  const main = readFileSync(join(srcDir, 'main.tsx'), 'utf8');
  const base = readFileSync(join(stylesDir, 'base.css'), 'utf8');

  it('names the family @fontsource-variable registers, not the one it does not', () => {
    // The package declares `font-family: 'Fraunces Variable'`. This token said
    // 'Fraunces', which nothing declares, so every serif heading in the admin
    // fell through to Georgia from the port until 2026-07-25. The face was
    // downloaded on every page load and never used.
    const family = tokens.match(/--font-fraunces:\s*([^;]+);/)?.[1] ?? '';
    expect(family).toMatch(/^'Fraunces Variable'/);
  });

  it('loads the axis-carrying stylesheet, not the wght-only default', () => {
    // `@fontsource-variable/fraunces` alone ships wght only; SOFT and WONK,
    // which are the axes the mocks set, live in /full.css.
    expect(main).toContain("@fontsource-variable/fraunces/full.css");
    expect(main).not.toMatch(/from '@fontsource-variable\/fraunces'|import '@fontsource-variable\/fraunces';/);
  });

  it('applies the variable axes once, inheritably, from body', () => {
    expect(tokens).toMatch(/--type-serif-variation:\s*'SOFT' 50, 'WONK' 1;/);
    expect(base).toContain('font-variation-settings: var(--type-serif-variation)');
  });

  it('leaves wght out of the variation settings so font-weight still governs weight', () => {
    const variation = tokens.match(/--type-serif-variation:\s*([^;]+);/)?.[1] ?? '';
    expect(variation.toLowerCase()).not.toContain('wght');
  });
});

describe('the Den entrance and ambient wash', () => {
  const base = readFileSync(join(stylesDir, 'base.css'), 'utf8');

  it('declares the rise keyframe and all four stagger steps', () => {
    expect(base).toContain('@keyframes rise');
    for (const step of ['.d1', '.d2', '.d3', '.d4']) {
      expect(base).toContain(`${step} {`);
    }
  });

  it('fills the rise animation BOTH ways so a delayed block is never mid-flash', () => {
    // Without `both`, an element sits at full opacity through its own delay and
    // then snaps back to invisible to start animating.
    expect(base).toMatch(/animation: rise var\(--dur-rise\)[^;]*both;/);
  });

  it('guards reduced motion globally rather than per file', () => {
    // Per-file guards mean every new animation has to remember to opt in, and
    // before 2026-07-25 only 8 of 79 stylesheets did.
    const guard = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(guard).toContain('animation: none !important');
    expect(guard).toMatch(/\*,\s*\*::before,\s*\*::after/);
  });

  it('gives the orbs radial falloff, a blend mode, and motion', () => {
    const orbs = base.slice(base.indexOf('.orb {'));
    expect(orbs).toContain('mix-blend-mode');
    expect(orbs).toContain('animation: orb-drift');
    expect(orbs).toContain('@keyframes orb-drift');
    for (const orb of ['.orb.a', '.orb.b', '.orb.c']) {
      expect(orbs).toMatch(new RegExp(`\\${orb} \\{[^}]*radial-gradient`));
    }
  });

  it('starts the orbs out of phase, or the wash pulses instead of drifting', () => {
    const orbs = base.slice(base.indexOf('.orb {'));
    expect([...orbs.matchAll(/animation-delay:\s*-\d+s/g)]).toHaveLength(2);
  });

  it('renders three orbs, since two of three brand hues is not the Tribe palette', () => {
    const router = readFileSync(join(srcDir, 'router.tsx'), 'utf8');
    for (const cls of ['orb a', 'orb b', 'orb c']) {
      expect(router).toContain(`className="${cls}"`);
    }
    // Decorative only. They must never reach the accessibility tree.
    expect([...router.matchAll(/className="orb [abc]" aria-hidden="true"/g)]).toHaveLength(3);
  });

  it('lays the grain sheet over the wash, in the markup and in the stylesheet', () => {
    // The other half of the mocks' ground (#751), and the half the admin never
    // had: three enormous blurred discs with no noise over them read as a flat
    // gradient. All four decorations sit at the same z-index, so the grain
    // coming LAST in RootLayout is the whole of how it lands over the orbs and
    // still under the screen.
    const router = readFileSync(join(srcDir, 'router.tsx'), 'utf8');
    expect(router).toContain('className="grain" aria-hidden="true"');
    expect(router.indexOf('className="grain"')).toBeGreaterThan(
      router.indexOf('className="orb c"'),
    );

    const grain = base.slice(base.indexOf('.grain {'));
    expect(grain).toContain('position: fixed');
    expect(grain).toContain('opacity: 0.05');
    expect(grain).toContain('feTurbulence');
  });

  it('mutes the wash only where the cream scheme is asked for by name', () => {
    // This rule read `:root:not([data-theme='dark'])` while cream was the
    // default, and that form became a trap the moment navy became the default:
    // it matches every document NOT carrying the attribute, so it would
    // multiply the wash down to a quarter wherever the attribute is missing,
    // jsdom included. Scoped to the opt-in attribute, it matches nothing today.
    expect(base).toContain("[data-theme='light'] .orb");
    expect(base).not.toContain(":root:not([data-theme='dark'])");
  });

  it('staggers gaplessly from d1 on every screen that takes the entrance', () => {
    // Home, Directory and KinTales are the surfaces the 2026-07-25 audit picked
    // as worth the entrance; a screen with no `d*` class hard-cuts into place,
    // which is fine for the ones the audit skipped. WHO staggers is discovered
    // by the class scan, so the next screen that opts in edits nothing here.
    // What is held instead: the steps a screen wears must run d1, d2, ... with
    // no hole, because a lone d3 is a block that sits invisible for 0.18s
    // waiting on siblings that do not exist; and at least the audit's three
    // must keep the entrance alive, because fewer means a screen was quietly
    // un-staggered, not that a rule was followed.
    const stagger = TSX_FILES.map((f) => ({
      file: rel(f),
      steps: [...classTokens(f)].filter((t) => /^d[1-4]$/.test(t)).sort(),
    })).filter((s) => s.steps.length > 0);

    expect(stagger.length).toBeGreaterThanOrEqual(3);
    for (const { file, steps } of stagger) {
      expect(steps, `${file} staggers with a hole in the sequence`).toEqual(
        ['d1', 'd2', 'd3', 'd4'].slice(0, steps.length),
      );
    }
  });

  it('tints the orbs from role tokens so the wash follows the theme', () => {
    const orbs = base.slice(base.indexOf('.orb {'), base.indexOf('@keyframes orb-drift'));
    // `.orb.b` used to name `--color-teal`, which nothing declares, so it took a
    // literal and was the one element on the page that ignored dark mode.
    //
    // The three hues are the mocks' own since #751: orange, teal, pink, running
    // out from the top-left corner. Purple is not in the mocks' mesh, and the
    // orange belongs at the corner the hero band lights from.
    expect(orbs).toContain('var(--color-primary)');
    expect(orbs).toContain('var(--color-accent)');
    expect(orbs).toContain('var(--color-secondary)');
    expect(orbs).not.toContain('var(--color-tertiary)');
  });
});

describe('the panel and the hero are the mocks glass, not a flat tint', () => {
  const kit = readFileSync(join(srcDir, 'components', 'DenScreenKit.css'), 'utf8');
  const block = (selector: string) =>
    kit.slice(kit.indexOf(`${selector} {`), kit.indexOf('}', kit.indexOf(`${selector} {`)));

  it('draws the panel as the mocks 160deg navy gradient on a hairline', () => {
    // A flat `--color-surface-glass` fill is what made a panel read as a card
    // laid on the page rather than as glass cut out of it.
    const panel = block('.den-panel');
    expect(panel).toContain(
      'linear-gradient(160deg, var(--color-panel-top), var(--color-panel-bottom))',
    );
    expect(panel).toContain('var(--color-hairline)');
    expect(panel).toContain('border-radius: var(--radius-lg)');
    expect(panel).toContain('padding: 22px');
  });

  it('gives the hero band the radial orange wash over the same gradient', () => {
    const hero = block('.den-heading');
    expect(hero).toContain('radial-gradient');
    expect(hero).toContain('var(--tt-kinfolk-orange)');
    expect(hero).toContain('border-radius: var(--radius-hero)');
  });

  it('carries NO backdrop-filter, which is the mocks own choice', () => {
    // Not one of the 29 mocks uses it. The gradient's lower stop is already
    // translucent, so the ground reads through the bottom of every panel, and a
    // blur over that greys the wash instead of letting it show.
    // A DECLARATION, so the comment in the stylesheet explaining the rule does
    // not trip the rule.
    expect(kit).not.toMatch(/backdrop-filter\s*:/);
  });

  it('rises with backwards fill, never both, so a panel that lifts can still lift', () => {
    // `both` leaves the last keyframe's `transform: translateY(0)` applied for
    // good, and an animation declaration outranks any author rule, so
    // `.lift:hover { transform: ... }` would never move the card again.
    // `backwards` covers the delay and then hands the element back.
    for (const selector of ['.den-panel', '.den-heading']) {
      expect(block(selector), `${selector} does not rise`).toMatch(
        /animation: rise var\(--dur-rise\)[^;]*backwards/,
      );
    }
    expect(kit).not.toMatch(/animation: rise[^;]*\bboth\b/);
  });

  it('pins the stagger at two classes, so the bundler cannot decide the delay', () => {
    // `.d1` in base.css sets the whole `animation` shorthand, which resets both
    // the delay and the fill mode declared on `.den-panel`. Whichever sheet the
    // bundler emits second would otherwise win, so the overrides are 0,2,0.
    for (const step of ['d1', 'd2', 'd3', 'd4']) {
      expect(kit).toContain(`.den-panel.${step}`);
    }
    expect(kit).toMatch(/\.den-panel\.d4,?\s*\{[^}]*animation-fill-mode: backwards/);
  });

  it('gives the status pill one tone-driven rule instead of one rule per state', () => {
    // The mocks' `.statuspill`. Four screens drew their own version of this in
    // four sizes; the kit owns it now and mixes every value from `--den-tone`.
    const pill = block('.den-statuspill');
    expect(pill).toContain('text-transform: uppercase');
    expect(pill).toContain('var(--type-label-sm-family)');
    expect(pill).toContain('var(--den-tone)');
  });
});

describe('the brand gradient renders somewhere real', () => {
  const signin = readFileSync(join(stylesDir, 'signin.css'), 'utf8');
  const kit = readFileSync(join(srcDir, 'components', 'DenScreenKit.css'), 'utf8');

  /** `var(--gradient-tribe)` uses only, so a mention inside a comment never counts. */
  const uses = (css: string) => [...css.matchAll(/var\(--gradient-tribe\)/g)].length;

  it('renders THE Tribe Gradient full bleed behind the sign-in screen', () => {
    // Before 2026-07-25 the primary brand mark appeared in exactly ONE place in
    // the app: the seed array in Avatar.tsx, which is 42px behind a set of
    // initials. tokens.css has called it "the primary brand mark" the whole time.
    expect(signin).toMatch(/\.signin::before\s*\{[^}]*position:\s*fixed;[^}]*/);
    expect(signin).toMatch(/\.signin::before\s*\{[^}]*background:\s*var\(--gradient-tribe\)/);
  });

  it('keeps the sign-in form OFF the gradient by making the card opaque', () => {
    // The gradient is chrome. GlassSurface fills with `--color-surface-glass`,
    // 0.8 alpha in light and 0.6 in dark; left translucent over a brand gradient
    // it tints both field labels and both inputs.
    expect(signin).toMatch(/\.signin__card\s*\{[^}]*background:\s*var\(--color-surface\);/);
    // And the override has to WIN. `.glass-surface` sets that fill at one class,
    // and Vite emits GlassSurface.css after this file, so a one-class selector
    // ties and loses on order. The card was translucent over the gradient until
    // the built bundle was read.
    //
    // PINNED, not derived, deliberately: whether `.signin__card` beats
    // `.glass-surface` is decided by which file the bundler emits second, and
    // no scan of the SOURCES can see the bundle's emit order. The two-class
    // selector is the fix; naming it here is the only way to hold it.
    expect(signin).toMatch(/\.signin \.signin__card\s*\{/);
  });

  // NO HOME HERO, and that is settled, not missing. The 2026-07-25 audit named
  // "the sign-in panel and the Home hero stat" as the pair. `Home.tsx` renders
  // no StatCard at all: it is a heading plus seven DenPanel widgets. Adding one
  // is the React Port Restoration plan's Phase 3 Task 3.2, which owns the Home
  // layout rewrite. `.den-stat--feature` IS the hero-stat moment, it renders on
  // seven screens, one card per screen and only when the number is worth
  // featuring, so the audit's intent is met. Do not go looking for a Home hero.
  it('renders it on the hero stat, over the tone wash already there', () => {
    expect(kit).toMatch(/\.den-stat--feature::before\s*\{[^}]*background:\s*var\(--gradient-tribe\)/);
    // The radial tone wash is the hook, not the replacement. Both must survive.
    expect(kit).toMatch(/\.den-stat--feature\s*\{[^}]*radial-gradient/);
  });

  it('holds the hero-stat layer under the value rather than over it', () => {
    const layer = kit.slice(kit.indexOf('.den-stat--feature::before'));
    expect(layer).toMatch(/z-index:\s*-1;/);
    expect(layer).toMatch(/opacity:\s*0\.\d+;/);
    // A stacking context on the card, or the negative layer escapes to the page.
    expect(kit).toMatch(/\.den-stat--feature\s*\{[^}]*isolation:\s*isolate/);
  });

  it('stays a MARK: two surfaces carry it, and everyone else comes up empty', () => {
    // "Reserved for hero and CTA moments" (tokens.css). A brand gradient on
    // every panel is wallpaper, not a mark. Sign-in carries it twice, the
    // full-bleed wash and the card's cap; the hero stat carries it once.
    expect(uses(signin)).toBe(2);
    expect(uses(kit)).toBe(1);

    // Offenders are DISCOVERED, not listed: every stylesheet in the app is
    // scanned (screen, component and shared sheet alike, where the old check
    // read only screens/),
    // and anything outside the two carriers that names the gradient fails here
    // without this test growing a ledger. The carrier list is the one thing
    // that stays written down, because exclusivity IS the rule being pinned: a
    // third surface must show up here as a deliberate edit, never as drift.
    const carriers = new Set(['styles/signin.css', 'components/DenScreenKit.css']);
    const offenders = FILES.filter((f) => !carriers.has(rel(f)))
      .filter((f) => uses(readFileSync(f, 'utf8')) > 0)
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('the shared card lift', () => {
  const base = readFileSync(join(stylesDir, 'base.css'), 'utf8');

  /**
   * Who lifts is DISCOVERED from the markup, never listed. This block used to
   * carry two ledgers (seven adopter stylesheets and seven wearer strings),
   * and keeping them current was an edit to this file for every screen that
   * shipped. The class scan is the contract now: put `lift` on a clickable
   * card and every rule below adopts it unprompted.
   */
  const wearers = TSX_FILES.filter((f) => classTokens(f).has('lift'));

  /** A wearer's co-located stylesheet, where one exists: the sheets that used
   *  to re-state the lift, and the ones a per-file motion guard would hide in. */
  const adopterSheets = wearers
    .map((f) => f.replace(/\.tsx$/, '.css'))
    .filter((f) => existsSync(f));

  it('declares the lift once, as a utility class, with both the rise and the shadow', () => {
    expect(base).toMatch(/\.lift:hover,\s*\.lift:focus-visible\s*\{[^}]*transform:\s*var\(--lift-rise\)/);
    expect(base).toMatch(/\.lift:hover,\s*\.lift:focus-visible\s*\{[^}]*box-shadow:\s*var\(--lift-shadow\)/);
    expect(base).toMatch(/--lift-rise:\s*translateY\(-3px\)/);
    // The mocks' shadow geometry, which shipped in 8 of 79 stylesheets and on no
    // card at all.
    expect(base).toMatch(/--lift-shadow:\s*0 16px 36px -22px/);
  });

  it('carries its own reduced-motion guard, since a hover lift is not an animation', () => {
    // The global rule kills `animation` and shortens `transition-duration`.
    // Neither removes a `transform` applied on :hover: without this the card
    // still jumps 3px, it just does it instantly.
    const guard = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(guard).toMatch(/--lift-rise:\s*none/);
    expect(guard).toMatch(/--lift-transition:\s*none/);
  });

  it('is the only place the distance and the shadow are written down', () => {
    const offenders = FILES.filter((f) => rel(f) !== 'styles/base.css')
      .filter((f) => /translateY\(-3px\)|36px -22px/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('is worn as a CLASS by every clickable card, not copied into each stylesheet', () => {
    // The first pass at this had the values in one place and the RULES in four,
    // which is most of what the utility was for. The class is on the element,
    // so `.lift:hover` is the only rule in the app that lifts anything. Seven
    // surfaces wear it today: the stat card plus the clickable row or card on
    // six screens. The floor is what keeps that from quietly eroding to zero:
    // it moves down only when a lifting screen is deliberately deleted, and a
    // new adopter raises the count without touching this file.
    expect(wearers.length).toBeGreaterThanOrEqual(7);
    // Scanner self-test: the stat card wears the class inside a template
    // literal, so if the className reader ever goes plain-strings-only it
    // fails loudly here instead of every scan below going quietly emptier.
    expect(wearers.map(rel)).toContain('components/DenScreenKit.tsx');
  });

  it('leaves no stylesheet re-stating the lift by hand', () => {
    // `signin.css` is the one legitimate reader outside base.css: it uses
    // `--lift-shadow` as a resting shadow on the sign-in card, which is depth,
    // not a hover response. Nothing anywhere else may name `--lift-rise`.
    const offenders = FILES.filter((f) => rel(f) !== 'styles/base.css')
      .filter((f) => readFileSync(f, 'utf8').includes('var(--lift-rise)'))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('leaves no adopter carrying a reduced-motion guard of its own', () => {
    // Per-file guards are how the admin ended up honouring the preference in 8
    // of 79 stylesheets. For the lift the properties are neutralised once, at
    // the root in base.css, so the stylesheet behind a card that lifts has no
    // business naming the media query, whichever sheet the scan says that is
    // this week. (Sheets with animations of their OWN may still guard them;
    // this rule is scoped to the lift's adopters, where the guard is always a
    // re-statement of what the root already does.)
    expect(adopterSheets.length).toBeGreaterThan(0);
    for (const sheet of adopterSheets) {
      expect(
        readFileSync(sheet, 'utf8'),
        `${rel(sheet)} still guards reduced motion itself`,
      ).not.toContain('prefers-reduced-motion');
    }
  });

  it('never puts the class on a card that is not clickable', () => {
    // A card that rises under the pointer is the loudest claim that clicking it
    // does something. Every `--static` variant renders a plain div with no
    // handler (Schedule's BusyRow too: `booking_time_slots` overlays have no
    // detail to open and firestore.rules denies every client write to them).
    // Withholding the class is the whole mechanism; there is nothing to cancel.
    // Checked over EVERY tsx file, not just today's wearers: an element whose
    // class list carries both a `--static` variant and `lift` is an offender
    // wherever it appears.
    const offenders: string[] = [];
    for (const f of TSX_FILES) {
      for (const tokens of classTokenLines(f)) {
        if (tokens.includes('lift') && tokens.some((t) => t.endsWith('--static'))) {
          offenders.push(`${rel(f)} lifts a static row`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets a card choose its own hover border without a specificity fight', () => {
    // The default is the `var()` fallback, not a declaration on `.lift`, so a
    // card that sets `--lift-border-color` wins outright rather than tying with
    // base.css and being decided by bundler emit order. That tie is not
    // hypothetical: `.signin__card` lost exactly that fight against
    // `.glass-surface` earlier on this branch.
    expect(base).toMatch(/border-color:\s*var\(--lift-border-color,\s*var\(--color-primary\)\)/);
    expect(base).not.toMatch(/\.lift\s*\{[^}]*--lift-border-color:/);
    // The stat card follows its tone; a panel is a container and firms up to
    // the ordinary border rather than lighting up brand orange.
    const kit = readFileSync(join(srcDir, 'components', 'DenScreenKit.css'), 'utf8');
    expect(kit).toMatch(/\.den-stat--button\s*\{[^}]*--lift-border-color:\s*var\(--den-tone\)/);
    expect(kit).toMatch(/\.den-panel\s*\{[^}]*--lift-border-color:\s*var\(--color-border\)/);
  });

  it('keeps the lift values out of tokens.css on purpose', () => {
    // tokens.css is a file-by-file port of the Compose theme and its header says
    // so. There is no lift in AuntieColors.kt / AuntieShapes.kt / anywhere else
    // in that source to port, so these are utility values, not system roles.
    // This pins the decision so a later tidy-up does not quietly move them.
    const tokens = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');
    expect(tokens).not.toContain('--lift-');
    for (const prop of ['--lift-rise', '--lift-shadow', '--lift-transition']) {
      expect(base, `${prop} left base.css`).toContain(`${prop}:`);
    }
  });
});
