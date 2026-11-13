import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #1918 / #1933: jsdom loads no stylesheet, so layout cannot be measured; these
// pin the two rules that fixed the wizard's step row.
const css = readFileSync(resolve(__dirname, 'booking.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string, from = 0) => {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`);
  return re.exec(css.slice(from))?.[2] ?? '';
};
const phoneBlock = () => {
  const at = css.indexOf('@media (max-width: 880px)');
  expect(at).toBeGreaterThan(-1);
  return css.slice(at);
};

describe('booking wizard stepper layout', () => {
  it('clears the sticky top bar when scrolled into view (#1918)', () => {
    expect(rule('.stepper')).toMatch(/scroll-margin-top:\s*calc\(var\(--nav-h\)\s*\+\s*12px\)/);
  });
  it('lets the five steps share the width on a phone, with no sideways scroll (#1933)', () => {
    const phone = phoneBlock();
    expect(rule('.step', css.indexOf('@media (max-width: 880px)'))).toMatch(/flex:\s*1 1 0/);
    expect(phone).toMatch(/\.step \.dot\s*\{[^}]*min-width:\s*0/);
    expect(phone).toMatch(/\.stepper\s*\{[^}]*overflow-x:\s*visible/);
  });
});
