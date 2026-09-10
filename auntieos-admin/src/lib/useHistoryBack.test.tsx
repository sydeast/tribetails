// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// A real `useRouter` wants a RouterProvider no suite in this tree mounts
// (AppShell.test.tsx convention), so the router is stood in for by the two
// pieces this hook actually touches: `canGoBack()` and `back()`.
const history = vi.hoisted(() => ({ canGoBack: vi.fn(), back: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history }) }));

import { useHistoryBack } from './useHistoryBack';

function BackButton({ onFallback }: { onFallback: () => void }) {
  const back = useHistoryBack({ fallbackLabel: 'Directory', onFallback });
  return (
    <button type="button" onClick={back.goBack}>
      {back.label}
    </button>
  );
}

beforeEach(() => {
  history.canGoBack.mockReset();
  history.back.mockReset();
});

describe('useHistoryBack', () => {
  it('steps back through router history when the previous entry is in the admin', async () => {
    history.canGoBack.mockReturnValue(true);
    const onFallback = vi.fn();
    render(<BackButton onFallback={onFallback} />);

    // Plain "Back": the destination is wherever the operator came from, and
    // this screen has no business naming it.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(history.back).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('runs the fallback, and says where it goes, on a cold arrival', async () => {
    // A typed URL, a bookmark, or a link followed in from another site: there
    // is no in-app entry behind this one, so stepping back would leave the admin.
    history.canGoBack.mockReturnValue(false);
    const onFallback = vi.fn();
    render(<BackButton onFallback={onFallback} />);

    await userEvent.click(screen.getByRole('button', { name: 'Back to Directory' }));
    expect(onFallback).toHaveBeenCalledOnce();
    expect(history.back).not.toHaveBeenCalled();
  });

  it('asks history again at click time, not just at render time', async () => {
    // Rendered with nothing behind it, then something arrives before the click.
    // The click is the only moment whose answer has to be right.
    history.canGoBack.mockReturnValueOnce(false).mockReturnValue(true);
    const onFallback = vi.fn();
    render(<BackButton onFallback={onFallback} />);

    await userEvent.click(screen.getByRole('button', { name: 'Back to Directory' }));
    expect(history.back).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
  });
});
