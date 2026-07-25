import { readdirSync, readFileSync, statSync } from 'node:fs';
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

  it('staggers the three screens the audit called out', () => {
    // Home, Directory and KinTales are the surfaces the 2026-07-25 audit picked
    // as worth the entrance. A screen with no `d*` class hard-cuts into place.
    for (const [screen, steps] of [
      ['screens/Home.tsx', ['d1', 'd2']],
      ['screens/Directory.tsx', ['d1', 'd2']],
      ['screens/KinTales.tsx', ['d1', 'd2', 'd3']],
    ] as const) {
      const src = readFileSync(join(srcDir, screen), 'utf8');
      for (const step of steps) {
        expect(src, `${screen} is missing .${step}`).toMatch(new RegExp(`["' ]${step}["' ]`));
      }
    }
  });

  it('tints the orbs from role tokens so the wash follows the theme', () => {
    const orbs = base.slice(base.indexOf('.orb {'), base.indexOf('@keyframes orb-drift'));
    // `.orb.b` used to name `--color-teal`, which nothing declares, so it took a
    // literal and was the one element on the page that ignored dark mode.
    expect(orbs).toContain('var(--color-tertiary)');
    expect(orbs).toContain('var(--color-primary)');
    expect(orbs).toContain('var(--color-accent)');
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

  it('stays a MARK: two surfaces, and no ordinary screen stylesheet', () => {
    // "Reserved for hero and CTA moments" (tokens.css). A brand gradient on
    // every panel is wallpaper, not a mark. Sign-in carries it twice, the
    // full-bleed wash and the card's cap; the hero stat carries it once.
    expect(uses(signin)).toBe(2);
    expect(uses(kit)).toBe(1);

    const screens = FILES.filter((f) => rel(f).startsWith('screens/'));
    expect(screens.length).toBeGreaterThan(5);
    expect(screens.filter((f) => uses(readFileSync(f, 'utf8')) > 0).map(rel)).toEqual([]);
  });
});

describe('the shared card lift', () => {
  const base = readFileSync(join(stylesDir, 'base.css'), 'utf8');

  /** Every stylesheet whose cards lift. None of them may re-state the lift. */
  const adopters = [
    'components/DenScreenKit.css',
    'screens/Directory.css',
    'screens/KinTales.css',
    'screens/Sessions.css',
    'screens/Invoices.css',
    'screens/Bookings.css',
    'screens/Schedule.css',
  ] as const;

  /** The markup that wears the class, and the element it goes on. */
  const wearers = [
    ['components/DenScreenKit.tsx', 'den-stat--button lift'],
    ['screens/Directory.tsx', 'directory__card lift'],
    ['screens/KinTales.tsx', 'kintales__row-main lift'],
    ['screens/Sessions.tsx', 'sessions__row-main lift'],
    ['screens/Invoices.tsx', 'invoices__row-main lift'],
    ['screens/Bookings.tsx', 'bookings__row-main lift'],
    ['screens/Schedule.tsx', 'schedule__row-main lift'],
  ] as const;

  const read = (f: string) => readFileSync(join(srcDir, ...f.split('/')), 'utf8');

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
    // which is most of what the utility was for. The class is now on the
    // element, so `.lift:hover` is the only rule in the app that lifts anything.
    for (const [file, className] of wearers) {
      expect(read(file), `${file} does not wear the lift`).toContain(className);
    }
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
    // of 79 stylesheets. The properties are neutralised once, at the root.
    for (const file of adopters) {
      expect(read(file), `${file} still guards reduced motion itself`).not.toContain(
        'prefers-reduced-motion',
      );
    }
  });

  it('never puts the class on a card that is not clickable', () => {
    // A card that rises under the pointer is the loudest claim that clicking it
    // does something. Every `--static` variant renders a plain div with no
    // handler (Schedule's BusyRow too: `booking_time_slots` overlays have no
    // detail to open and firestore.rules denies every client write to them).
    // Withholding the class is the whole mechanism; there is nothing to cancel.
    for (const [file] of wearers) {
      const statics = read(file)
        .split('\n')
        .filter((line) => line.includes('--static'));
      expect(statics.filter((line) => /\blift\b/.test(line)), `${file} lifts a static row`).toEqual(
        [],
      );
    }
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
