// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWarmOnOpen } from './useWarmOnOpen';
import { warmSave, type WarmableSave } from './warmSave';

/**
 * #1504: the hook fires the warm call once per open of the form holding it.
 * `warmSave` is the suite-wide spy from `test-setup.ts`.
 */

function Form({ name = 'saveMyAccount', enabled = true }: { name?: WarmableSave; enabled?: boolean }) {
  useWarmOnOpen(name, enabled);
  const [draft, setDraft] = useState('');
  return (
    <>
      <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <span>{`draft:${draft}`}</span>
    </>
  );
}

describe('useWarmOnOpen', () => {
  it('fires once when the form opens, not on every render', () => {
    const { rerender } = render(<Form />);
    expect(warmSave).toHaveBeenCalledTimes(1);
    expect(warmSave).toHaveBeenCalledWith('saveMyAccount');
    for (let i = 0; i < 5; i += 1) rerender(<Form />);
    expect(warmSave).toHaveBeenCalledTimes(1);
  });

  it('fires once under StrictMode, whose dev-only remount keeps the same instance', () => {
    render(
      <StrictMode>
        <Form />
      </StrictMode>,
    );
    expect(warmSave).toHaveBeenCalledTimes(1);
  });

  it('typing in the form never fires it again', async () => {
    const { container } = render(<Form />);
    const input = container.querySelector('input')!;
    for (const value of ['a', 'ab', 'abc']) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    expect(screen.getByText('draft:abc')).toBeInTheDocument();
    expect(warmSave).toHaveBeenCalledTimes(1);
  });

  it('waits until enabled, then fires once, and a later flip off and on is the same open', () => {
    const { rerender } = render(<Form enabled={false} />);
    expect(warmSave).not.toHaveBeenCalled();
    rerender(<Form enabled />);
    expect(warmSave).toHaveBeenCalledTimes(1);
    rerender(<Form enabled={false} />);
    rerender(<Form enabled />);
    expect(warmSave).toHaveBeenCalledTimes(1);
  });

  it('closing the form and opening it again is a new open', () => {
    const { unmount } = render(<Form name="createShareLink" />);
    unmount();
    render(<Form name="createShareLink" />);
    expect(vi.mocked(warmSave).mock.calls).toEqual([['createShareLink'], ['createShareLink']]);
  });
});
