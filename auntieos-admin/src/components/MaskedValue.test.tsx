// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaskedValue } from './MaskedValue';

describe('MaskedValue', () => {
  it('hides the value by default (the secret is not in the DOM at all)', () => {
    const { container } = render(<MaskedValue value="4417" field="gate code" />);
    expect(screen.queryByText('4417')).toBeNull();
    expect(container.textContent).not.toContain('4417');
  });

  it('reveals on click, then hides again on the second click', async () => {
    render(<MaskedValue value="4417" field="gate code" />);
    await userEvent.click(screen.getByRole('button', { name: /show gate code/i }));
    expect(screen.getByText('4417')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /hide gate code/i }));
    expect(screen.queryByText('4417')).toBeNull();
  });

  it('names the field in the toggle, and flips the name and aria-expanded on reveal', async () => {
    render(<MaskedValue value="hunter2" field="wi-fi password" />);
    const toggle = screen.getByRole('button', { name: 'Show wi-fi password' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide wi-fi password' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('is keyboard operable (tab to the toggle, Enter reveals)', async () => {
    render(<MaskedValue value="4417" field="gate code" />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /show gate code/i })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('4417')).toBeInTheDocument();
  });

  it('masks with a FIXED width, so the mask never leaks the secret length', () => {
    const short = render(<MaskedValue value="12" field="gate code" />);
    const shortMask = short.container.querySelector('.masked-value__mask')?.textContent ?? '';
    const long = render(<MaskedValue value="a-very-long-passphrase-indeed" field="wi-fi password" />);
    const longMask = long.container.querySelector('.masked-value__mask')?.textContent ?? '';

    expect(shortMask).not.toBe('');
    expect(shortMask).toBe(longMask);
    expect(shortMask).not.toBe('12');
    expect(shortMask.length).not.toBe('12'.length);
    expect(longMask.length).not.toBe('a-very-long-passphrase-indeed'.length);
  });

  it('renders the "Not set" treatment with no toggle for a blank value', () => {
    render(<MaskedValue value="   " field="gate code" />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('points the toggle at the value it controls', () => {
    const { container } = render(<MaskedValue value="4417" field="gate code" />);
    const toggle = screen.getByRole('button', { name: /show gate code/i });
    const controls = toggle.getAttribute('aria-controls') ?? '';
    expect(controls).not.toBe('');
    expect(container.querySelector(`#${CSS.escape(controls)}`)).not.toBeNull();
  });
});
