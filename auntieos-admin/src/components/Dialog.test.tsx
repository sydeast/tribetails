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
