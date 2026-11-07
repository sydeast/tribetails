// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * #1563: KinTales > Drafts lists `generated_drafts` rows under namespaced ids
 * (`generated_drafts/<id>`), and this view used to hand every selected id to
 * the report detail, which reads `kin_care_reports` and could only answer "No
 * KinTale found with id generated_drafts/...". These cases pin the routing: a
 * draft goes to Communicate's Personalize by its bare id, a report still opens
 * in the detail.
 *
 * #1594: the detail is an address of its own (`?kinTaleId=` beside the list's
 * `?range=`), and Close lands back on the list in the window it was in.
 *
 * The router hooks and the three screens are stubbed: what is under test is the
 * decision this view makes, and each screen has its own suite.
 */
const { navigate, back, search } = vi.hoisted(() => ({
  navigate: vi.fn(),
  back: vi.fn(),
  search: { current: {} as { kinTaleId?: string; sessionId?: string; range?: string } },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => ({ history: { back } }),
  useSearch: () => search.current,
}));
vi.mock('../screens/KinTales', () => ({
  KinTales: ({
    onSelect,
    initialRange,
    onRangeChange,
  }: {
    onSelect: (id: string) => void;
    initialRange?: string;
    onRangeChange?: (range: string) => void;
  }) => (
    <div>
      <p>list in {initialRange ?? 'the default window'}</p>
      <button type="button" onClick={() => onSelect('generated_drafts/gd1')}>
        draft row
      </button>
      <button type="button" onClick={() => onSelect('tale-42')}>
        report row
      </button>
      <button type="button" onClick={() => onRangeChange?.('30d')}>
        pick 30 days
      </button>
    </div>
  ),
}));
vi.mock('../screens/KinTaleDetail', () => ({
  KinTaleDetail: ({ kinTaleId, onClose }: { kinTaleId: string; onClose: () => void }) => (
    <div>
      <p>detail for {kinTaleId}</p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));
vi.mock('../screens/KinTaleCompose', () => ({ KinTaleCompose: () => <p>compose</p> }));

import { KinTalesView } from './KinTalesView';

beforeEach(() => {
  navigate.mockReset();
  back.mockReset();
  search.current = {};
});

describe('KinTalesView routing (#1563)', () => {
  it('sends a draft row to Communicate with the bare draft id', async () => {
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'draft row' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/communicate', search: { draftId: 'gd1' } });
    expect(screen.queryByText(/detail for/)).toBeNull();
  });

  it('still opens a report row in the detail, never in Communicate', async () => {
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'report row' }));
    expect(screen.getByText('detail for tale-42')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: '/communicate' }));
  });

  it('forwards a draft named in ?kinTaleId= to Communicate instead of a not-found detail', () => {
    search.current = { kinTaleId: 'generated_drafts/gd9' };
    render(<KinTalesView />);
    expect(navigate).toHaveBeenCalledWith({ to: '/communicate', search: { draftId: 'gd9' } });
    expect(screen.queryByText(/detail for/)).toBeNull();
    expect(screen.getByText('Opening the draft…')).toBeInTheDocument();
  });

  it('opens a report named in ?kinTaleId= in the detail, as before', () => {
    search.current = { kinTaleId: 'tale-7' };
    render(<KinTalesView />);
    expect(screen.getByText('detail for tale-7')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('KinTalesView keeps the list window across the detail (#1594)', () => {
  it('writes the window the operator picks into ?range=, replacing the entry', async () => {
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'pick 30 days' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/kintales', search: { range: '30d' }, replace: true });
  });

  it('opens a report at an address of its own, with the window beside it', async () => {
    search.current = { range: '30d' };
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'report row' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/kintales', search: { range: '30d', kinTaleId: 'tale-42' } });
  });

  it('closes a report it opened by stepping back, onto the list in the same window', async () => {
    search.current = { range: '30d' };
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'report row' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.getByText('list in 30d')).toBeInTheDocument();
  });

  it('closes a report opened cold from a link onto the list in the linked window', async () => {
    search.current = { kinTaleId: 'tale-7', range: '90d' };
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/kintales', search: { range: '90d' }, replace: true });
    expect(screen.getByText('list in 90d')).toBeInTheDocument();
  });

  it('follows the browser back to the list when the URL drops ?kinTaleId=', () => {
    search.current = { kinTaleId: 'tale-7', range: '30d' };
    const { rerender } = render(<KinTalesView />);
    expect(screen.getByText('detail for tale-7')).toBeInTheDocument();
    search.current = { range: '30d' };
    rerender(<KinTalesView />);
    expect(screen.getByText('list in 30d')).toBeInTheDocument();
  });
});
