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
 * The router hooks and the three screens are stubbed: what is under test is the
 * decision this view makes, and each screen has its own suite.
 */
const { navigate, search } = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: { current: {} as { kinTaleId?: string; sessionId?: string } },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search.current,
}));
vi.mock('../screens/KinTales', () => ({
  KinTales: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div>
      <button type="button" onClick={() => onSelect('generated_drafts/gd1')}>
        draft row
      </button>
      <button type="button" onClick={() => onSelect('tale-42')}>
        report row
      </button>
    </div>
  ),
}));
vi.mock('../screens/KinTaleDetail', () => ({
  KinTaleDetail: ({ kinTaleId }: { kinTaleId: string }) => <p>detail for {kinTaleId}</p>,
}));
vi.mock('../screens/KinTaleCompose', () => ({ KinTaleCompose: () => <p>compose</p> }));

import { KinTalesView } from './KinTalesView';

beforeEach(() => {
  navigate.mockReset();
  search.current = {};
});

describe('KinTalesView routing (#1563)', () => {
  it('sends a draft row to Communicate with the bare draft id', async () => {
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'draft row' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/communicate', search: { draftId: 'gd1' } });
    expect(screen.queryByText(/detail for/)).toBeNull();
  });

  it('still opens a report row in the detail', async () => {
    render(<KinTalesView />);
    await userEvent.click(screen.getByRole('button', { name: 'report row' }));
    expect(screen.getByText('detail for tale-42')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
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
