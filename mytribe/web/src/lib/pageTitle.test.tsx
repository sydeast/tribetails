// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BRAND, formatPageTitle, useRecordTitle, useScreenTitle } from './pageTitle';

/** #2007: the tab names the screen, and the record when one is open. */
describe('formatPageTitle', () => {
  it('ends every title with the brand as the app spells it', () => {
    expect(BRAND).toBe('MyTribe');
    expect(formatPageTitle()).toBe('MyTribe');
    expect(formatPageTitle('Invoices')).toBe('Invoices · MyTribe');
  });
  it('puts the record ahead of the screen', () => {
    expect(formatPageTitle('Biscuit', 'Kin')).toBe('Biscuit · Kin · MyTribe');
  });
  it('drops blank and missing parts', () => {
    expect(formatPageTitle(null, '  ', undefined, 'Directory')).toBe('Directory · MyTribe');
  });
  it('never puts an email in the tab', () => {
    expect(formatPageTitle('catch@hanasamku.com', 'Invites')).toBe('Invites · MyTribe');
  });
  it('says a repeated part once', () => {
    expect(formatPageTitle('Settings', 'Settings')).toBe('Settings · MyTribe');
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
    expect(document.title).toBe('Biscuit · MyTribe');
    view.unmount();
    expect(document.title).toBe('MyTribe');
  });
  it('leaves the tab alone while the name is still loading', () => {
    const view = render(<Record name={null} />);
    expect(document.title).toBe('');
    view.rerender(<Record name="Biscuit" />);
    expect(document.title).toBe('Biscuit · MyTribe');
    view.unmount();
  });
  it('follows the record when one replaces another', () => {
    const view = render(<Record name="Biscuit" />);
    view.rerender(<Record name="Mochi" />);
    expect(document.title).toBe('Mochi · MyTribe');
    view.unmount();
    expect(document.title).toBe('MyTribe');
  });
  it('hands the tab back to the outer record when a nested one closes', () => {
    const outer = render(<Record name="the Halbrooks" />);
    const dialog = render(<Record name="Invoice #12" />);
    expect(document.title).toBe('Invoice #12 · MyTribe');
    dialog.unmount();
    expect(document.title).toBe('the Halbrooks · MyTribe');
    outer.unmount();
    expect(document.title).toBe('MyTribe');
  });
  it('lets a screen with no route name itself', () => {
    const view = render(<Screen name="Page not found" />);
    expect(document.title).toBe('Page not found · MyTribe');
    view.unmount();
  });
});
