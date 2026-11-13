// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BRAND, formatPageTitle, useRecordTitle, useScreenTitle } from './pageTitle';

/** #2007: the tab names the screen, and the record when one is open. */
describe('formatPageTitle', () => {
  it('ends every title with the brand as the app spells it', () => {
    expect(BRAND).toBe('AuntieOS');
    expect(formatPageTitle()).toBe('AuntieOS');
    expect(formatPageTitle('Invoices')).toBe('Invoices · AuntieOS');
  });
  it('puts the record ahead of the screen', () => {
    expect(formatPageTitle('Biscuit', 'Auntie Time')).toBe('Biscuit · Auntie Time · AuntieOS');
  });
  it('drops blank and missing parts', () => {
    expect(formatPageTitle(null, '  ', undefined, 'Directory')).toBe('Directory · AuntieOS');
  });
  it('never puts an email in the tab', () => {
    expect(formatPageTitle('catch@hanasamku.com', 'Invites')).toBe('Invites · AuntieOS');
  });
  it('says a repeated part once', () => {
    expect(formatPageTitle('Settings', 'Settings')).toBe('Settings · AuntieOS');
  });
});

function Record({ name }: { name: string | null }) {
  useRecordTitle(name);
  return null;
}
function Screen({ name }: { name: string }) {
  useScreenTitle(name);
  return null;
}

describe('useRecordTitle / useScreenTitle', () => {
  beforeEach(() => {
    document.title = '';
  });
  it('names the record while it is mounted and lets go when it unmounts', () => {
    const view = render(<Record name="Biscuit" />);
    expect(document.title).toBe('Biscuit · AuntieOS');
    view.unmount();
    expect(document.title).toBe('AuntieOS');
  });
  it('leaves the tab alone while the name is still loading', () => {
    const view = render(<Record name={null} />);
    expect(document.title).toBe('');
    view.rerender(<Record name="Biscuit" />);
    expect(document.title).toBe('Biscuit · AuntieOS');
    view.unmount();
  });
  it('follows the record when one replaces another', () => {
    const view = render(<Record name="Biscuit" />);
    view.rerender(<Record name="Mochi" />);
    expect(document.title).toBe('Mochi · AuntieOS');
    view.unmount();
    expect(document.title).toBe('AuntieOS');
  });
  it('hands the tab back to the outer record when a nested one closes', () => {
    const outer = render(<Record name="the Halbrooks" />);
    const dialog = render(<Record name="Invoice #12" />);
    expect(document.title).toBe('Invoice #12 · AuntieOS');
    dialog.unmount();
    expect(document.title).toBe('the Halbrooks · AuntieOS');
    outer.unmount();
    expect(document.title).toBe('AuntieOS');
  });
  it('lets a screen with no route name itself', () => {
    const view = render(<Screen name="Page not found" />);
    expect(document.title).toBe('Page not found · AuntieOS');
    view.unmount();
  });
});
