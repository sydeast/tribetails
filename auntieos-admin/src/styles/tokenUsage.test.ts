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

describe('the background orbs are themed', () => {
  const base = readFileSync(join(stylesDir, 'base.css'), 'utf8');
  it('tints both orbs from role tokens, and from DIFFERENT ones', () => {
    // `.orb.b` named `--color-teal`, which nothing declares, so it took a
    // literal and was the one element on the page that ignored dark mode.
    const orbs = base.slice(base.indexOf('.orb {'));
    expect(orbs).toContain('var(--color-tertiary)');
    expect(orbs).toContain('var(--color-accent)');
    expect(orbs).not.toContain('--color-teal');
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


describe('the Den screen entrance', () => {
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
});
