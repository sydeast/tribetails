import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the token port against the two ways it can rot.
 *
 * 1. SCHEME DRIFT: a role gets added to one scheme and forgotten in the other,
 *    so it silently inherits the wrong value, or nothing. Nobody notices until
 *    a screen turns up unreadable.
 * 2. BRAND DRIFT: someone "tidies" a hex. These seven constants are the brand;
 *    they are the one thing in here that is not a judgement call. The values are
 *    pinned from AuntieColors.kt, and the mocks agree with it hue for hue: the
 *    kincare-detail mock's `:root` carries the same seven. Which is worth saying
 *    here, because this comment used to call the mockups stale and wrong, and
 *    the 2026-09-11 ruling makes them the design source (issue #751).
 *
 * Deliberately parsing the CSS as text rather than mounting it in jsdom:
 * getComputedStyle resolves var() chains, which would happily report a dark value
 * that had actually fallen back to light. Reading the source shows what is really
 * declared in each block, which is the thing at risk.
 */

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** Custom properties declared inside the selector block containing [marker]. */
function declaredIn(marker: string): Set<string> {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`selector not found in tokens.css: ${marker}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open, close);
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/** Value of [name] inside the block containing [marker], whitespace-collapsed. */
function valueIn(marker: string, name: string): string | null {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`selector not found in tokens.css: ${marker}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open, close);
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1]!.trim().replace(/\s+/g, ' ') : null;
}

/**
 * Value of a token declared exactly once anywhere in the file.
 *
 * Scheme-independent tokens (gradients, type, shape, dims) each live in their own
 * `:root` block, so block-scoped lookup by the marker ':root' would always hit the
 * FIRST such block (brand constants) and report null. Asserting uniqueness rather
 * than taking the first match, so a token accidentally declared twice fails loudly
 * instead of silently resolving to whichever came first.
 */
function valueOf(name: string): string | null {
  const all = [...css.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, 'g'))];
  if (all.length > 1) throw new Error(`${name} declared ${all.length}x; expected once`);
  return all[0] ? all[0][1]!.trim().replace(/\s+/g, ' ') : null;
}

describe('brand constants', () => {
  // Pinned from theme/AuntieColors.kt. If one of these fails, either the brand
  // genuinely changed (update BOTH sides) or someone reformatted a hex by hand.
  it.each([
    ['--tt-kinfolk-orange', '#df8431'],
    ['--tt-pack-pink', '#d55c87'],
    ['--tt-kin-teal', '#0a8595'],
    ['--tt-family-purple', '#74538a'],
    ['--tt-snuggle-coral', '#d5535a'],
    ['--tt-brand-cream', '#fbfbf9'],
    ['--tt-brand-navy', '#11131f'],
  ])('%s is %s', (name, hex) => {
    expect(valueIn(':root {', name)).toBe(hex);
  });
});

describe('light and dark schemes stay in step', () => {
  // The two blocks swapped places on 2026-09-11 (#751). The navy set is the one
  // on bare `:root` now, because the mocks' world is the default and the only
  // scheme the app selects; the cream set is kept behind its opt-in attribute
  // and nothing points at it. They are still held in step, because a role added
  // to one and forgotten in the other is the same bug whichever is default.
  const dark = declaredIn(":root,\n[data-theme='dark']");
  const light = declaredIn("[data-theme='light'] {");

  it('dark defines every role light defines', () => {
    const missing = [...light].filter((k) => !dark.has(k) && k !== 'color-scheme');
    expect(missing, `roles missing from dark: ${missing.join(', ')}`).toEqual([]);
  });

  it('light defines every role dark defines', () => {
    const missing = [...dark].filter((k) => !light.has(k) && k !== 'color-scheme');
    expect(missing, `roles missing from light: ${missing.join(', ')}`).toEqual([]);
  });

  it('covers every colour role the Compose AuntieColors data class carries', () => {
    // The 20 non-derived fields of AuntieColors.kt. A role dropped during the
    // port is invisible until a component reaches for it, so pin the set.
    for (const role of [
      '--color-background',
      '--color-surface',
      '--color-surface-2',
      '--color-surface-glass',
      '--color-border',
      '--color-border-soft',
      '--color-primary',
      '--color-primary-dim',
      '--color-secondary',
      '--color-accent',
      '--color-tertiary',
      '--color-coral',
      '--color-text-primary',
      '--color-text-dim',
      '--color-text-faint',
      '--color-success',
      '--color-warning',
      '--color-error',
      '--color-error-container',
    ]) {
      expect(light.has(role), `light is missing ${role}`).toBe(true);
      expect(dark.has(role), `dark is missing ${role}`).toBe(true);
    }
  });
});

describe('the navy scheme is the default, and a real scheme', () => {
  it('puts the navy set on bare :root, so an unstyled first paint is already right', () => {
    // THE #751 RULING. The cream set sat here until 2026-09-11, so the admin
    // painted cream on a machine that never set `data-theme`, which is every
    // machine: nothing in src/ set it. The navy block must carry the bare
    // `:root` selector, not merely exist.
    expect(css).toContain(":root,\n[data-theme='dark'] {");
    expect(valueIn(":root,\n[data-theme='dark']", '--color-background')).toBe(
      'var(--tt-brand-navy)',
    );
  });

  it('leaves the cream set reachable only by the opt-in attribute', () => {
    // Kept, not deleted: it is the port of LightAuntieColors. Selected by
    // nothing, because a light-mode machine painting the app cream IS the
    // complaint. If `:root` ever appears on this block again, the default
    // silently depends on which of the two blocks the browser reads last.
    expect(css).toContain("[data-theme='light'] {");
    expect(css).not.toContain(":root,\n[data-theme='light']");
    expect(valueIn("[data-theme='light'] {", '--color-background')).toBe('var(--tt-brand-cream)');
  });

  it('carries the mocks panel gradient stops and hairline in both sets', () => {
    // The mocks draw every panel as navy-2 falling to navy-3 at half alpha, and
    // the hero one stop further. Pinned as ROLES so the kit reads them rather
    // than writing the hexes into a component stylesheet.
    expect(valueIn(":root,\n[data-theme='dark']", '--color-panel-top')).toBe('#171a2a');
    expect(valueIn(":root,\n[data-theme='dark']", '--color-panel-bottom')).toBe(
      'rgba(30, 34, 53, 0.5)',
    );
    expect(valueIn(":root,\n[data-theme='dark']", '--color-hero-bottom')).toBe('#1e2235');
    expect(valueIn(":root,\n[data-theme='dark']", '--color-hairline')).toBe(
      'rgba(251, 251, 249, 0.1)',
    );
  });

  it('re-points brand roles at the brightened variants', () => {
    // Dark brightens primary/secondary/accent for contrast on navy. If these
    // ever equal light's, the port collapsed the two schemes.
    expect(valueIn("[data-theme='dark']", '--color-primary')).toBe('#f09446');
    expect(valueIn("[data-theme='light'] {", '--color-primary')).toBe('var(--tt-kinfolk-orange)');
  });

  it('keeps primary-dim on the UNbrightened brand orange', () => {
    // Easy to "fix" this into var(--color-primary) and quietly lose the dim step.
    expect(valueIn("[data-theme='dark']", '--color-primary-dim')).toBe('var(--tt-kinfolk-orange)');
  });

  it('sets color-scheme so form controls and scrollbars follow', () => {
    expect(valueIn("[data-theme='dark']", 'color-scheme')).toBe('dark');
    expect(valueIn("[data-theme='light'] {", 'color-scheme')).toBe('light');
  });

  it('names the hero radius as a step rather than leaving 24px raw in the kit', () => {
    expect(valueOf('--radius-hero')).toBe('24px');
  });
});

describe('the document declares the scheme it paints', () => {
  const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

  it('stamps data-theme on the root element in the shipped HTML', () => {
    // Written into index.html rather than by the app: it has to hold for the
    // first paint, before a module loads, and there is no state to resolve it
    // from. Every scheme-scoped selector in the CSS depends on it.
    expect(html).toMatch(/<html[^>]*\sdata-theme="dark"/);
  });
});

describe('typography carries the effective weights, not the base declarations', () => {
  // THE porting trap. AuntieTypography.kt declares Bold for display/headline,
  // but rememberDenTypography overrides to Normal/Medium when it binds Fraunces.
  // Porting the base alone renders every heading too heavy.
  it('display and headlineLarge are Fraunces 400, not 700', () => {
    expect(valueOf('--type-display-lg-weight')).toBe('400');
    expect(valueOf('--type-display-md-weight')).toBe('400');
    expect(valueOf('--type-headline-lg-weight')).toBe('400');
  });

  it('headlineMedium, headlineSmall and titleLarge are Fraunces 500', () => {
    expect(valueOf('--type-headline-md-weight')).toBe('500');
    expect(valueOf('--type-headline-sm-weight')).toBe('500');
    expect(valueOf('--type-title-lg-weight')).toBe('500');
  });

  it('labelSmall is the MONO kicker face, not Hanken', () => {
    // "THE DEN . HOME". Every other label is Hanken; this one is Spline Mono.
    expect(valueOf('--type-label-sm-family')).toBe('var(--font-mono)');
    expect(valueOf('--type-label-md-family')).toBe('var(--font-hanken)');
  });

  it('titleLarge is Fraunces but titleMedium drops to Hanken', () => {
    // The face changes mid-scale. Off-by-one here and every card title is wrong.
    expect(valueOf('--type-title-lg-family')).toBe('var(--font-fraunces)');
    expect(valueOf('--type-title-md-family')).toBe('var(--font-hanken)');
  });
});

describe('spacing scale', () => {
  // I originally shipped this file with NO spacing scale, having grepped
  // AuntieDimensions.kt with a `head -20` that truncated exactly here. Five
  // porting agents were then told "no spacing scale exists" and each worked
  // around a gap that was never real. The scale is in the source and in
  // auntieos_design_system.md. Pinned so it cannot go missing twice.
  it.each([
    ['--space-1', '4px'],
    ['--space-2', '8px'],
    ['--space-3', '12px'],
    ['--space-4', '16px'],
    ['--space-5', '20px'],
    ['--space-6', '24px'],
    ['--space-8', '32px'],
    ['--space-10', '40px'],
    ['--space-12', '48px'],
  ])('%s is %s', (name, px) => {
    expect(valueOf(name)).toBe(px);
  });

  it('has no space-7, space-9 or space-11, which is the scale and not an omission', () => {
    // Filling these in would invent a scale the source does not have.
    expect(valueOf('--space-7')).toBeNull();
    expect(valueOf('--space-9')).toBeNull();
    expect(valueOf('--space-11')).toBeNull();
  });
});

describe('structural dimensions are not spacing', () => {
  it('keeps the rail, dock and content widths', () => {
    // Density presets scale space-1..space-12 by 0.85/1.0/1.15 and must never
    // touch these. Keeping them in a separate block is the reminder.
    expect(valueOf('--side-rail-width')).toBe('240px');
    expect(valueOf('--bottom-dock-height')).toBe('72px');
    expect(valueOf('--max-content-width')).toBe('1280px');
  });
});

describe('brand gradients', () => {
  it('the Tribe Gradient runs orange to pink to teal', () => {
    const g = valueOf('--gradient-tribe');
    expect(g).toContain('var(--color-primary)');
    expect(g).toContain('var(--color-secondary)');
    expect(g).toContain('var(--color-accent)');
  });

  it('gradients follow theme roles so they brighten in dark automatically', () => {
    // Hardcoding hexes here would leave dark rendering light's gradient.
    for (const g of [
      '--gradient-tribe',
      '--gradient-orange-pink',
      '--gradient-teal-purple',
      '--gradient-rainbow-accent',
      '--gradient-sunset-glow',
    ]) {
      expect(valueOf(g), `${g} should reference role vars`).toContain('var(--color-');
    }
  });

  it('keeps rainbowAccent horizontal, since Gradients.kt builds it differently', () => {
    // Gradients.kt uses linearGradient Offset(0,0)->(1000,1000) for tribe /
    // orangeToPink / tealToPurple, and horizontalGradient for rainbowAccent.
    // Same three stops as Tribe: the ANGLE is the whole difference between the
    // two marks, so rendering it at 135deg would silently make it a duplicate.
    // brandColors.md agrees: Rainbow Accent is the 90deg one.
    expect(valueOf('--gradient-rainbow-accent')).toContain('90deg');
    expect(valueOf('--gradient-tribe')).toContain('135deg');
  });

  it('renders the diagonal brushes at 135deg', () => {
    for (const g of ['--gradient-tribe', '--gradient-orange-pink', '--gradient-teal-purple']) {
      expect(valueOf(g), `${g} is an Offset(0,0)->(1000,1000) diagonal`).toContain('135deg');
    }
  });

  it('keeps Sunset Glow at 135deg per the BRAND doc, not 90deg per the design doc', () => {
    // A real conflict between two docs, pinned so it is not silently "corrected"
    // in either direction by whoever reads only one of them:
    //   brandColors.md            135deg  <- brand source of truth, wins
    //   auntieos_design_system.md  90deg
    // Compose settles nothing: sunsetGlowColors is a color LIST, not a Brush,
    // so it carries no angle at all and feeds the Sunset accent option.
    expect(valueOf('--gradient-sunset-glow')).toContain('135deg');
  });
});
