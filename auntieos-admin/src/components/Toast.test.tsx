// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, type ToastOptions } from './Toast';

/**
 * The rule this file exists to hold: a toast confirms, it never reports a
 * failure. Errors belong in Banner / AsyncRegion, which persist until the
 * operator deals with them. If someone later widens ToastTone to include
 * 'error', the type test below stops compiling and this comment is why.
 */

function Raiser({ message, options }: { message: string; options?: ToastOptions }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message, options)}>
      raise
    </button>
  );
}

function renderWithProvider(ui: React.ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('ToastProvider', () => {
  it('shows a message after it is raised', async () => {
    const user = userEvent.setup();
    renderWithProvider(<Raiser message="KinTale draft saved." />);

    expect(screen.queryByText('KinTale draft saved.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'raise' }));

    expect(screen.getByText('KinTale draft saved.')).toBeInTheDocument();
  });

  it('announces politely via a live region that exists before the message does', () => {
    renderWithProvider(<Raiser message="Saved." />);

    // Present at mount, empty. A live region created at the same moment as its
    // content is not announced by most screen readers.
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
  });

  it('marks each toast role=status, never role=alert', async () => {
    const user = userEvent.setup();
    renderWithProvider(<Raiser message="Saved." />);
    await user.click(screen.getByRole('button', { name: 'raise' }));

    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dismisses on the dismiss button, which names the message', async () => {
    const user = userEvent.setup();
    renderWithProvider(<Raiser message="Tale sent." />);
    await user.click(screen.getByRole('button', { name: 'raise' }));

    await user.click(screen.getByRole('button', { name: 'Dismiss: Tale sent.' }));
    expect(screen.queryByText('Tale sent.')).not.toBeInTheDocument();
  });

  it('ignores a blank message rather than rendering an empty toast', async () => {
    const user = userEvent.setup();
    renderWithProvider(<Raiser message="   " />);
    await user.click(screen.getByRole('button', { name: 'raise' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps only the newest few, so the stack cannot bury the screen', async () => {
    const user = userEvent.setup();
    renderWithProvider(<Raiser message="Saved." />);
    const raise = screen.getByRole('button', { name: 'raise' });

    for (let i = 0; i < 5; i++) await user.click(raise);

    expect(screen.getAllByRole('status')).toHaveLength(3);
  });

  it('throws when used outside the provider instead of silently doing nothing', () => {
    // A swallowed confirmation is indistinguishable from a save that never ran.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Raiser message="Saved." />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});

// fireEvent, not userEvent, in this block on purpose: userEvent's async
// internals stall under fake timers even when handed advanceTimers, so the test
// times out instead of testing anything. fireEvent is synchronous and has no
// such machinery. Everything above uses userEvent, which is the better default.
describe('auto-dismiss', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function raise() {
    fireEvent.click(screen.getByRole('button', { name: 'raise' }));
  }

  it('clears itself after its duration', () => {
    renderWithProvider(<Raiser message="Saved." options={{ durationMs: 1000 }} />);
    raise();

    expect(screen.getByText('Saved.')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1001));
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('holds open while hovered, so it cannot vanish from under the pointer', () => {
    renderWithProvider(<Raiser message="Saved." options={{ durationMs: 1000 }} />);
    raise();

    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByText('Saved.')).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => void vi.advanceTimersByTime(1001));
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });
});

describe('the no-error-tone rule', () => {
  it('accepts the confirmation tones', () => {
    const ok: ToastOptions[] = [{ tone: 'success' }, { tone: 'info' }];
    expect(ok).toHaveLength(2);
  });

  it('does not type-accept an error tone', () => {
    // @ts-expect-error errors are persistent surfaces (Banner / AsyncRegion),
    // never a self-dismissing toast. Removing this rule breaks fail-loud.
    const bad: ToastOptions = { tone: 'error' };
    expect(bad).toBeDefined();
  });
});
