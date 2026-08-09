// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('is a labelled modal with a title', () => {
    render(
      <Dialog title="Delete schema?" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg).toHaveAccessibleName('Delete schema?');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="t" onClose={onClose}>
        <p>b</p>
      </Dialog>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on backdrop click but not on panel click', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog title="t" onClose={onClose}>
        <button>inside</button>
      </Dialog>,
    );
    await userEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector('.dialog__backdrop')!;
    await userEvent.pointer({ target: backdrop, keys: '[MouseLeft]' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has a close button', async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="t" onClose={onClose}>
        <p>b</p>
      </Dialog>,
    );
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
/**
 * The `size` modifier. Nothing else pins it: the template editor modal is in no
 * visual golden, and an e2e would pass just as happily with the two columns
 * stacked, so without this the class could be dropped and every test stay green.
 */
describe('Dialog size', () => {
  it('is the standard 30rem column by default', () => {
    render(
      <Dialog title="Standard" onClose={vi.fn()}>
        body
      </Dialog>,
    );
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveClass('dialog');
    expect(panel).not.toHaveClass('dialog--wide');
  });
  it('carries the wide modifier when asked, for a modal with a second column', () => {
    render(
      <Dialog title="Wide" onClose={vi.fn()} size="wide">
        body
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toHaveClass('dialog--wide');
  });
  it('leaves the sheet variant alone: it takes its width from the trailing edge', () => {
    render(
      <Dialog title="Sheet" onClose={vi.fn()} variant="sheet" size="wide">
        body
      </Dialog>,
    );
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveClass('dialog--sheet');
    expect(panel).not.toHaveClass('dialog--wide');
  });
});
